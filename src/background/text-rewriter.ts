import { callAI } from './ai-client'
import type { Settings } from '../shared/types'

export type RewriteTone = 'professional' | 'casual' | 'friendly' | 'formal' | 'concise'

const TONE_PROMPTS: Record<RewriteTone, string> = {
  professional: 'Rewrite the text to be professional and polished. Fix grammar and spelling.',
  casual: 'Rewrite the text to be casual and conversational. Keep it natural.',
  friendly: 'Rewrite the text to be warm and friendly. Be approachable.',
  formal: 'Rewrite the text to be formal and business-appropriate. Use proper language.',
  concise: 'Make the text more concise. Remove unnecessary words while keeping the meaning.',
}

export async function rewriteText(
  text: string,
  tone: RewriteTone,
  settings: Settings
): Promise<{ original: string; improved: string }> {
  const prompt = TONE_PROMPTS[tone] ?? TONE_PROMPTS.professional

  const improved = await callAI([
    { role: 'system', content: `${prompt} Return ONLY the rewritten text.` },
    { role: 'user', content: text },
  ], settings, 1024)

  return { original: text, improved: improved || text }
}

export async function checkGrammar(
  text: string,
  settings: Settings
): Promise<{ issues: string[]; corrected: string }> {
  const result = await callAI([
    {
      role: 'system',
      content: 'Check the text for grammar and spelling errors. Return a JSON object with "issues" (array of strings describing each issue) and "corrected" (the fixed text). Return only valid JSON.',
    },
    { role: 'user', content: text },
  ], settings, 1024)

  try {
    const parsed = JSON.parse(result)
    return { issues: parsed.issues ?? [], corrected: parsed.corrected ?? text }
  } catch {
    return { issues: [], corrected: text }
  }
}
