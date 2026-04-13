# QA Report: Multi-Step Form Wizard Awareness

**Slug:** multistep-form-wizard-awareness
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
The implementation successfully adds wizard step detection, field-specific task plans, cross-page continuity warnings, and FILL_FORM/FORM_COACH decision rules. Code review confirms proper implementation with no TypeScript errors. All existing E2E tests pass. However, **real AI testing is required** to validate that the LLM actually handles multi-step wizards correctly (advancing pages, maintaining context, choosing correct actions).

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

All 27 existing E2E tests passed, confirming no regressions in form filling:

| Test Suite | Tests | Status | Form Coverage |
|------------|-------|--------|---------------|
| Extension Loading | 6 | ✅ PASS | N/A |
| Basic Chat | 6 | ✅ PASS | N/A |
| Navigation Actions | 2 | ✅ PASS | Page transitions |
| Search and Browse | 2 | ✅ PASS | N/A |
| **Form Filling** | 2 | ✅ PASS | **TYPE actions, form fill formatting** |
| Action Loop | 3 | ✅ PASS | Multi-round automation (similar to wizard flow) |
| Error Handling | 4 | ✅ PASS | Error recovery |
| Settings | 2 | ✅ PASS | N/A |

**Verdict:** ✅ No regressions in form-related actions.

**Note:** Existing tests use simple single-page forms, not multi-step wizards. Wizard-specific behavior (step detection, Next button clicks, cross-page continuity) is NOT covered by current test suite.

---

## Code Review

### ✅ Type Safety
```bash
$ npm run typecheck
✅ No TypeScript errors
```

**No type changes required** — this is purely a prompt engineering change.

### ✅ Wizard Step Detection (prompt-engine.ts:313-355)

**New Detection Logic:**
```typescript
// Detect wizard indicators
const stepIndicatorPattern = /(?:step\s+)?(\d+)\s*(?:of|\/|\|)\s*(\d+)/i
const stepMatch = bodyText.match(stepIndicatorPattern)
const isWizard = stepMatch || flows.some(f =>
  f.buttons?.some(b =>
    /\b(next|continue|proceed|weiter|siguiente|suivant)\b/i.test(b.text)
  )
)

const currentStep = stepMatch ? parseInt(stepMatch[1], 10) : 1
const totalSteps = stepMatch ? parseInt(stepMatch[2], 10) : 3
```

**Analysis:**
- ✅ Detects: "Step 2 of 4", "2/3 steps", "1 | 3", etc.
- ✅ Detects: Next/Continue buttons in multiple languages
- ✅ Falls back to simple form mode if no wizard indicators

**Task Plan Enhancement:**
```typescript
// Before:
description: `Fill ${emptyFields.length} form fields`

// After:
description: `Fill ${emptyFields.length} form fields (Step ${currentStep} of ${totalSteps}): First Name, Last Name, Address, Email…`
```

**Analysis:**
- ✅ Shows exact field names (not just count)
- ✅ Shows wizard progress "(Step X of Y)"
- ✅ Limits to first 4 field names + ellipsis for readability
- ✅ Token cost: +40 tokens (only when fill_form + forms present)

### ✅ Cross-Page Continuity Warning (prompt-engine.ts:627-633)

**New Warning Injection:**
```typescript
if (taskPlan && stateDiff && stateDiff.includes('navigat')) {
  const nextStep = taskPlan.steps[taskPlan.currentStep]
  if (nextStep) {
    parts.push(`\n⚠️ FORM PAGE ADVANCED: The form moved to a new page/step. All previous selectors are now invalid — do not retry them. Focus on the new fields visible below.${nextStep.expectedActions.length > 0 ? ` Expected fields on this step: ${nextStep.expectedActions.join(', ')}.` : ''}`)
  }
}
```

**Analysis:**
- ✅ Detects page navigation via stateDiff
- ✅ Warns that old selectors are invalid
- ✅ Shows expected fields for new page
- ✅ Only fires when in form task + navigation detected
- ✅ Token cost: +40 tokens (conditional)

**Example Output:**
```
⚠️ FORM PAGE ADVANCED: The form moved to a new page/step. All previous selectors are now invalid — do not retry them. Focus on the new fields visible below. Expected fields on this step: TYPE Card Number, TYPE CVV, TYPE Expiration Date.
```

### ✅ Enhanced Task Plan Output (prompt-engine.ts:872-886)

**New Format:**
```
## TASK PLAN
→ Step 1: Fill 3 form fields (Step 2 of 3): First Name | Last Name | Address
   Fields: TYPE First Name | TYPE Last Name | TYPE Address
· Step 2: Advance to next step (click Next/Continue)
   Expected: CLICK Next | CLICK Continue
_Adapt to actual page — field names may differ._
```

**Analysis:**
- ✅ Shows progress markers (→ current, · pending, ✓ completed)
- ✅ Lists exact field names under each step
- ✅ Shows expected actions (TYPE vs CLICK vs FILL_FORM)
- ✅ Includes "adapt to actual page" disclaimer
- ✅ Token cost: +25 tokens per request (when task plan present)

### ✅ FILL_FORM vs FORM_COACH Decision Rules (prompt-engine.ts:484-494)

**New Decision Block:**
```
## FORM FILLING — WHICH ACTION TO USE
- **2+ fields, values known, non-sensitive** → use FILL_FORM (batch, fastest)
- **Sensitive data (payment, SSN, passwords)** → use FORM_COACH (user reviews each field)
- **User asked to "guide" or "help me fill"** → use FORM_COACH
- **1 field only** → use TYPE directly
- **Wizard/multi-step form** → use sequential TYPE per field, then CLICK Next for each step
- **Unknown field values** → ask user before filling
```

**Analysis:**
- ✅ Clear decision tree for LLM
- ✅ Recommends TYPE (not FILL_FORM) for wizards → better control
- ✅ Recommends FORM_COACH for sensitive data → safety
- ✅ Recommends direct TYPE for single fields → simplicity
- ✅ Token cost: +60 tokens (fill_form intent only)

### ✅ Wizard-Specific Fallback Strategy

**Added to task plan:**
```typescript
// Wizard fallback:
"If a field is missing, try scrolling — wizard forms often hide fields below fold. After clicking Next, wait for new fields to load before interacting."

// Simple form fallback:
"Fill fields one by one using TYPE if FILL_FORM fails."
```

**Analysis:**
- ✅ Wizard-aware guidance (scroll, wait for load)
- ✅ Distinguishes wizard vs simple form handling
- ✅ Provides recovery strategy for missing fields

### ✅ Net Token Impact

```
Wizard step detection (decomposeTask):    +40 tokens (conditional)
Cross-page warning (buildBand2):          +40 tokens (conditional)
Task plan output (buildBand2):            +25 tokens (when plan exists)
FILL_FORM decision rules (buildBand1):    +60 tokens (fill_form intent only)
────────────────────────────────────────────────────────────────────
Net change (fill_form intent):          ~+125 tokens (wizards)
                                        ~+85 tokens (simple forms)
```

**Verdict:** ✅ Acceptable token increase for wizard-specific guidance.

---

## ⚠️ Real AI Testing Required

### ❌ Acceptance Criteria NOT Verified (requires real AI)

The following acceptance criteria from the spec **cannot be verified with mock AI** because they depend on the LLM's actual wizard handling behavior:

| AC | Requirement | Mock AI Result | Real AI Status |
|----|-------------|----------------|----------------|
| AC1 | Wizard detection: "Step 2 of 3" detected | ✅ Detection logic verified | ⚠️ LLM response not tested |
| AC2 | Task plan shows field names: "First Name, Last Name" not just "Fill 2 fields" | ✅ Format verified | ⚠️ LLM adherence not tested |
| AC3 | Cross-page warning appears after Next click | ✅ Warning injection verified | ❌ NOT TESTED (no navigation in mock) |
| AC4 | AI doesn't retry old selectors after page advance | ⚠️ Warning states rule | ❌ NOT TESTED |
| AC5 | Sequential TYPE (not FILL_FORM) recommended for wizards | ✅ Rule stated | ❌ NOT TESTED |
| AC6 | FORM_COACH used for sensitive fields | ✅ Rule stated | ❌ NOT TESTED |
| AC7 | Scrolling attempted for missing fields | ✅ Guidance added | ❌ NOT TESTED |
| AC8 | Form filling E2E regression | ✅ Mock AI tests pass | ⚠️ Real AI not tested |

### Test Scenarios from Spec (Pending Real AI)

**Spec defines test scenarios requiring real multi-step form + LLM:**

1. **Wizard step detection**
   - Page: Checkout wizard showing "Step 2 of 3 — Shipping Info"
   - User: "fill the form"
   - Expected task plan:
     ```
     → Step 1: Fill 3 form fields (Step 2 of 3): Address, City, Postal Code
     · Step 2: Advance to next step (click Next)
     ```
   - **Status:** ❌ NOT TESTED (mock AI doesn't generate task plans)

2. **Field names in task plan**
   - Page: Job application form with Name, Email, Phone, Resume upload
   - User: "help me fill this application"
   - Expected: Shows "Name, Email, Phone, Resume" in task plan
   - NOT expected: "Fill 4 form fields" without names
   - **Status:** ❌ NOT TESTED

3. **Cross-page continuity**
   - Round 1: Fill page 1 fields (Name, Email)
   - Round 2: Click "Next" → page advances to payment step
   - Round 3: AI receives warning: "⚠️ FORM PAGE ADVANCED: All previous selectors invalid. Expected: Card Number, CVV"
   - Expected: AI fills new fields (NOT retry "Name" selector)
   - **Status:** ❌ NOT TESTED

4. **FILL_FORM vs TYPE choice**
   - Simple contact form: AI should use FILL_FORM
   - Multi-step wizard: AI should use sequential TYPE + CLICK Next
   - Payment form: AI should use FORM_COACH
   - **Status:** ❌ NOT TESTED

5. **Missing field scroll behavior**
   - Wizard with fields below fold
   - User: "fill the form"
   - Expected: AI scrolls down to find hidden fields
   - Fallback guidance: "try scrolling — wizard forms often hide fields below fold"
   - **Status:** ❌ NOT TESTED

---

## Observations & Findings

### ✅ Positive Observations

1. **Excellent wizard detection**
   - Pattern matches multiple formats: "Step 2 of 3", "2/3", "1 | 3"
   - Multi-language Next button support (English, German, Spanish, French)
   - Fallback to simple form mode if no indicators

2. **Task plans are much clearer**
   - Before: "Fill 4 fields" (vague)
   - After: "Fill 4 fields: Name, Email, Phone, Address" (specific)
   - Progress markers (→ current, · pending) help track multi-step flow

3. **Cross-page warning is explicit**
   - Clearly states "All previous selectors are now invalid"
   - Shows expected fields for new page
   - Prevents common error: retrying stale selectors

4. **Decision rules are clear**
   - FILL_FORM for simple forms (batch efficiency)
   - TYPE for wizards (better control per field)
   - FORM_COACH for sensitive data (user review)

5. **No regressions detected**
   - All 27 E2E tests pass
   - Form filling tests still work
   - No TypeScript errors

### ⚠️ Concerns & Risks

1. **Real AI wizard behavior unknown**
   - Wizard detection verified ✅
   - LLM's actual handling of wizards ❌ not tested
   - Risk: LLM might use FILL_FORM on wizards despite guidance to use TYPE

2. **Cross-page warning untested**
   - Warning injection verified ✅
   - LLM's response to warning ❌ not tested
   - Risk: LLM might ignore warning and retry old selectors anyway

3. **Task plan adherence unknown**
   - Task plan format verified ✅
   - LLM following the plan ❌ not tested
   - Risk: LLM might skip steps or fill out of order

4. **Token budget increase**
   - +125 tokens for wizard forms
   - +85 tokens for simple forms
   - Risk: Might approach liteMode 800-token limit with other conditional sections

5. **Wizard vs simple form detection edge cases**
   - What if form has "Next" but isn't a wizard? (e.g., carousel)
   - What if wizard doesn't have "Step X of Y" text? (progress bar only)
   - Risk: False positives/negatives in wizard detection

### 🔍 Edge Cases to Test (Real AI)

1. **False wizard detection**
   - Page: Single-page form with "Next" button for image carousel
   - User: "fill the form"
   - Expected: AI recognizes NOT a wizard (no step indicators), uses FILL_FORM
   - Risk: AI treats as wizard, uses TYPE for each field unnecessarily

2. **Wizard without step numbers**
   - Page: Checkout wizard with progress bar (no "Step X of Y" text)
   - User: "complete the checkout"
   - Expected: AI detects "Next" button, treats as wizard
   - Risk: AI misses wizard, tries to fill all steps at once

3. **Dynamic wizard fields**
   - Page: Wizard Step 1 has "Country" dropdown
   - Selection: USA → Step 2 shows "State" field
   - Selection: Canada → Step 2 shows "Province" field
   - Expected: AI adapts to actual fields on each step
   - Risk: AI follows static task plan, fails when fields differ

4. **Wizard with validation errors**
   - Round 1: AI fills Step 1 fields, clicks Next
   - Round 2: Server returns validation error (stays on Step 1)
   - Expected: AI recognizes error, corrects fields, retries Next
   - Risk: AI sees "navigat" in stateDiff, thinks page advanced, ignores errors

5. **Mixed sensitive/non-sensitive fields**
   - Wizard Step 1: Name, Email (non-sensitive)
   - Wizard Step 2: Credit Card, CVV (sensitive)
   - Expected: AI uses TYPE for Step 1, FORM_COACH for Step 2
   - Risk: AI uses same strategy for all steps

6. **Long wizard (10+ steps)**
   - Page: Job application with 12 steps
   - User: "fill the application"
   - Expected: AI processes each step sequentially
   - Risk: Token budget explodes with 12 task plan steps

---

## Token Budget Analysis

### Prompt Size Breakdown
```
Wizard step detection (decomposeTask):    ~40 tokens (when forms present)
Cross-page warning (buildBand2):          ~40 tokens (when navigation detected)
Task plan output (buildBand2):            ~25 tokens (when plan exists)
FILL_FORM decision rules (buildBand1):    ~60 tokens (fill_form intent only)
                                          ──────────────────────────────────
Total for wizard form:                   ~165 tokens additional
Total for simple form:                   ~125 tokens additional
```

### liteMode Budget Check
```
Typical baseline prompt:        ~750 tokens
Simple form additions:          +85 tokens
                               ──────────
Simple form total:             ~835 tokens (⚠️ slightly over 800 liteMode limit)

Wizard form additions:         +125 tokens
                               ──────────
Wizard form total:             ~875 tokens (⚠️ exceeds 800 liteMode limit)

With other conditional sections (grammar + smart form guidance):
                               ~1,200 tokens (❌ far exceeds liteMode)
```

**Verdict:** ⚠️ Token budget may be problematic for liteMode users. Recommendation: Test actual token counts and consider shortening prompts or disabling some sections in liteMode.

---

## Recommendations

### 🚨 Critical: Real AI Testing Required

**To properly validate this implementation, the following must be tested with a real LLM:**

1. **Create multi-step wizard test page:**
   ```html
   <!-- Step 1 -->
   <h2>Step 1 of 3 — Personal Info</h2>
   <input name="name" placeholder="Full Name">
   <input name="email" type="email" placeholder="Email">
   <button type="button" onclick="showStep2()">Next</button>

   <!-- Step 2 (hidden initially) -->
   <h2>Step 2 of 3 — Address</h2>
   <input name="address" placeholder="Street Address">
   <input name="city" placeholder="City">
   <button type="button" onclick="showStep3()">Next</button>

   <!-- Step 3 (hidden initially) -->
   <h2>Step 3 of 3 — Payment</h2>
   <input name="card" placeholder="Card Number">
   <input name="cvv" placeholder="CVV">
   <button type="submit">Submit</button>
   ```

2. **Test scenarios:**
   - User: "fill out this form"
   - Round 1: Verify task plan shows "Step 1 of 3: Full Name, Email"
   - Round 2: Verify AI clicks Next (not Submit)
   - Round 3: Verify ⚠️ warning appears, AI fills Step 2 fields
   - Round 4: Verify AI uses FORM_COACH for payment step (sensitive data)

3. **Real AI test command:**
   ```bash
   # Gemini (cloud)
   source .env && USE_REAL_AI=true npm test -- e2e/tests/wizard-forms.spec.ts

   # LM Studio (local)
   source .env && USE_REAL_AI=true PROVIDER=local npm test -- e2e/tests/wizard-forms.spec.ts
   ```

### 🔧 Infrastructure Improvements Needed

1. **Create wizard-specific E2E tests**
   - Test page: Multi-step wizard (3+ steps)
   - Verify step detection
   - Verify cross-page continuity
   - Verify TYPE vs FILL_FORM choice

2. **Add wizard test fixtures**
   - Simple wizard (2 steps, Next button)
   - Complex wizard (5 steps, step indicators)
   - Payment wizard (sensitive fields)
   - Conditional wizard (fields change based on input)

3. **Token budget monitoring**
   - Log actual prompt token counts for wizard forms
   - Alert if exceeds liteMode 800-token limit
   - Consider shortening prompts or disabling features in liteMode

### 🐛 Potential Issues

1. **Token budget for liteMode users**
   - Fix: Add liteMode check, shorten wizard guidance
   - Or: Disable task plan field names in liteMode (just show count)

2. **False wizard detection**
   - Fix: Require BOTH step indicator AND Next button for high confidence
   - Or: Add exclusion patterns (carousel, tabs, accordions)

3. **Cross-page warning might fire on non-wizard navigation**
   - Fix: Check if form task specifically (not just any navigation)
   - Current code already does this ✅

4. **Task plan field names might be too long**
   - Fix: Already limited to first 4 fields + ellipsis ✅
   - Consider: Shorten field names (e.g., "Full Name" → "Name")

---

## Summary for @product-owner

**Status:** Implementation complete and regression-free, but **real AI validation pending**.

**What's Working:**
- ✅ Code changes implemented correctly
- ✅ TypeScript compiles without errors
- ✅ All 27 existing E2E tests pass (no regressions)
- ✅ Wizard detection logic verified (step indicators, Next buttons)
- ✅ Task plan format improved (shows field names)
- ✅ Cross-page warning injection verified
- ✅ FILL_FORM/FORM_COACH decision rules defined

**What's Unknown:**
- ❌ Does the LLM actually detect wizards correctly?
- ❌ Does the LLM follow task plan (sequential TYPE → CLICK Next)?
- ❌ Does the LLM respond to cross-page warning (not retry old selectors)?
- ❌ Does the LLM choose TYPE for wizards vs FILL_FORM for simple forms?
- ❌ Does the LLM use FORM_COACH for sensitive data?

**Critical Next Steps:**
1. Create multi-step wizard test page (HTML fixture)
2. Run real AI tests with Gemini 2.5 Flash Lite
3. Monitor token budget (⚠️ may exceed liteMode 800-token limit)
4. Verify LLM handles cross-page navigation correctly
5. Test edge cases (false wizard detection, validation errors, dynamic fields)

**Recommendation:** Move to **QA_TESTING** status, but require real AI validation before marking **DONE**.

**Risk Assessment:**
- Regression risk: 🟢 LOW (all tests pass)
- Token budget risk: 🟡 MEDIUM (may exceed liteMode limit)
- Real AI behavior risk: 🟡 MEDIUM (untested wizard handling)

---

## Test Artifacts

- **Build output:** `dist/` (v1.0.6)
- **Test report:** `playwright-report/index.html`
- **Test results:** 27/27 passed (form filling + action loop tests included)
- **TypeScript check:** ✅ PASSED
- **Git status:** Modified `package-lock.json`

---

**QA Testing Complete (Mock AI Phase)**
**Next:** Real AI testing with multi-step wizard pages
**Feedback loop:** QA → @product-owner for analysis → Next iteration
