/**
 * Visual Sitemap — builds a per-domain map of visited pages with screenshots,
 * navigation links, and page metadata. Enables the AI to navigate known sites
 * faster using direct URLs instead of clicking through menus.
 *
 * In-memory cache backed by IDB for cross-session persistence.
 */

import { STORE } from '../shared/constants'
import { dbGet, dbPut, dbGetAll } from '../shared/idb'
import type { PageSnapshot, DomainSitemap, SitemapPageEntry } from '../shared/types'

// ─── Configuration ───────────────────────────────────────────────────────────

const MAX_PAGES_PER_DOMAIN = 50
const MAX_DOMAINS = 20
const PERSIST_INTERVAL_MS = 45_000
/** Volatile query params to strip when normalizing paths */
const VOLATILE_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'ref', 'token', 'nonce', 'ts', '_t', 'cache',
  'sessionid', 'sid',
])

// ─── In-memory cache ─────────────────────────────────────────────────────────

const sitemapCache = new Map<string, DomainSitemap>()
const dirtyDomains = new Set<string>()
let persistTimerId: ReturnType<typeof setTimeout> | null = null
const loadedDomains = new Set<string>()

// ─── Path normalization ──────────────────────────────────────────────────────

export function normalizePath(url: string): string {
  try {
    const u = new URL(url)
    // Strip volatile query params
    for (const key of [...u.searchParams.keys()]) {
      if (VOLATILE_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key)
      }
    }
    // Sort remaining params for consistency
    u.searchParams.sort()
    const qs = u.searchParams.toString()
    return u.pathname + (qs ? `?${qs}` : '')
  } catch {
    return '/'
  }
}

function extractDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function isSameOrigin(href: string, pageUrl: string): boolean {
  try {
    const a = new URL(href, pageUrl)
    const b = new URL(pageUrl)
    return a.hostname === b.hostname
  } catch {
    return false
  }
}

// ─── IDB load / persist ─────────────────────────────────────────────────────

async function ensureLoaded(domain: string): Promise<void> {
  if (loadedDomains.has(domain)) return
  try {
    const record = await dbGet<DomainSitemap>(STORE.VISUAL_SITEMAP, domain)
    if (record) {
      sitemapCache.set(domain, record)
    }
  } catch { /* IDB not ready yet */ }
  loadedDomains.add(domain)
}

function schedulePersist(): void {
  if (persistTimerId) return
  persistTimerId = setTimeout(() => {
    persistTimerId = null
    persistDirtySitemaps().catch(() => {})
  }, PERSIST_INTERVAL_MS)
}

export async function persistDirtySitemaps(): Promise<void> {
  const domains = [...dirtyDomains]
  dirtyDomains.clear()
  for (const domain of domains) {
    const sitemap = sitemapCache.get(domain)
    if (!sitemap) continue
    sitemap.lastPersisted = Date.now()
    try {
      await dbPut(STORE.VISUAL_SITEMAP, sitemap)
    } catch { /* IDB write failed */ }
  }
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Record a page visit, updating or creating a sitemap entry.
 * Called after every action execution and on page load.
 */
export async function recordPageVisit(
  domain: string,
  url: string,
  snapshot: PageSnapshot,
  screenshotDataUrl?: string
): Promise<void> {
  if (!domain || !url) return
  // Skip chrome:// and extension pages
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) return

  await ensureLoaded(domain)

  let sitemap = sitemapCache.get(domain)
  if (!sitemap) {
    sitemap = { domain, pages: {}, lastPersisted: 0, lastUpdated: Date.now() }
    sitemapCache.set(domain, sitemap)
  }

  const path = normalizePath(url)
  const existing = sitemap.pages[path]

  // Extract same-domain navigation links
  const navLinks: { href: string; text: string }[] = []
  if (snapshot.links) {
    for (const link of snapshot.links) {
      if (link.href && link.text && isSameOrigin(link.href, url)) {
        // Normalize the href
        try {
          const linkUrl = new URL(link.href, url)
          navLinks.push({
            href: linkUrl.pathname + linkUrl.search,
            text: link.text.slice(0, 60),
          })
        } catch { /* skip invalid */ }
      }
    }
  }

  // Deduplicate nav links by href
  const seenHrefs = new Set<string>()
  const uniqueNavLinks = navLinks.filter(l => {
    if (seenHrefs.has(l.href)) return false
    seenHrefs.add(l.href)
    return true
  }).slice(0, 30) // Max 30 nav links per page

  const entry: SitemapPageEntry = {
    path,
    url,
    title: snapshot.title || existing?.title || '',
    navLinks: uniqueNavLinks.length > 0 ? uniqueNavLinks : (existing?.navLinks ?? []),
    headings: snapshot.headings?.slice(0, 10) || existing?.headings || [],
    screenshotDataUrl: screenshotDataUrl || existing?.screenshotDataUrl,
    lastSeen: Date.now(),
    visitCount: (existing?.visitCount ?? 0) + 1,
  }

  sitemap.pages[path] = entry
  sitemap.lastUpdated = Date.now()

  // Enforce per-domain page limit
  const paths = Object.keys(sitemap.pages)
  if (paths.length > MAX_PAGES_PER_DOMAIN) {
    evictOldestPages(sitemap, paths.length - MAX_PAGES_PER_DOMAIN)
  }

  // Enforce global domain limit
  if (sitemapCache.size > MAX_DOMAINS) {
    evictOldestDomains()
  }

  dirtyDomains.add(domain)
  schedulePersist()
}

/**
 * Get a text representation of the sitemap for injection into the system prompt.
 * Does NOT include screenshots — only text metadata for token efficiency.
 */
export async function getSitemapForPrompt(domain: string): Promise<string> {
  if (!domain) return ''
  await ensureLoaded(domain)

  const sitemap = sitemapCache.get(domain)
  if (!sitemap) return ''

  const pages = Object.values(sitemap.pages)
  if (pages.length === 0) return ''

  // Sort by visit count (most visited first) then by recency
  pages.sort((a, b) => b.visitCount - a.visitCount || b.lastSeen - a.lastSeen)

  const lines: string[] = [`Known pages on ${domain} (${pages.length} pages):`]

  for (const page of pages.slice(0, 30)) {
    const ago = formatTimeAgo(page.lastSeen)
    let line = `- ${page.path} -- "${page.title}" (visited ${page.visitCount}x, ${ago})`

    // Show top navigation links from this page
    if (page.navLinks.length > 0) {
      const topLinks = page.navLinks.slice(0, 5).map(l => l.href).join(', ')
      line += `\n  links to: ${topLinks}`
    }

    lines.push(line)
  }

  return lines.join('\n')
}

/**
 * Get the cached screenshot for a specific page path on a domain.
 * Used when the AI explicitly requests a sitemap screenshot.
 */
export async function getPageScreenshot(domain: string, path: string): Promise<string | undefined> {
  if (!domain) return undefined
  await ensureLoaded(domain)

  const sitemap = sitemapCache.get(domain)
  if (!sitemap) return undefined

  // Try exact match first
  if (sitemap.pages[path]?.screenshotDataUrl) {
    return sitemap.pages[path].screenshotDataUrl
  }

  // Try fuzzy match — find path that starts with or contains the input
  for (const [p, entry] of Object.entries(sitemap.pages)) {
    if (p.includes(path) && entry.screenshotDataUrl) {
      return entry.screenshotDataUrl
    }
  }

  return undefined
}

/**
 * Get the full sitemap for a domain (for debugging or export).
 */
export async function getSitemapForDomain(domain: string): Promise<DomainSitemap | undefined> {
  await ensureLoaded(domain)
  return sitemapCache.get(domain)
}

// ─── Eviction ────────────────────────────────────────────────────────────────

function evictOldestPages(sitemap: DomainSitemap, count: number): void {
  const entries = Object.values(sitemap.pages)
    .sort((a, b) => {
      // Evict least visited first, then oldest
      if (a.visitCount !== b.visitCount) return a.visitCount - b.visitCount
      return a.lastSeen - b.lastSeen
    })

  for (let i = 0; i < count && i < entries.length; i++) {
    delete sitemap.pages[entries[i].path]
  }
}

function evictOldestDomains(): void {
  const domains = [...sitemapCache.entries()]
    .sort(([, a], [, b]) => a.lastUpdated - b.lastUpdated)

  while (sitemapCache.size > MAX_DOMAINS && domains.length > 0) {
    const [domain] = domains.shift()!
    sitemapCache.delete(domain)
    loadedDomains.delete(domain)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
