import type { PIIMatch, PIIType } from '../shared/types'
import { addGlobalMemory } from './memory-manager'

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g
const PHONE_RE = /(?:\+?\d{1,3}[\s\-.]?)?\(?\d{2,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{2,4}\b/g
const CARD_RE = /\b(?:\d{4}[\s\-]?){3}\d{1,4}\b/g
const NAME_KEYWORDS = /\b(?:name|call me|i am|i'm|my name)\b/i

function luhnCheck(num: string): boolean {
  const digits = num.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10)
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

function maskCard(num: string): string {
  const digits = num.replace(/\D/g, '')
  return `****${digits.slice(-4)}`
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  return `${local[0]}***@${domain}`
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `***${digits.slice(-4)}`
}

export function detectPersonalData(text: string): PIIMatch[] {
  const matches: PIIMatch[] = []
  const seen = new Set<string>()

  for (const m of text.matchAll(EMAIL_RE)) {
    if (seen.has(m[0])) continue
    seen.add(m[0])
    matches.push({ type: 'email', value: m[0], masked: maskEmail(m[0]) })
  }

  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) continue
    if (seen.has(digits)) continue
    seen.add(digits)
    matches.push({ type: 'phone', value: m[0].trim(), masked: maskPhone(m[0]) })
  }

  for (const m of text.matchAll(CARD_RE)) {
    const digits = m[0].replace(/\D/g, '')
    if (!luhnCheck(digits)) continue
    if (seen.has(digits)) continue
    seen.add(digits)
    matches.push({ type: 'card', value: maskCard(m[0]), masked: maskCard(m[0]) })
  }

  if (NAME_KEYWORDS.test(text)) {
    const nameMatch = text.match(/(?:name\s+is|call\s+me|i\s+am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i)
    if (nameMatch && nameMatch[1]) {
      matches.push({ type: 'name', value: nameMatch[1].trim(), masked: nameMatch[1].trim() })
    }
  }

  return matches
}

export async function storeDetectedPII(matches: PIIMatch[], source: string): Promise<void> {
  for (const match of matches) {
    await addGlobalMemory({
      domain: 'personal_data',
      summary: `${match.type}: ${match.type === 'card' ? match.masked : match.value}`,
      tags: [`pii:${match.type}`, `source:${source}`],
      importance: match.type === 'card' ? 9 : match.type === 'email' ? 7 : 5,
      timestamp: Date.now(),
      sourceCount: 1,
    })
  }
}
