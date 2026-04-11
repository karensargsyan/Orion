/**
 * Clipboard message handlers — extracted from service-worker.ts for modularity.
 */

import { MSG } from '../../shared/constants'
import { registerHandlers } from './msg-router'
import { recordClip, searchClips, getRecentClips, clearClips } from '../clipboard-manager'

export function registerClipboardHandlers(): void {
  registerHandlers({
    [MSG.CLIP_RECORD]: async (msg) => {
      const clip = recordClip(msg.text as string, msg.sourceUrl as string || '')
      return { ok: true, clip }
    },
    [MSG.CLIP_SEARCH]: async (msg) => {
      const clips = searchClips(msg.query as string, msg.limit as number | undefined)
      return { ok: true, clips }
    },
    [MSG.CLIP_RECENT]: async (msg) => {
      const clips = getRecentClips(msg.limit as number | undefined)
      return { ok: true, clips }
    },
    [MSG.CLIP_CLEAR]: async () => {
      clearClips()
      return { ok: true }
    },
  })
}
