/**
 * Workflow UI Panel (V3: FR-V3-1)
 * Allows users to list, create, edit, and run saved workflows.
 */

import { MSG } from '../shared/constants'
import type { SavedWorkflow, SavedWorkflowStep } from '../shared/types'

export function createWorkflowPanel(): HTMLElement {
  const panel = document.createElement('div')
  panel.className = 'workflow-panel'
  panel.innerHTML = `
    <div class="workflow-panel-header">
      <span class="workflow-panel-title">Saved Workflows</span>
      <button class="btn-small btn-primary btn-workflow-new" title="Create new workflow">+ New</button>
      <button class="workflow-panel-close" title="Close">&times;</button>
    </div>
    <div class="workflow-list"></div>
  `

  panel.querySelector('.workflow-panel-close')!.addEventListener('click', () => {
    panel.style.display = 'none'
  })

  panel.querySelector('.btn-workflow-new')!.addEventListener('click', () => {
    showWorkflowEditor(panel, undefined)
  })

  return panel
}

export async function refreshWorkflowList(panel: HTMLElement): Promise<void> {
  const listEl = panel.querySelector('.workflow-list')!
  listEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--text-dim)">Loading...</div>'

  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.LOAD_WORKFLOWS, limit: 50 }) as {
      ok?: boolean; workflows?: SavedWorkflow[]
    }
    if (!resp?.ok || !resp.workflows) {
      listEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--text-dim)">No workflows saved.</div>'
      return
    }

    const workflows = resp.workflows
    if (workflows.length === 0) {
      listEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--text-dim)">No workflows saved yet. Create one with the + New button or ask AI to create a workflow.</div>'
      return
    }

    listEl.innerHTML = ''
    for (const wf of workflows) {
      const item = document.createElement('div')
      item.className = 'workflow-item'
      const updated = new Date(wf.updatedAt).toLocaleDateString()
      item.innerHTML = `
        <div class="workflow-item-header">
          <span class="workflow-item-name">${escapeHtml(wf.name)}</span>
          <span class="workflow-item-steps">${wf.steps.length} steps</span>
        </div>
        ${wf.description ? `<div class="workflow-item-desc">${escapeHtml(wf.description)}</div>` : ''}
        <div class="workflow-item-meta">Updated: ${updated} | Mode: ${wf.executionMode}</div>
        <div class="workflow-item-actions">
          <button class="btn-small btn-primary btn-wf-run" data-wf-id="${wf.id}">Run</button>
          <button class="btn-small btn-wf-edit" data-wf-id="${wf.id}">Edit</button>
          <button class="btn-small btn-danger btn-wf-delete" data-wf-id="${wf.id}">Delete</button>
        </div>
      `

      item.querySelector('.btn-wf-run')!.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: MSG.RUN_WORKFLOW, id: wf.id })
      })
      item.querySelector('.btn-wf-edit')!.addEventListener('click', () => {
        showWorkflowEditor(panel, wf)
      })
      item.querySelector('.btn-wf-delete')!.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: MSG.DELETE_WORKFLOW, id: wf.id })
        refreshWorkflowList(panel)
      })

      listEl.appendChild(item)
    }
  } catch {
    listEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--color-error)">Failed to load workflows.</div>'
  }
}

function showWorkflowEditor(panel: HTMLElement, existing?: SavedWorkflow): void {
  const listEl = panel.querySelector('.workflow-list')!
  const isNew = !existing
  const wf: SavedWorkflow = existing ?? {
    id: crypto.randomUUID(),
    name: '',
    description: '',
    steps: [],
    executionMode: 'approve',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  const editorHtml = `
    <div class="workflow-editor">
      <div class="wf-field">
        <label>Name</label>
        <input type="text" class="wf-name-input" value="${escapeHtml(wf.name)}" placeholder="Workflow name" />
      </div>
      <div class="wf-field">
        <label>Description</label>
        <input type="text" class="wf-desc-input" value="${escapeHtml(wf.description ?? '')}" placeholder="Optional description" />
      </div>
      <div class="wf-field">
        <label>Execution Mode</label>
        <select class="wf-mode-select">
          <option value="approve" ${wf.executionMode === 'approve' ? 'selected' : ''}>Approve each step</option>
          <option value="auto_low_risk" ${wf.executionMode === 'auto_low_risk' ? 'selected' : ''}>Auto (low risk)</option>
          <option value="suggest" ${wf.executionMode === 'suggest' ? 'selected' : ''}>Suggest only</option>
          <option value="ask_only" ${wf.executionMode === 'ask_only' ? 'selected' : ''}>Ask only</option>
        </select>
      </div>
      <div class="wf-steps-label">Steps (${wf.steps.length})</div>
      <div class="wf-steps-list"></div>
      <button class="btn-small btn-wf-add-step">+ Add step</button>
      <div class="wf-editor-actions">
        <button class="btn-small btn-primary btn-wf-save">${isNew ? 'Create' : 'Save'}</button>
        <button class="btn-small btn-wf-cancel">Cancel</button>
      </div>
    </div>
  `
  listEl.innerHTML = editorHtml

  const stepsList = listEl.querySelector('.wf-steps-list')! as HTMLElement
  renderStepsList(stepsList, wf.steps)

  listEl.querySelector('.btn-wf-add-step')!.addEventListener('click', () => {
    wf.steps.push({ type: 'extract', params: {} })
    renderStepsList(stepsList as HTMLElement, wf.steps)
  })

  listEl.querySelector('.btn-wf-save')!.addEventListener('click', async () => {
    wf.name = (listEl.querySelector('.wf-name-input') as HTMLInputElement).value.trim()
    wf.description = (listEl.querySelector('.wf-desc-input') as HTMLInputElement).value.trim() || undefined
    wf.executionMode = (listEl.querySelector('.wf-mode-select') as HTMLSelectElement).value as SavedWorkflow['executionMode']
    if (!wf.name) { alert('Name is required'); return }
    wf.updatedAt = Date.now()
    await chrome.runtime.sendMessage({ type: MSG.SAVE_WORKFLOW, workflow: wf })
    refreshWorkflowList(panel)
  })

  listEl.querySelector('.btn-wf-cancel')!.addEventListener('click', () => {
    refreshWorkflowList(panel)
  })
}

function renderStepsList(container: HTMLElement, steps: SavedWorkflowStep[]): void {
  container.innerHTML = ''
  steps.forEach((step, i) => {
    const row = document.createElement('div')
    row.className = 'wf-step-row'
    row.innerHTML = `
      <span class="wf-step-num">${i + 1}.</span>
      <select class="wf-step-type">
        ${['scan', 'extract', 'compare', 'propose_action', 'run_action', 'watch', 'export'].map(t =>
          `<option value="${t}" ${step.type === t ? 'selected' : ''}>${t}</option>`
        ).join('')}
      </select>
      <input type="text" class="wf-step-params" value="${escapeHtml(JSON.stringify(step.params))}" placeholder="Params (JSON)" />
      <button class="btn-wf-step-remove" title="Remove">&times;</button>
    `
    row.querySelector('.wf-step-type')!.addEventListener('change', (e) => {
      step.type = (e.target as HTMLSelectElement).value as SavedWorkflowStep['type']
    })
    row.querySelector('.wf-step-params')!.addEventListener('change', (e) => {
      try { step.params = JSON.parse((e.target as HTMLInputElement).value) } catch { /* keep old */ }
    })
    row.querySelector('.btn-wf-step-remove')!.addEventListener('click', () => {
      steps.splice(i, 1)
      renderStepsList(container, steps)
    })
    container.appendChild(row)
  })
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
