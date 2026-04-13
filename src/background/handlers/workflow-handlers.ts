/**
 * Workflow message handlers — extracted from service-worker.ts for modularity.
 */

import { MSG } from '../../shared/constants'
import { registerHandlers } from './msg-router'
import {
  createWorkflow, startWorkflow, pauseWorkflow, resumeWorkflow,
  cancelWorkflow, getWorkflowProgress, getAllWorkflows,
} from '../workflow-engine'

export function registerWorkflowHandlers(): void {
  registerHandlers({
    [MSG.WORKFLOW_CREATE]: async (msg) => {
      const wf = createWorkflow(msg.name as string, msg.steps as [])
      return { ok: true, workflow: wf }
    },
    [MSG.WORKFLOW_START]: async (msg) => {
      await startWorkflow(msg.id as string)
      return { ok: true }
    },
    [MSG.WORKFLOW_PAUSE]: async () => {
      pauseWorkflow()
      return { ok: true }
    },
    [MSG.WORKFLOW_RESUME]: async () => {
      await resumeWorkflow()
      return { ok: true }
    },
    [MSG.WORKFLOW_CANCEL]: async () => {
      cancelWorkflow()
      return { ok: true }
    },
    [MSG.WORKFLOW_PROGRESS]: async () => {
      const progress = getWorkflowProgress()
      return { ok: true, progress }
    },
    [MSG.WORKFLOW_LIST]: async (msg) => {
      const workflows = getAllWorkflows(msg.limit as number | undefined)
      return { ok: true, workflows }
    },
  })
}
