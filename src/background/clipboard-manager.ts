// ─── Smart Clipboard Manager ─────────────────────────────────────────────────
// In-memory circular buffer for clipboard entries with type detection and search.
// No external dependencies, no IDB — pure in-memory storage.

const MAX_ENTRIES = 50
const MAX_TEXT_LENGTH = 5000

// ─── Types ───────────────────────────────────────────────────────────────────

export type DetectedType = 'email' | 'code' | 'address' | 'link' | 'phone' | 'number' | 'general'

export interface ClipEntry {
  id: number
  text: string
  sourceUrl: string
  sourceDomain: string
  detectedType: DetectedType
  timestamp: number
}

// ─── State ───────────────────────────────────────────────────────────────────

const buffer: ClipEntry[] = []
let nextId = 1

// ─── Type Detection ──────────────────────────────────────────────────────────

const PATTERNS: { type: DetectedType; test: (t: string) => boolean }[] = [
  {
    type: 'email',
    test: t => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.trim()),
  },
  {
    type: 'link',
    test: t => /^https?:\/\/\S+$/i.test(t.trim()) || /^www\.\S+$/i.test(t.trim()),
  },
  {
    type: 'phone',
    test: t => /^[\s()+-]*\d[\d\s()+-]{6,18}\d$/.test(t.trim()),
  },
  {
    type: 'number',
    test: t => /^-?\d[\d\s.,]*\d$|^\d$/.test(t.trim()),
  },
  {
    type: 'code',
    test: t =>
      /[{};]/.test(t) &&
      (/\b(function|const|let|var|if|else|return|import|export|class|def|fn)\b/.test(t) ||
        (t.split('\n').length > 1 && /[{}();]/.test(t))),
  },
  {
    type: 'address',
    test: t =>
      /\d+/.test(t) &&
      /\b(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|place|pl|court|ct|highway|hwy|strasse|straße|weg|platz|gasse)\b/i.test(t),
  },
]

function detectType(text: string): DetectedType {
  for (const p of PATTERNS) {
    if (p.test(text)) return p.type
  }
  return 'general'
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Add a clipboard entry with automatic type detection. */
export function recordClip(text: string, sourceUrl: string): ClipEntry {
  const clipped = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text

  const entry: ClipEntry = {
    id: nextId++,
    text: clipped,
    sourceUrl,
    sourceDomain: extractDomain(sourceUrl),
    detectedType: detectType(clipped),
    timestamp: Date.now(),
  }

  if (buffer.length >= MAX_ENTRIES) {
    buffer.shift()
  }
  buffer.push(entry)

  return entry
}

/** Fuzzy search clips by query string. Matches against text, sourceUrl, and sourceDomain. */
export function searchClips(query: string, limit = 10): ClipEntry[] {
  if (!query) return getRecentClips(limit)

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored: { entry: ClipEntry; score: number }[] = []

  for (const entry of buffer) {
    const haystack = `${entry.text} ${entry.sourceUrl} ${entry.sourceDomain}`.toLowerCase()
    let score = 0

    for (const term of terms) {
      if (haystack.includes(term)) {
        score += 1
        // Bonus for exact word boundary match
        if (new RegExp(`\\b${escapeRegex(term)}\\b`).test(haystack)) {
          score += 0.5
        }
      }
    }

    if (score > 0) {
      scored.push({ entry, score })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
    .slice(0, limit)
    .map(s => s.entry)
}

/** Return the most recent clips, newest first. */
export function getRecentClips(limit = 10): ClipEntry[] {
  const start = Math.max(0, buffer.length - limit)
  return buffer.slice(start).reverse()
}

/** Clear all stored clips and reset the id counter. */
export function clearClips(): void {
  buffer.length = 0
  nextId = 1
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
