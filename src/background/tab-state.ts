import type { PageSnapshot } from '../shared/types'

const snapshots = new Map<number, PageSnapshot>()
const screenshots = new Map<number, string[]>()
const MAX_SCREENSHOTS_PER_TAB = 2

export const tabState = {
  set(tabId: number, snapshot: PageSnapshot): void {
    snapshots.set(tabId, { ...snapshot, tabId })
  },

  get(tabId: number): PageSnapshot | undefined {
    return snapshots.get(tabId)
  },

  delete(tabId: number): void {
    snapshots.delete(tabId)
    screenshots.delete(tabId)
  },

  getAll(): Map<number, PageSnapshot> {
    return snapshots
  },

  setScreenshot(tabId: number, dataUrl: string): void {
    const existing = screenshots.get(tabId) ?? []
    existing.push(dataUrl)
    if (existing.length > MAX_SCREENSHOTS_PER_TAB) {
      existing.shift()
    }
    screenshots.set(tabId, existing)

    const snap = snapshots.get(tabId)
    if (snap) {
      snap.screenshot = dataUrl
    }
  },

  getLatestScreenshot(tabId: number): string | undefined {
    const list = screenshots.get(tabId)
    return list?.[list.length - 1]
  },

  summarize(tabId: number): string {
    const snap = snapshots.get(tabId)
    if (!snap) return 'No page data available for this tab.'

    const parts: string[] = [
      `URL: ${snap.url}`,
      `Title: ${snap.title}`,
    ]

    if (snap.metaDescription) parts.push(`Description: ${snap.metaDescription}`)
    if (snap.headings.length) parts.push(`Headings: ${snap.headings.slice(0, 5).join(' | ')}`)

    if (snap.forms.length === 0) {
      parts.push('\nForms: None detected.')
    } else {
      parts.push('\nForms:')
      for (const f of snap.forms) {
        parts.push(`  Form[${f.selector}] (${f.method} → ${f.action}):`)
        for (const fi of f.fields) {
          let fieldDesc = `    - ${fi.label || fi.name || fi.selector} (${fi.type})`
          if (fi.value) fieldDesc += ` = "${fi.value.slice(0, 80)}"`
          if (fi.required) fieldDesc += ' [required]'
          if (fi.checked !== undefined) fieldDesc += fi.checked ? ' [checked]' : ' [unchecked]'
          if (fi.options && fi.options.length > 0) {
            const opts = fi.options.slice(0, 20).map(o => {
              const mark = o.selected ? '✓' : ' '
              return `[${mark}] ${o.label}=${o.value}`
            }).join(', ')
            fieldDesc += `\n      Options: ${opts}`
          }
          parts.push(fieldDesc)
        }
      }
    }

    if (snap.buttons.length) {
      parts.push(`\nButtons:`)
      for (const b of snap.buttons.slice(0, 15)) {
        parts.push(`  - "${b.text}" → ${b.selector}`)
      }
    }

    if (snap.links.length) {
      parts.push(`\nLinks (top 15):`)
      for (const l of snap.links.slice(0, 15)) {
        parts.push(`  - "${l.text}" → ${l.href}${l.isNav ? ' [nav]' : ''}`)
      }
    }

    if (snap.visibleText) {
      parts.push(`\nVisible Text (excerpt):\n${snap.visibleText.slice(0, 1500)}`)
    } else if (snap.pageText) {
      parts.push(`\nPage Content (excerpt):\n${snap.pageText.slice(0, 2000)}`)
    }

    if (snap.selectedText) {
      parts.push(`\nUser Selected Text:\n${snap.selectedText}`)
    }

    return parts.join('\n')
  },
}
