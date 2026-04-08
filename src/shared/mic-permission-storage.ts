import { LOCAL_MIC_PERMISSION_KEY, SESSION_MIC_PERMISSION_KEY } from './constants'

const SESSION_RECENT_MS = 24 * 60 * 60 * 1000
const LOCAL_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000

/** Persists mic grant in session (fast) and local (survives browser restart). */
export async function persistMicGrantTimestamp(): Promise<void> {
  const ts = Date.now()
  await Promise.all([
    chrome.storage.session.set({ [SESSION_MIC_PERMISSION_KEY]: ts }).catch(() => {}),
    chrome.storage.local.set({ [LOCAL_MIC_PERMISSION_KEY]: ts }).catch(() => {}),
  ])
}

export async function hasPersistedLocalMicGrant(): Promise<boolean> {
  try {
    const data = await chrome.storage.local.get(LOCAL_MIC_PERMISSION_KEY)
    const ts = data[LOCAL_MIC_PERMISSION_KEY] as number | undefined
    if (typeof ts !== 'number') return false
    return Date.now() - ts < LOCAL_MAX_AGE_MS
  } catch {
    return false
  }
}

async function hasRecentSessionMicGrant(): Promise<boolean> {
  try {
    const data = await chrome.storage.session.get(SESSION_MIC_PERMISSION_KEY)
    const ts = data[SESSION_MIC_PERMISSION_KEY] as number | undefined
    if (typeof ts !== 'number') return false
    return Date.now() - ts < SESSION_RECENT_MS
  } catch {
    return false
  }
}

/** True if we already recorded a grant this session or in persistent storage. */
export async function hasAnyStoredMicGrant(): Promise<boolean> {
  if (await hasPersistedLocalMicGrant()) return true
  return hasRecentSessionMicGrant()
}

/** Clears stored grant markers (e.g. user revoked mic in browser settings). */
export async function clearMicGrantStorage(): Promise<void> {
  await Promise.all([
    chrome.storage.session.remove(SESSION_MIC_PERMISSION_KEY).catch(() => {}),
    chrome.storage.local.remove(LOCAL_MIC_PERMISSION_KEY).catch(() => {}),
  ])
}
