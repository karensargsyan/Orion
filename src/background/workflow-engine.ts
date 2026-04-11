import { registerExtensionTab, unregisterExtensionTab, findExistingExtensionTab } from './web-researcher'

// ─── Multi-Tab Workflow Engine ───────────────────────────────────────────────

export interface WorkflowStep {
  tabId?: number
  url?: string
  description: string
  action: string
  status: 'pending' | 'running' | 'done' | 'error'
  result?: string
}

export interface Workflow {
  id: string
  name: string
  steps: WorkflowStep[]
  currentStep: number
  status: 'pending' | 'running' | 'paused' | 'done' | 'error'
  createdAt: number
}

// ─── Tab tracking ──────────────────────────────────────────────────────────

const workflowTabIds = new Set<number>()

/** Remove a tab from tracking (called from onRemoved listener). */
export function cleanupWorkflowTab(tabId: number): void {
  workflowTabIds.delete(tabId)
}

// ─── Circular buffer ────────────────────────────────────────────────────────

const MAX_HISTORY = 20
const workflows: Workflow[] = []

function pushWorkflow(wf: Workflow): void {
  workflows.push(wf)
  if (workflows.length > MAX_HISTORY) workflows.shift()
}

function findWorkflow(id: string): Workflow | undefined {
  return workflows.find(w => w.id === id)
}

// ─── Active workflow tracking ───────────────────────────────────────────────

let activeId: string | null = null
let paused = false

// ─── Public API ─────────────────────────────────────────────────────────────

export function createWorkflow(
  name: string,
  steps: Omit<WorkflowStep, 'status'>[]
): Workflow {
  const wf: Workflow = {
    id: crypto.randomUUID(),
    name,
    steps: steps.map(s => ({ ...s, status: 'pending' as const })),
    currentStep: 0,
    status: 'pending',
    createdAt: Date.now(),
  }
  pushWorkflow(wf)
  return wf
}

export function getActiveWorkflow(): Workflow | null {
  if (!activeId) return null
  return findWorkflow(activeId) ?? null
}

export async function startWorkflow(id: string): Promise<void> {
  const wf = findWorkflow(id)
  if (!wf) throw new Error(`Workflow ${id} not found`)
  if (wf.status === 'running') throw new Error('Workflow already running')

  activeId = id
  paused = false
  wf.status = 'running'
  wf.currentStep = 0

  await runSteps(wf)
}

export function pauseWorkflow(): void {
  const wf = activeId ? findWorkflow(activeId) : undefined
  if (!wf || wf.status !== 'running') return
  paused = true
  wf.status = 'paused'
}

export async function resumeWorkflow(): Promise<void> {
  const wf = activeId ? findWorkflow(activeId) : undefined
  if (!wf || wf.status !== 'paused') return
  paused = false
  wf.status = 'running'

  await runSteps(wf)
}

export function cancelWorkflow(): void {
  const wf = activeId ? findWorkflow(activeId) : undefined
  if (!wf) return

  // Mark remaining pending steps as error
  for (const step of wf.steps) {
    if (step.status === 'pending' || step.status === 'running') {
      step.status = 'error'
      step.result = 'Cancelled'
    }
  }
  wf.status = 'error'
  closeWorkflowTabs(wf)
  activeId = null
  paused = false
}

export function getWorkflowProgress(): { current: number; total: number; description: string } | null {
  const wf = activeId ? findWorkflow(activeId) : undefined
  if (!wf || (wf.status !== 'running' && wf.status !== 'paused')) return null

  const idx = Math.min(wf.currentStep, wf.steps.length - 1)
  return {
    current: wf.currentStep + 1,
    total: wf.steps.length,
    description: wf.steps[idx].description,
  }
}

export function getAllWorkflows(limit?: number): Workflow[] {
  const sorted = [...workflows].sort((a, b) => b.createdAt - a.createdAt)
  return limit != null ? sorted.slice(0, limit) : sorted
}

// ─── Step execution ─────────────────────────────────────────────────────────

async function runSteps(wf: Workflow): Promise<void> {
  while (wf.currentStep < wf.steps.length) {
    if (paused || wf.status !== 'running') return

    const step = wf.steps[wf.currentStep]
    step.status = 'running'

    try {
      await executeStep(step)
      step.status = 'done'
    } catch (err) {
      step.status = 'error'
      step.result = err instanceof Error ? err.message : String(err)
      wf.status = 'error'
      activeId = null
      return
    }

    wf.currentStep++
  }

  // All steps completed — close tabs we opened
  closeWorkflowTabs(wf)
  wf.status = 'done'
  activeId = null
}

async function executeStep(step: WorkflowStep): Promise<void> {
  // Navigate or create tab if url is specified
  if (step.url) {
    if (step.tabId) {
      // Navigate existing tab
      await chrome.tabs.update(step.tabId, { url: step.url })
    } else {
      // Dedup: check if URL already open in any extension tab (cross-system)
      const existingGlobal = await findExistingExtensionTab(step.url).catch(() => undefined)
      const existingTabId = existingGlobal ?? await findExistingWorkflowTab(step.url)
      if (existingTabId != null) {
        step.tabId = existingTabId
      } else {
        const tab = await chrome.tabs.create({ url: step.url, active: false })
        step.tabId = tab.id
        if (tab.id != null) {
          workflowTabIds.add(tab.id)
          registerExtensionTab(tab.id)
        }
      }
    }
    // Wait for the tab to finish loading
    if (step.tabId != null) {
      await waitForTabLoad(step.tabId)
    }
  }

  // Store the action text for external processing
  step.result = step.action
}

/** Check if a URL is already open in a tracked workflow tab. */
async function findExistingWorkflowTab(url: string): Promise<number | undefined> {
  const targetHref = new URL(url).href
  for (const tabId of workflowTabIds) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.url && new URL(tab.url).href === targetHref) return tabId
    } catch { workflowTabIds.delete(tabId) } // tab was closed
  }
  return undefined
}

/** Close all tabs opened by a workflow. */
function closeWorkflowTabs(wf: Workflow): void {
  for (const step of wf.steps) {
    if (step.tabId != null && workflowTabIds.has(step.tabId)) {
      workflowTabIds.delete(step.tabId)
      unregisterExtensionTab(step.tabId)
      chrome.tabs.remove(step.tabId).catch(() => {}) // already closed
    }
  }
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error(`Tab ${tabId} load timed out`))
    }, 30_000)

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }

    chrome.tabs.onUpdated.addListener(listener)

    // Check if already complete
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }).catch(() => {
      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error(`Tab ${tabId} not found`))
    })
  })
}
