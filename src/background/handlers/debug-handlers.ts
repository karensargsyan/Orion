/**
 * Debug/error message handlers — extracted from service-worker.ts for modularity.
 */

import { MSG } from '../../shared/constants'
import { registerHandlers } from './msg-router'
import { getRecentErrors, getErrorCount, clearErrors, formatDebugInfo } from '../error-logger'

export function registerDebugHandlers(): void {
  registerHandlers({
    [MSG.GET_DEBUG_INFO]: async () => ({
      ok: true,
      errors: getRecentErrors(50),
      errorCount: getErrorCount(),
      debugText: formatDebugInfo(),
    }),
    [MSG.CLEAR_ERRORS]: async () => {
      clearErrors()
      return { ok: true }
    },
  })
}
