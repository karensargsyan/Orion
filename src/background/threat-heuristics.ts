/**
 * Heuristic page threat scoring (no network). Used for tab safety border.
 * Content may be misleading, malicious, or phishing — never treat score as proof.
 */

export type ThreatLevel = 'safe' | 'warn' | 'danger'

export interface ThreatAssessment {
  level: ThreatLevel
  score: number
  reasons: string[]
}

const PHISHING_PHRASES = [
  'verify your account', 'verify immediately', 'account suspended', 'unusual activity',
  'confirm your password', 'click here to verify', 'act now', 'expires in 24 hours',
  'your payment failed', 'update your payment', 'social security number',
  'wire transfer', 'gift card', 'send bitcoin',
]

const SUSPICIOUS_TLDS = /\.(tk|ml|ga|cf|gq|xyz|top|click|download|stream)\b/i

export function assessPageThreat(
  url: string,
  pageText: string,
  visibleText: string,
  completeText: string
): ThreatAssessment {
  const reasons: string[] = []
  let score = 0

  let hostname = ''
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch { /* ignore */ }

  const combined = `${pageText}\n${visibleText}\n${completeText}`.toLowerCase()
  const lcUrl = url.toLowerCase()

  if (lcUrl.startsWith('http://') && !hostname.includes('localhost') && !hostname.startsWith('127.')) {
    score += 18
    reasons.push('Page loaded over HTTP (not encrypted)')
  }

  if (SUSPICIOUS_TLDS.test(hostname)) {
    score += 22
    reasons.push('Unusual or high-risk domain TLD')
  }

  for (const phrase of PHISHING_PHRASES) {
    if (combined.includes(phrase)) {
      score += 12
      reasons.push(`Contains common phishing phrase pattern`)
      break
    }
  }

  const passwordFields = (combined.match(/type=["']password["']/g) ?? []).length
    + (pageText.toLowerCase().includes('password') && pageText.toLowerCase().includes('input') ? 1 : 0)
  if (passwordFields > 0 && lcUrl.startsWith('http://')) {
    score += 15
    reasons.push('Password-related content on non-HTTPS page')
  }

  if ((combined.match(/https?:\/\//g) ?? []).length > 25) {
    score += 10
    reasons.push('Many external URLs on one page')
  }

  if (/[а-яё]{5,}/i.test(pageText.slice(0, 2000)) && /paypal|amazon|microsoft|google|apple|netflix/i.test(combined)) {
    score += 12
    reasons.push('Cyrillic mixed with major brand names (possible spoofing)')
  }

  if (score >= 20 && /login|sign in|bank|wallet|crypto/i.test(combined) && !lcUrl.startsWith('https://')) {
    score += 8
    reasons.push('Sensitive keywords without HTTPS')
  }

  if (hostname.endsWith('.gov') || hostname.endsWith('.edu') || hostname === 'localhost') {
    score = Math.max(0, score - 15)
  }

  score = Math.min(100, score)

  let level: ThreatLevel = 'safe'
  if (score >= 55) level = 'danger'
  else if (score >= 22) level = 'warn'

  if (reasons.length === 0 && level === 'safe') {
    reasons.push('No strong heuristic signals (content can still be misleading)')
  }

  return { level, score, reasons: reasons.slice(0, 6) }
}
