# Context Menu Smart Actions Submenu

**Slug:** context-menu-smart-actions
**Type:** Feature + Prompt Engineering
**Priority:** P2 (medium — UX improvement, not broken)
**Requested:** 2026-04-12
**Status:** SPECCED

## Summary
The right-click context menu has 5 flat hardcoded items ("Ask Orion", "Explain this", "Research this topic", "Summarize this page", "Fill this form"). There is no submenu, no context-aware smart actions based on what is selected, and no text-editing actions ("Fix my text", "Improve writing", "Make formal"). Users must open the sidepanel and type their intent manually for anything beyond these 5 options.

## Current Behavior
**File:** `src/background/service-worker.ts` — `setupContextMenus()` (lines 246–295)

5 flat items registered via `chrome.contextMenus.create()`:
- `orion-ask` — "Ask Orion about this" (selection) → sends `'What is this: "${selectedText}"'`
- `orion-explain` — "Explain this" (selection) → sends `'Explain this in simple terms: "${selectedText}"'`
- `orion-research` — "Research this topic" (selection) → sends `'Research this topic thoroughly: ${selectedText}'`
- `orion-summarize` — "Summarize this page" (page) → sends `'Summarize this page'`
- `orion-fill` — "Fill this form with Orion" (page, editable) → sends form assist trigger

No submenu structure. Selected text is concatenated into hardcoded templates.

## Desired Behavior
A two-level menu with context-sensitive submenus:

**When text is selected:**
```
Orion ▶
  ── Text Actions ──
  ✏️  Fix grammar & spelling
  ✨  Improve writing
  🎯  Make it formal
  💬  Make it casual
  📝  Summarize this
  🌍  Translate to English
  ── Ask & Research ──
  ❓  Explain this
  🔍  Research this topic
  💬  Ask Orion...
```

**When in an editable field (no selection):**
```
Orion ▶
  📋  Fill this form
  ✏️  Fix my text
  ✨  Improve what I typed
```

**Always available (page context):**
```
Orion ▶
  📄  Summarize this page
  💬  Ask Orion...
```

## Technical Analysis

**Files to modify:**
- `src/background/service-worker.ts` — `setupContextMenus()` and `onClicked` handler

**How Chrome submenus work:**
```typescript
// Parent item (always visible, no action itself)
chrome.contextMenus.create({ id: 'orion-parent', title: 'Orion', contexts: ['all'] })

// Child item (specify parentId)
chrome.contextMenus.create({ id: 'orion-fix', title: '✏️ Fix grammar & spelling', contexts: ['selection'], parentId: 'orion-parent' })
```

**Smart action prompt templates (in `onClicked` handler):**
```typescript
const SMART_ACTION_PROMPTS: Record<string, (text: string) => string> = {
  'orion-fix':       t => `Fix all grammar, spelling, and punctuation errors in this text. Return ONLY the corrected text, no explanation:\n\n${t}`,
  'orion-improve':   t => `Improve the clarity and flow of this text while preserving the meaning. Return ONLY the improved text:\n\n${t}`,
  'orion-formal':    t => `Rewrite this text in a professional, formal tone. Return ONLY the rewritten text:\n\n${t}`,
  'orion-casual':    t => `Rewrite this text in a friendly, casual tone. Return ONLY the rewritten text:\n\n${t}`,
  'orion-summarize-sel': t => `Summarize this text in 2-3 sentences:\n\n${t}`,
  'orion-translate': t => `Translate this text to English. If it's already English, translate to Spanish. Return ONLY the translation:\n\n${t}`,
  'orion-explain':   t => `Explain this in simple terms:\n\n${t}`,
  'orion-research':  t => `Research this topic thoroughly: ${t}`,
  'orion-ask':       t => `What is this: "${t}"`,
  'orion-fill':      _ => 'Analyze and help me fill the form on this page',
  'orion-fix-field': t => `Fix any errors in this text and improve it:\n\n${t}`,
  'orion-improve-field': t => `Improve what I typed here:\n\n${t}`,
  'orion-summarize-page': _ => 'Summarize this page',
}
```

**New `setupContextMenus()` structure:**
```typescript
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    // Parent
    chrome.contextMenus.create({ id: 'orion', title: 'Orion', contexts: ['all'] })

    // Text selection submenu
    chrome.contextMenus.create({ id: 'orion-sep1', type: 'separator', parentId: 'orion', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-fix',       title: '✏️ Fix grammar & spelling', parentId: 'orion', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-improve',   title: '✨ Improve writing',          parentId: 'orion', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-formal',    title: '🎯 Make it formal',           parentId: 'orion', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-casual',    title: '💬 Make it casual',           parentId: 'orion', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-summarize-sel', title: '📝 Summarize selection', parentId: 'orion', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-translate', title: '🌍 Translate',               parentId: 'orion', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-sep2', type: 'separator', parentId: 'orion', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-explain',   title: '❓ Explain this',             parentId: 'orion', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-research',  title: '🔍 Research this topic',     parentId: 'orion', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-ask',       title: '💬 Ask Orion...',            parentId: 'orion', contexts: ['selection'] })

    // Editable field submenu
    chrome.contextMenus.create({ id: 'orion-fill',        title: '📋 Fill this form',         parentId: 'orion', contexts: ['editable'] })
    chrome.contextMenus.create({ id: 'orion-fix-field',   title: '✏️ Fix my text',            parentId: 'orion', contexts: ['editable'] })
    chrome.contextMenus.create({ id: 'orion-improve-field', title: '✨ Improve what I typed', parentId: 'orion', contexts: ['editable'] })

    // Page-level
    chrome.contextMenus.create({ id: 'orion-summarize-page', title: '📄 Summarize this page', parentId: 'orion', contexts: ['page'] })
  })
}
```

**`onClicked` handler update:**
```typescript
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab?.id
  if (!tabId) return
  const selectedText = info.selectionText?.trim() ?? ''
  const promptFn = SMART_ACTION_PROMPTS[info.menuItemId as string]
  if (!promptFn) return
  await chrome.sidePanel.open({ tabId })
  const text = promptFn(selectedText)
  const triggerFormAssist = info.menuItemId === 'orion-fill'
  broadcastToPanel({ type: 'CONTEXT_MENU_CHAT', text, tabId, triggerFormAssist })
})
```

**No new permissions needed** — `contextMenus` is already declared in manifest.json.

## Acceptance Criteria
- [ ] AC1: Right-clicking selected text shows "Orion ▶" with a submenu containing at least Fix, Improve, Formal, Casual, Summarize, Translate, Explain, Research, Ask
- [ ] AC2: "Fix grammar & spelling" sends the selected text to AI with the fix prompt template and opens the sidepanel
- [ ] AC3: Right-clicking an editable field (no selection) shows Fill, Fix my text, Improve options
- [ ] AC4: Right-clicking anywhere on a page (no selection, non-editable) shows Summarize and Ask Orion
- [ ] AC5: All 5 original menu items are replaced — no duplicate actions visible
- [ ] AC6: The parent "Orion" item appears on all contexts (page, selection, editable)
- [ ] AC7: Clicking any action opens the sidepanel and sends the pre-filled message

## Test Scenarios
- Select "teh quick brown fox" → right-click → "Fix grammar" → sidepanel opens with "Fix all grammar..." prompt containing the selected text
- Right-click in a textarea → "Fix my text" → prompt contains the textarea's current value
- Right-click with nothing selected on a page → only "Summarize this page" and "Ask Orion..." appear in submenu

## Files to Modify
- `src/background/service-worker.ts`
  - `setupContextMenus()` — replace 5 flat items with parent + submenu structure
  - `onClicked` handler — replace individual cases with `SMART_ACTION_PROMPTS` map lookup

## Permissions Changes
None — `contextMenus` already in `src/manifest.json`.

## Regression Risk
- All 5 original actions are preserved (renamed/restructured). IDs change from `orion-ask`/`orion-explain`/etc. to new IDs — only risk is if any other code references these IDs by string (search codebase for `'orion-ask'`, `'orion-explain'`, `'orion-research'`, `'orion-summarize'`, `'orion-fill'` to verify no other references).

## Out of Scope
- AI-detected smart actions (e.g., auto-detecting that selected text is code and offering "Debug this")
- Image right-click actions
- Storing user's preferred menu items
