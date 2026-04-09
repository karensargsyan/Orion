/**
 * MemPalace HTTP client — talks to the local Python bridge for permanent memory.
 *
 * The bridge exposes:
 *   GET  /health       — is the bridge alive + mempalace installed?
 *   POST /search       — semantic search across the palace
 *   POST /store        — store a single memory (drawer) permanently
 *   POST /store-batch  — store multiple memories at once
 */

import type { Settings } from '../shared/types'
import { DEFAULTS } from '../shared/constants'

function base(settings: Settings): string {
  return (settings.mempalaceBridgeUrl?.trim() || DEFAULTS.MEMPALACE_BRIDGE_URL).replace(/\/+$/, '')
}

export function mempalaceEnabled(settings: Settings): boolean {
  return settings.mempalaceBridgeEnabled === true && !!settings.mempalaceBridgeUrl?.trim()
}

// ── Health ──────────────────────────────────────────────────────────────────────

export interface MempalaceHealth {
  ok: boolean
  mempalaceInstalled?: boolean
  palacePath?: string
  error?: string
}

export async function probeMempalaceBridge(url: string): Promise<MempalaceHealth> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(8000) })
    const d = (await res.json()) as Record<string, unknown>
    return {
      ok: res.ok,
      mempalaceInstalled: d.mempalaceInstalled === true,
      palacePath: typeof d.palacePath === 'string' ? d.palacePath : undefined,
      error: typeof d.error === 'string' ? d.error : undefined,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── Search ──────────────────────────────────────────────────────────────────────

export async function searchMempalace(
  settings: Settings,
  query: string,
  options?: { wing?: string; room?: string; limit?: number }
): Promise<string> {
  const url = base(settings)
  try {
    const res = await fetch(`${url}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        wing: options?.wing || settings.mempalaceWing || undefined,
        room: options?.room || undefined,
        limit: options?.limit ?? 8,
      }),
      signal: AbortSignal.timeout(25_000),
    })
    const d = (await res.json()) as { ok?: boolean; results?: string }
    return (d.results ?? '').trim().slice(0, 6000)
  } catch {
    return ''
  }
}

// ── Store single memory ─────────────────────────────────────────────────────────

export interface PalaceMemory {
  wing: string
  room: string
  content: string
  source?: string
  agent?: string
}

export async function storeMempalace(settings: Settings, mem: PalaceMemory): Promise<boolean> {
  const url = base(settings)
  try {
    const res = await fetch(`${url}/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wing: mem.wing,
        room: mem.room,
        content: mem.content,
        source: mem.source ?? 'extension',
        agent: mem.agent ?? 'orion',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const d = (await res.json()) as { ok?: boolean }
    return d.ok === true
  } catch {
    return false
  }
}

// ── Store batch ─────────────────────────────────────────────────────────────────

export async function storeMempalaceBatch(
  settings: Settings,
  entries: PalaceMemory[]
): Promise<number> {
  if (entries.length === 0) return 0
  const url = base(settings)
  try {
    const res = await fetch(`${url}/store-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      signal: AbortSignal.timeout(60_000),
    })
    const d = (await res.json()) as { ok?: boolean; stored?: number }
    return d.stored ?? 0
  } catch {
    return 0
  }
}

// ── Convenience: build query from user text + domain ────────────────────────────

export function buildMempalaceQuery(userText: string, domain: string): string {
  const t = userText.trim().slice(0, 280)
  if (t.length < 2) return `context site:${domain || 'unknown'}`
  return `${t} (site:${domain || 'unknown'})`
}
