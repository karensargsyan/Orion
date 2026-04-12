# Unified Selector Strategy with Explicit Fallback Sequence

**Slug:** selector-strategy-unified
**Type:** Prompt Engineering
**Priority:** P1 (high — affects 80% of automation tasks)
**Requested:** 2026-04-12
**Status:** SPECCED

## Summary
The selector strategy is split across two inconsistent sections in `buildBand1_ActionFramework` (lines 704–713) and `buildActionReference` (lines 492–499). The model receives vague, duplicated instructions with no explicit fallback sequence: "try a DIFFERENT selector" tells it nothing about *which* selector type to try next or in what order. This causes unnecessary retries, context bloat from READ_PAGE/SCREENSHOT fallbacks, and slower task completion.

## Root Cause Analysis

**Two conflicting sections teach selector strategy:**

**Section 1** — `buildBand1_ActionFramework`, lines 704–713 (`prompt-engine.ts`):
```
## SELECTOR STRATEGY (in order of reliability)
1. Visible text/label: selector="Search flights" — most reliable
2. Placeholder text: selector="Enter your email"
3. Aria-label: selector="Close dialog"
4. CSS selector: selector="input[name=email]" — use when text selectors fail
5. Element ID (after READ_PAGE): {"element_id": 5, "action": "click"} — last resort, IDs go stale

NEVER use prose as a selector: selector="the blue submit button on the right" — this WILL fail.
NEVER guess selectors you haven't seen. Use what's in the page state below.
```

**Section 2** — `buildActionReference`, lines 492–499 (`prompt-engine.ts`):
```
## SELECTOR TIPS
- Use the field's VISIBLE LABEL: selector="Where from?", selector="Passengers"
- Use placeholder text: selector="Search", selector="Enter your email"
- Use button text: selector="Search flights", selector="Submit"
- Use CSS only as last resort: selector="input[name=q]"
- NEVER describe the page — emit the action immediately
- If an action fails, try a DIFFERENT selector (CSS, aria-label, etc.)
```

**Problems:**
1. The numbered list in Section 1 teaches the sequence but the last line of Section 2 ("try a DIFFERENT selector") gives no sequence — it contradicts by listing CSS before aria-label in the examples
2. Neither section gives an explicit "if X fails, THEN try Y" chain with concrete examples
3. No guidance on ambiguous selectors (two elements with same visible text)
4. The duplication wastes ~80 tokens per request and muddies the model's mental model
5. Both sections describe what to use — neither describes how to recover step-by-step when it fails

## Current Prompt Behavior

Model receives (Band 1): ordered list with 5 types, no failure examples.
Model receives (Band 1, via buildActionReference): "try a DIFFERENT selector (CSS, aria-label, etc.)" — vague, slightly reorders the priority.

When a selector fails, the model:
- May retry with a slightly different text variant (still fails)
- May jump straight to CSS instead of trying aria-label first
- May jump to READ_PAGE after 1 failure instead of 3
- Produces inconsistent recovery patterns across requests

## Desired Prompt Behavior

Model receives one authoritative section with an explicit before/after failure chain:
- FIRST attempt: visible text (exact match)
- SECOND attempt (if first fails): placeholder text for inputs OR alternate visible text for buttons
- THIRD attempt: aria-label
- FOURTH attempt: CSS selector (`input[name=x]`, `button.class`, `#id`)
- FIFTH attempt: element ID (only after READ_PAGE)

When a selector fails, the model deterministically moves to the next step in the chain, not randomly.

## Exact Prompt Changes Required

### Change 1: Replace SELECTOR STRATEGY block in `buildBand1_ActionFramework` (lines 704–713)

**Before (lines 704–713):**
```typescript
  parts.push(`
## SELECTOR STRATEGY (in order of reliability)
1. Visible text/label: selector="Search flights" — most reliable
2. Placeholder text: selector="Enter your email"
3. Aria-label: selector="Close dialog"
4. CSS selector: selector="input[name=email]" — use when text selectors fail
5. Element ID (after READ_PAGE): {"element_id": 5, "action": "click"} — last resort, IDs go stale

NEVER use prose as a selector: selector="the blue submit button on the right" — this WILL fail.
NEVER guess selectors you haven't seen. Use what's in the page state below.`)
```

**After:**
```typescript
  parts.push(`
## SELECTOR STRATEGY — TRY IN THIS ORDER

**Step 1 — Visible text (always try first):**
Use the exact visible text of the button, label, or link as it appears on the page.
→ selector="Search flights"  selector="Submit"  selector="Add to Cart"  selector="Where from?"

**Step 2 — Placeholder text (for input fields):**
If Step 1 fails or the element is a text input with no visible label, use its placeholder.
→ selector="Enter your email"  selector="Search"  selector="Type a message"

**Step 3 — Aria-label (for icon buttons, unlabeled elements):**
If Steps 1–2 fail, use the aria-label attribute.
→ selector="Close dialog"  selector="Open menu"  selector="Send message"

**Step 4 — CSS selector (when text/aria fails):**
Only if Steps 1–3 fail. Use the most specific attribute you see in the page source.
→ selector="input[name=email]"  selector="button[type=submit]"  selector=".btn-primary"

**Step 5 — Element ID (only after READ_PAGE):**
Last resort. Call [ACTION:READ_PAGE filter="interactive"] first to get current IDs.
→ {"element_id": 5, "action": "click"}  — IDs go stale on dynamic pages, use sparingly.

**Failure rules:**
- If a selector fails, move to the NEXT step — do NOT retry the same selector
- If two elements share the same visible text, try the more specific CSS selector at Step 4
- NEVER invent a selector: only use text/attributes you can see in the page state below
- NEVER describe: selector="the blue button on the right" — this will always fail`)
```

### Change 2: Replace SELECTOR TIPS block in `buildActionReference` (lines 492–499)

**Before (lines 492–499):**
```typescript
  // Selector tips
  sections.push(`
## SELECTOR TIPS
- Use the field's VISIBLE LABEL: selector="Where from?", selector="Passengers"
- Use placeholder text: selector="Search", selector="Enter your email"
- Use button text: selector="Search flights", selector="Submit"
- Use CSS only as last resort: selector="input[name=q]"
- NEVER describe the page — emit the action immediately
- If an action fails, try a DIFFERENT selector (CSS, aria-label, etc.)`)
```

**After:**
```typescript
  // Selector tips — short reference (full sequence is in Band 1 SELECTOR STRATEGY above)
  sections.push(`
## SELECTOR ORDER (summary)
Visible text → Placeholder → Aria-label → CSS → Element ID (after READ_PAGE)
Use exact text from the page. If one fails, move to the next type — never retry the same.`)
```

## Acceptance Criteria

- [ ] AC1: Given a button with visible text "Search flights", model uses `selector="Search flights"` on first attempt (not CSS)
- [ ] AC2: Given an input with no visible label but placeholder="Enter your email", model uses `selector="Enter your email"` (not `selector="email"` or CSS)
- [ ] AC3: Given a failed `selector="Submit"`, model next tries aria-label OR CSS — not a text variation like `selector="submit"` or `selector="Submit button"`
- [ ] AC4: Model only emits element ID format (`{"element_id": N}`) in a response that also contains or follows a `[ACTION:READ_PAGE]` call
- [ ] AC5: When two elements share visible text (e.g., two "Next" buttons), model uses a CSS selector at Step 4 rather than guessing which "Next"
- [ ] AC6: The SELECTOR TIPS section in buildActionReference no longer contradicts Band 1 — it defers to the ordered sequence
- [ ] AC7: liteMode (Gemma 3 4B via LM Studio): same selector priority behavior — model still tries visible text first
- [ ] AC8: Real E2E test `06-form-filling.spec.ts` passes with Gemini 2.5 Flash Lite (real AI, not mock)

## Test Scenarios

**Scenario 1** — Buttons with text
- Input: "Click the Search button"
- Page: travel booking page with button visually labeled "Search flights"
- Expected first action: `[ACTION:CLICK selector="Search flights"]`
- NOT expected: `[ACTION:CLICK selector="button.search"]` or `[ACTION:CLICK selector="search-btn"]`

**Scenario 2** — Input field with placeholder only
- Input: "Type my email john@test.com"
- Page: login form — `<input type="email" placeholder="Enter your email">` (no visible label)
- Expected first action: `[ACTION:TYPE selector="Enter your email" value="john@test.com"]`
- NOT expected: `[ACTION:TYPE selector="email" value="..."]` or `[ACTION:TYPE selector="input[type=email]" value="..."]`

**Scenario 3** — Explicit fallback after failure
- Input: "Click Submit"
- Round 1: `[ACTION:CLICK selector="Submit"]` → returns failure "selector not found"
- Round 2 expected: `[ACTION:CLICK selector="[aria-label=Submit]"]` OR `[ACTION:CLICK selector="button[type=submit]"]`
- NOT expected: `[ACTION:CLICK selector="Submit"]` (same selector retried)
- NOT expected: `[ACTION:READ_PAGE filter="interactive"]` (too early — only 1 failure so far)

**Scenario 4** — Element ID only after READ_PAGE
- Input: "Click the login button"
- Expected sequence: text attempts fail → `[ACTION:READ_PAGE filter="interactive"]` → then `{"element_id": N, "action": "click"}`
- NOT expected: `{"element_id": 3, "action": "click"}` without a preceding READ_PAGE

**Scenario 5** — Ambiguous duplicate labels
- Input: "Click the Next button to proceed to payment"
- Page: form with two "Next" buttons (pagination + form step)
- Expected: `[ACTION:CLICK selector="button.payment-next"]` (CSS to disambiguate) OR model asks user which "Next"
- NOT expected: `[ACTION:CLICK selector="Next"]` (ambiguous, will click wrong one)

## Files to Modify

- `src/background/prompt-engine.ts`
  - `buildBand1_ActionFramework()` lines 704–713: replace SELECTOR STRATEGY block
  - `buildActionReference()` lines 492–499: replace SELECTOR TIPS block

## Token Impact

- Band 1 SELECTOR STRATEGY: ~95 tokens before → ~150 tokens after (+55)
- buildActionReference SELECTOR TIPS: ~65 tokens before → ~30 tokens after (-35)
- Net: **+20 tokens per request** — acceptable for the clarity gain

## Regression Risk

- Any test that mocks an AI response containing specific selector patterns must still match the new patterns
- `liteMode` uses identical `buildBand1_ActionFramework` — check that the longer SELECTOR STRATEGY still fits within the compact prompt token budget (systemCore: 800 tokens)
- No changes to selector execution code (action-executor) — only prompt text changes

## Out of Scope

- Fixing the actual action executor / selector resolution logic (DOM querying code)
- Adding new selector types (XPath, etc.)
- Fixing intent classification or token budget allocation

## Open Questions

None — implementation can begin.
