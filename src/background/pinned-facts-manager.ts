import type { PinnedFact } from '../shared/types'
import { STORE } from '../shared/constants'
import { dbPut, dbGetAll, dbDelete, dbClear, dbGetAllByIndex } from '../shared/idb'

export async function addPinnedFact(fact: PinnedFact): Promise<void> {
  await dbPut<PinnedFact>(STORE.PINNED_FACTS, fact)
}

export async function getPinnedFacts(): Promise<PinnedFact[]> {
  const all = await dbGetAll<PinnedFact>(STORE.PINNED_FACTS)
  return all.sort((a, b) => b.pinnedAt - a.pinnedAt)
}

export async function getPinnedFactsBySession(sessionId: string): Promise<PinnedFact[]> {
  return dbGetAllByIndex<PinnedFact>(STORE.PINNED_FACTS, 'by_session', sessionId)
}

export async function deletePinnedFact(id: string): Promise<void> {
  await dbDelete(STORE.PINNED_FACTS, id)
}

export async function clearPinnedFacts(): Promise<void> {
  await dbClear(STORE.PINNED_FACTS)
}

export function formatPinnedFactsForPrompt(facts: PinnedFact[]): string {
  if (facts.length === 0) return ''
  const lines = facts.map(f => `- ${f.label}: ${f.value}`)
  return `## PINNED FACTS (user-saved values — reference these when relevant)\n${lines.join('\n')}`
}
