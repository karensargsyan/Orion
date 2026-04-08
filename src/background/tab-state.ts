import type { PageSnapshot } from '../shared/types'

const snapshots = new Map<number, PageSnapshot>()
const screenshots = new Map<number, string[]>()
const MAX_SCREENSHOTS_PER_TAB = 5

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
      const regularButtons = snap.buttons.filter(b => b.role !== 'row' && b.role !== 'listitem' && b.role !== 'option' && b.role !== 'interactive' && b.role !== 'gridcell' && b.role !== 'treeitem')
      const interactiveItems = snap.buttons.filter(b => b.role === 'row' || b.role === 'listitem' || b.role === 'option' || b.role === 'interactive' || b.role === 'gridcell' || b.role === 'treeitem')

      if (regularButtons.length) {
        parts.push(`\nButtons:`)
        for (const b of regularButtons.slice(0, 15)) {
          parts.push(`  - "${b.text}" → ${b.selector}`)
        }
      }

      if (interactiveItems.length) {
        parts.push(`\nInteractive Elements (click by text or selector):`)
        for (const b of interactiveItems.slice(0, 10)) {
          parts.push(`  - "${b.text.slice(0, 80)}" → ${b.selector}`)
        }
      }
    }

    if (snap.links.length) {
      parts.push(`\nLinks (top 15):`)
      for (const l of snap.links.slice(0, 15)) {
        parts.push(`  - "${l.text}" → ${l.href}${l.isNav ? ' [nav]' : ''}`)
      }
    }

    if (snap.completePageText) {
      parts.push(`\nFull document text (excerpt, includes off-screen/hidden-in-DOM):\n${snap.completePageText.slice(0, 1400)}`)
    }
    if (snap.visibleText) {
      parts.push(`\nVisible viewport text (excerpt):\n${snap.visibleText.slice(0, 600)}`)
    } else if (snap.pageText) {
      parts.push(`\nMain region text (excerpt):\n${snap.pageText.slice(0, 800)}`)
    }

    if (snap.selectedText) {
      parts.push(`\nUser Selected Text:\n${snap.selectedText}`)
    }

    return parts.join('\n')
  },
}
