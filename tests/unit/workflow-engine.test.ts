import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoist chrome & crypto mocks so they exist BEFORE module-level code in imports runs
// (vi.stubGlobal is NOT hoisted, but vi.hoisted() IS)
vi.hoisted(() => {
  const noop = () => {}
  const resolved = (v: unknown) => () => Promise.resolve(v)
  const event = { addListener: noop, removeListener: noop }

  ;(globalThis as any).chrome = {
    tabs: {
      create: resolved({ id: 1 }),
      update: resolved({}),
      get: resolved({ status: 'complete' }),
      remove: resolved(undefined),
      query: resolved([]),
      onUpdated: event,
      onRemoved: event,
    },
    debugger: { onDetach: event },
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
  }
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => `uuid-${Math.random().toString(36).slice(2, 10)}` },
    writable: true, configurable: true,
  })
})

import { createWorkflow, getAllWorkflows, getWorkflowProgress, cancelWorkflow, pauseWorkflow } from '../../src/background/workflow-engine'

describe('workflow-engine', () => {
  describe('createWorkflow', () => {
    it('should create a workflow with pending status', () => {
      const wf = createWorkflow('Test Flow', [
        { description: 'Step 1', action: 'do-thing' },
        { description: 'Step 2', action: 'do-other' },
      ])

      expect(wf.name).toBe('Test Flow')
      expect(wf.status).toBe('pending')
      expect(wf.steps.length).toBe(2)
      expect(wf.currentStep).toBe(0)
      expect(wf.id).toBeDefined()
      expect(wf.createdAt).toBeGreaterThan(0)
    })

    it('should initialize all steps as pending', () => {
      const wf = createWorkflow('Init Test', [
        { description: 'A', action: 'a' },
        { description: 'B', action: 'b' },
      ])

      for (const step of wf.steps) {
        expect(step.status).toBe('pending')
      }
    })

    it('should enforce circular buffer of 20 workflows', () => {
      for (let i = 0; i < 25; i++) {
        createWorkflow(`wf-${i}`, [{ description: 'd', action: 'a' }])
      }
      const all = getAllWorkflows()
      expect(all.length).toBeLessThanOrEqual(20)
    })
  })

  describe('getAllWorkflows', () => {
    it('should return workflows sorted newest first', () => {
      const wf1 = createWorkflow('First', [{ description: 'a', action: 'a' }])
      // Force a different createdAt so sorting is deterministic
      const wf2 = createWorkflow('Second', [{ description: 'b', action: 'b' }])
      // Manually bump createdAt to guarantee ordering
      ;(wf2 as any).createdAt = wf1.createdAt + 1000

      const all = getAllWorkflows()
      // Second should be before first (newer createdAt)
      const idx1 = all.findIndex(w => w.id === wf1.id)
      const idx2 = all.findIndex(w => w.id === wf2.id)
      expect(idx2).toBeLessThan(idx1)
    })

    it('should respect limit parameter', () => {
      createWorkflow('A', [{ description: 'a', action: 'a' }])
      createWorkflow('B', [{ description: 'b', action: 'b' }])
      createWorkflow('C', [{ description: 'c', action: 'c' }])

      const limited = getAllWorkflows(2)
      expect(limited.length).toBe(2)
    })
  })

  describe('cancelWorkflow', () => {
    it('should not throw when no active workflow', () => {
      expect(() => cancelWorkflow()).not.toThrow()
    })
  })

  describe('pauseWorkflow', () => {
    it('should not throw when no active workflow', () => {
      expect(() => pauseWorkflow()).not.toThrow()
    })
  })

  describe('getWorkflowProgress', () => {
    it('should return null when no active workflow', () => {
      expect(getWorkflowProgress()).toBeNull()
    })
  })
})
