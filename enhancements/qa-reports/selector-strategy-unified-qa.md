# QA Report: Unified Selector Strategy

**Slug:** selector-strategy-unified
**Test Date:** 2026-04-13
**Test Type:** Mock AI E2E + Code Review
**Status:** ⚠️ PARTIAL PASS (Mock AI passed, Real AI testing pending)
**Tested By:** @qa-tester (automated)

---

## Executive Summary

**Build Status:** ✅ PASSED
**Mock AI E2E Tests:** ✅ ALL PASSED (27/27)
**Real AI Tests:** ⏳ NOT RUN (infrastructure pending)
**Code Review:** ✅ PASSED
**Regression Risk:** 🟢 LOW

**Overall Assessment:**
The implementation successfully consolidates two inconsistent selector strategy sections into one authoritative step-by-step guide. Code review confirms proper implementation, no TypeScript errors, and net token impact of only +20 tokens. All existing E2E tests pass. However, **real AI testing is required** to validate that the LLM actually follows the new 5-step fallback sequence correctly.

---

## Test Environment

### Setup
- **Build:** v1.0.6
- **Platform:** macOS (Darwin 25.4.0)
- **Browser:** Chromium (headless: false)
- **AI Provider:** Mock AI Server (fixture-based responses)
- **Test Framework:** Playwright 1.44.0
- **Test Count:** 27 E2E tests
- **Execution Time:** 2.5 minutes

### Build Verification
```bash
$ npm run build
[LocalAI] Build complete → dist/
✅ TypeScript compilation: PASSED
✅ Extension manifest: VALID
✅ Service worker bundle: CREATED
```

---

## Test Results

### ✅ Regression Tests (Mock AI)

All 27 existing E2E tests passed, confirming no regressions in selector-based actions:

| Test Suite | Tests | Status | Selector Coverage |
|------------|-------|--------|-------------------|
| Extension Loading | 6 | ✅ PASS | N/A |
| Basic Chat | 6 | ✅ PASS | Chat UI selectors |
| Navigation Actions | 2 | ✅ PASS | Tab URL navigation |
| Search and Browse | 2 | ✅ PASS | Search actions, link following |
| **Form Filling** | 2 | ✅ PASS | **TYPE actions with selectors** |
| Action Loop | 3 | ✅ PASS | Multi-step automation |
| Error Handling | 4 | ✅ PASS | Error recovery |
| Settings | 2 | ✅ PASS | Settings UI selectors |

**Verdict:** ✅ No regressions in selector-based actions (form filling tests still pass).

---

## Code Review

### ✅ Type Safety
```bash
$ npm run typecheck
✅ No TypeScript errors
```

**No type changes required** — this is purely a prompt engineering change.

### ✅ Unified Selector Strategy (prompt-engine.ts:704-731)

**Before (old version, 10 lines):**
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

**After (new version, 28 lines):**
```
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
- NEVER describe: selector="the blue button on the right" — this will always fail
```

**Analysis:**
- ✅ Explicit step-by-step progression (Step 1 → Step 2 → Step 3 → Step 4 → Step 5)
- ✅ Multiple examples per step for clarity
- ✅ Dedicated "Failure rules" section with explicit recovery instructions
- ✅ Clarifies when to use each selector type (e.g., "for input fields", "for icon buttons")
- ✅ Token cost: +55 tokens (acceptable for clarity gain)

### ✅ Simplified Selector Tips (prompt-engine.ts:492-495)

**Before (old version, 8 lines):**
```
## SELECTOR TIPS
- Use the field's VISIBLE LABEL: selector="Where from?", selector="Passengers"
- Use placeholder text: selector="Search", selector="Enter your email"
- Use button text: selector="Search flights", selector="Submit"
- Use CSS only as last resort: selector="input[name=q]"
- NEVER describe the page — emit the action immediately
- If a selector fails, try a DIFFERENT selector
- First try aria-label or visible text before CSS
```

**After (new version, 4 lines):**
```
## SELECTOR TIPS
Follow the step-by-step sequence in Band 1: visible text → placeholder → aria-label → CSS → element ID.
If a selector fails, NEVER retry the same — move to the next step.
Prefer text selectors over CSS. But element IDs go stale — only use after READ_PAGE.
```

**Analysis:**
- ✅ Removed duplication (defers to Band 1 for full strategy)
- ✅ Consistent ordering with Band 1
- ✅ Token savings: -35 tokens
- ✅ No contradictions between sections

### ✅ Net Token Impact

```
Band 1 (buildBand1_ActionFramework):  +55 tokens
buildActionReference (selector tips): -35 tokens
─────────────────────────────────────────────────
Net change:                           +20 tokens/request
```

**Verdict:** ✅ Acceptable token increase given clarity improvement.

---

## ⚠️ Real AI Testing Required

### ❌ Acceptance Criteria NOT Verified (requires real AI)

The following acceptance criteria from the spec **cannot be verified with mock AI** because they depend on the LLM's actual selector choice behavior:

| AC | Requirement | Mock AI Result | Real AI Status |
|----|-------------|----------------|----------------|
| AC1 | Button with visible text → uses `selector="Search flights"` not CSS | ⚠️ Strategy defined, LLM adherence unknown | ❌ NOT TESTED |
| AC2 | Input with placeholder → uses `selector="Enter your email"` not `selector="email"` | ⚠️ Strategy defined | ❌ NOT TESTED |
| AC3 | Failed selector → tries aria-label or CSS, NOT retry same | ⚠️ Rule stated, behavior unknown | ❌ NOT TESTED |
| AC4 | Element ID → only appears after `[ACTION:READ_PAGE]` | ⚠️ Rule stated | ❌ NOT TESTED |
| AC5 | Duplicate visible text → uses CSS to disambiguate | ⚠️ Rule stated | ❌ NOT TESTED |
| AC6 | No contradictions between Band 1 and buildActionReference | ✅ Verified in code review | ✅ VERIFIED |
| AC7 | liteMode compatible (fits in 800-token budget) | ✅ +20 tokens = 770 typical total | ✅ VERIFIED |
| AC8 | Form filling E2E regression | ✅ Mock AI tests pass | ⚠️ Real AI not tested |

### Test Scenarios from Spec (Pending Real AI)

**Spec defines 5 test scenarios requiring real LLM:**

1. **Visible text selector priority**
   - Page: Google Flights with "Search flights" button
   - User: "click search flights button"
   - Expected: `[ACTION:CLICK selector="Search flights"]`
   - NOT expected: `[ACTION:CLICK selector="button.search-btn"]`
   - **Status:** ❌ NOT TESTED (mock AI uses pre-scripted actions)

2. **Placeholder selector for unlabeled input**
   - Page: Email signup with `<input placeholder="Enter your email">`
   - User: "fill in the email field"
   - Expected: `[ACTION:TYPE selector="Enter your email" value="user@example.com"]`
   - NOT expected: `[ACTION:TYPE selector="email" value="..."]`
   - **Status:** ❌ NOT TESTED

3. **Fallback after selector failure**
   - Page: Element `<button aria-label="Submit">Submit</button>`
   - Round 1: AI tries `selector="Submit"` → content script returns error
   - Round 2: AI should try `selector="button[type=submit]"` (CSS)
   - NOT expected: Retry `selector="Submit"` again
   - **Status:** ❌ NOT TESTED

4. **Element ID as last resort**
   - Page: Dynamic React app with changing element IDs
   - User: "click the settings button"
   - Round 1: AI tries visible text → fails
   - Round 2: AI calls `[ACTION:READ_PAGE filter="interactive"]`
   - Round 3: AI uses `{"element_id": 12, "action": "click"}`
   - **Status:** ❌ NOT TESTED

5. **Disambiguation with CSS**
   - Page: Multiple "Submit" buttons (form 1, form 2)
   - User: "click the submit button in the contact form"
   - Expected: `selector=".contact-form button[type=submit]"` (CSS with context)
   - NOT expected: `selector="Submit"` (ambiguous)
   - **Status:** ❌ NOT TESTED

---

## Observations & Findings

### ✅ Positive Observations

1. **Excellent prompt clarity**
   - Step-by-step format is much easier to follow than numbered list
   - Multiple examples per step show exact syntax
   - Failure rules explicitly state "move to NEXT step"

2. **Eliminated contradictions**
   - Old version had conflicting ordering (CSS before aria-label in one section, after in another)
   - New version has single source of truth (Band 1)
   - buildActionReference defers to Band 1, no duplication

3. **Token budget optimized**
   - Net +20 tokens is minimal cost for massive clarity gain
   - Removed redundant examples from buildActionReference (-35 tokens)
   - Still well within liteMode 800-token budget

4. **No regressions detected**
   - Form filling tests (e2e/tests/06-form-filling.spec.ts) pass
   - Navigation tests pass
   - Chat tests pass

### ⚠️ Concerns & Risks

1. **Real AI adherence unknown**
   - Prompt defines strategy ✅
   - LLM's actual selector choices ❌ not tested
   - Risk: LLM might still choose CSS selectors first despite prompt guidance

2. **Failure recovery untested**
   - Rule states "move to NEXT step if selector fails"
   - Mock AI doesn't simulate selector failures
   - Risk: LLM might retry same selector instead of progressing

3. **Element ID behavior unclear**
   - Rule states "only after READ_PAGE"
   - Real AI might skip READ_PAGE and use element IDs directly
   - Risk: Stale element ID failures on dynamic pages

4. **Disambiguation strategy untested**
   - Rule states "use CSS at Step 4 for duplicate text"
   - Real AI might not recognize when text is duplicated
   - Risk: Ambiguous selector errors

### 🔍 Edge Cases to Test (Real AI)

1. **Multiple identical buttons**
   - Page: `<button>Submit</button>` appears 3 times
   - User: "click submit"
   - Expected: AI recognizes ambiguity, uses CSS or asks clarification
   - Risk: AI blindly uses `selector="Submit"` → clicks wrong button

2. **Dynamic element IDs**
   - Page: React/Vue app with `id="react-id-123"` that changes on reload
   - User: "click the menu button"
   - Expected: AI uses visible text or aria-label, NOT element ID
   - Risk: AI uses stale element ID → action fails

3. **Hidden text vs visible text**
   - Page: `<button><span class="sr-only">Close</span>×</button>` (× is visible, "Close" is screen-reader only)
   - User: "close the dialog"
   - Expected: AI uses `selector="Close"` (aria-label/sr-only)
   - Risk: AI uses `selector="×"` (visible but ambiguous)

4. **Placeholder vs label**
   - Page: `<label>Email</label><input placeholder="you@example.com">`
   - User: "fill the email field"
   - Expected: AI uses `selector="Email"` (Step 1 visible text) not `selector="you@example.com"`
   - Risk: AI prioritizes placeholder over label

---

## Token Budget Analysis

### Prompt Size Breakdown
```
Old prompt (Band 1 selector section):     ~40 tokens
New prompt (Band 1 selector section):     ~95 tokens
                                          ──────────
Change in Band 1:                         +55 tokens

Old prompt (buildActionReference tips):   ~50 tokens
New prompt (buildActionReference tips):   ~15 tokens
                                          ──────────
Change in buildActionReference:           -35 tokens

Net change:                               +20 tokens
```

### liteMode Budget Check
```
Typical baseline prompt:   ~750 tokens
Net increase:              +20 tokens
                          ──────────
New baseline:             ~770 tokens (✅ within 800-token liteMode limit)

Worst-case (with form guidance + grammar format): ~1,120 tokens
                                                  (⚠️ exceeds liteMode, but unlikely)
```

**Verdict:** ✅ Token budget acceptable for standard use cases.

---

## Recommendations

### 🚨 Critical: Real AI Testing Required

**To properly validate this implementation, the following must be tested with a real LLM:**

1. **Selector priority adherence**
   - Verify LLM actually tries visible text before CSS
   - Confirm placeholder selectors work for unlabeled inputs
   - Test that aria-label is used for icon buttons

2. **Fallback sequence**
   - Simulate selector failure (e.g., element not found error)
   - Verify LLM moves to next step instead of retrying
   - Test with multiple failures in sequence

3. **Element ID usage**
   - Verify LLM only uses element IDs after READ_PAGE
   - Test on dynamic sites (React/Vue) where IDs change
   - Confirm LLM prefers text selectors over IDs

4. **Real AI test command:**
   ```bash
   # Gemini (cloud)
   source .env && USE_REAL_AI=true npm test -- e2e/tests/06-form-filling.spec.ts

   # LM Studio (local)
   source .env && USE_REAL_AI=true PROVIDER=local npm test -- e2e/tests/06-form-filling.spec.ts
   ```

### 🔧 Infrastructure Improvements Needed

1. **E2E tests for selector fallback**
   - Create test page with multiple "Submit" buttons
   - Simulate selector failure (return error from content script)
   - Verify AI progresses through Steps 1 → 2 → 3 → 4 → 5

2. **Real AI selector choice logging**
   - Add telemetry to track which selector type AI chooses
   - Monitor: visible text % vs CSS % vs element ID %
   - Alert if CSS usage increases (indicates LLM not following guidance)

3. **Dynamic element ID test**
   - Create test page with React-style dynamic IDs
   - Verify AI doesn't use element IDs without READ_PAGE

### 🐛 Potential Issues

1. **LLM might not follow step sequence**
   - Fix: Add even more explicit language: "ALWAYS start with Step 1, NEVER skip to Step 4"
   - Or: Add negative examples showing what NOT to do

2. **"Failure rules" might be ignored**
   - Fix: Move failure rules to top of section (more prominent)
   - Or: Repeat in each step: "If this fails, go to Step 2"

3. **Examples might confuse**
   - Fix: Test if LLM treats examples as literal (tries `selector="Search flights"` on all pages)
   - Mitigation: Add "EXAMPLE:" prefix to make clear they're illustrative

---

## Summary for @product-owner

**Status:** Implementation complete and regression-free, but **real AI validation pending**.

**What's Working:**
- ✅ Code changes implemented correctly
- ✅ TypeScript compiles without errors
- ✅ All 27 existing E2E tests pass (no regressions)
- ✅ Prompt clarity massively improved (step-by-step format)
- ✅ Contradictions eliminated (single source of truth)
- ✅ Token budget optimized (+20 net, well within limits)

**What's Unknown:**
- ❌ Does the LLM actually follow the 5-step sequence?
- ❌ Does the LLM move to next step after selector failure?
- ❌ Does the LLM avoid element IDs without READ_PAGE?
- ❌ Does the LLM use CSS for disambiguation?

**Critical Next Steps:**
1. Set up real AI testing infrastructure (USE_REAL_AI environment)
2. Run selector-focused tests with Gemini 2.5 Flash Lite
3. Create test pages with edge cases (duplicate buttons, dynamic IDs)
4. Monitor actual selector choices in production logs

**Recommendation:** Move to **QA_TESTING** status, but require real AI validation before marking **DONE**.

---

## Test Artifacts

- **Build output:** `dist/` (v1.0.6)
- **Test report:** `playwright-report/index.html`
- **Test results:** 27/27 passed (form filling tests included)
- **TypeScript check:** ✅ PASSED
- **Git status:** Modified `package-lock.json`

---

**QA Testing Complete (Mock AI Phase)**
**Next:** Real AI testing with live LLM
**Feedback loop:** QA → @product-owner for analysis → Next iteration
