# Multi-Step Form Wizard Awareness

**Slug:** multistep-form-wizard-awareness
**Type:** Prompt Engineering
**Priority:** P1 (high — complex form automation fails silently today)
**Requested:** 2026-04-12
**Status:** SPECCED

## Summary
Multi-step "wizard" forms (checkout, job application, onboarding) span multiple pages connected by "Next/Continue" buttons. The current prompt system decomposes ALL forms into the same 2-step plan ("Fill N fields" → "Submit"), ignores step indicators, never shows the model which specific fields to fill, and gives no cross-page continuity signal when "Next" loads a fresh page with new fields. The model loses track of where it is in the wizard and frequently tries invalid selectors from previous pages.

## Root Cause Analysis

**Gap 1 — `decomposeTask()` is blind to wizards** (`prompt-engine.ts` lines 306–321):
```typescript
steps.push({ description: `Fill ${emptyFields.length} form fields`, ... })
steps.push({ description: 'Submit form', ... })
return { steps, currentStep: 0, fallbackStrategy: 'Fill fields one by one if batch fill fails.' }
```
No detection of "Step 2 of 4" indicators, progress bars, or "Next" vs "Submit" buttons. A 5-page checkout gets the same plan as a 2-field login.

**Gap 2 — `expectedActions` are built but never shown** (`prompt-engine.ts` lines 309, 773–780):
```typescript
expectedActions: emptyFields.map(f => `TYPE ${f.label || f.name}`)
// ... but in buildBand2_PageUnderstanding:
const planLines = taskPlan.steps.map((s, i) => `${i + 1}. ${s.description}`)
// expectedActions are never included in planLines
```
The model knows "Fill 4 form fields" but not WHICH 4 fields or in what order.

**Gap 3 — No cross-page continuity in `buildFollowUpContext()`** (`prompt-engine.ts` lines 569–585):
When the user clicks "Next" and a new form page loads, the follow-up context gets `freshContext` and `stateDiff` but no instruction telling the model: "You completed step 1 of a multi-step form. The page changed. Previous selectors are invalid. These are the new fields on step 2."

**Gap 4 — FILL_FORM syntax underdocumented** (`prompt-engine.ts` line 458):
```typescript
{ syntax: '[ACTION:FILL_FORM assignments=\'[{"selector":"Email","value":"x@y.com","inputType":"text"}]\']',
  when: 'Fill multiple fields at once. Efficient for forms with many fields.' }
```
The JSON-within-action string is shown once with no guidance on `inputType` values, no multi-field example, and no instruction on when to prefer FILL_FORM over sequential TYPE actions.

**Gap 5 — FORM_COACH vs FILL_FORM decision is missing** (`prompt-engine.ts` line 472):
```typescript
{ syntax: '[ACTION:FORM_COACH]', when: 'Start guided step-by-step form filling with user approval.' }
```
No guidance on when to choose FORM_COACH vs FILL_FORM vs sequential TYPE. Model picks arbitrarily.

## Current Prompt Behavior
Model receives task plan: "1. Fill 4 form fields  2. Submit form". No field names. No wizard step awareness. When "Next" advances the form, follow-up context shows new page fields with no explanation of the transition. Model often retries selectors from page 1 on page 2.

## Desired Prompt Behavior
Model receives:
1. A wizard-aware task plan that detects and names steps ("Step 1 of 3: Personal Info", "Step 2 of 3: Payment")
2. Specific field names listed under each step's expectedActions
3. A cross-page continuity note in follow-up context: "Form advanced to next step. Previous selectors invalid. Current step fields: [list]"
4. Clear FILL_FORM vs TYPE vs FORM_COACH decision rules

## Exact Prompt Changes Required

### Change 1: Wizard step detection in `decomposeTask()` (lines 306–321)

**Before:**
```typescript
if (intent.category === 'fill_form' && pageSnapshot && pageSnapshot.forms.length > 0) {
  const form = pageSnapshot.forms[0]
  const emptyFields = (form.fields ?? []).filter(f => !f.value || f.value.length === 0)
  if (emptyFields.length > 0) {
    steps.push({
      description: `Fill ${emptyFields.length} form fields`,
      expectedActions: emptyFields.map(f => `TYPE ${f.label || f.name}`),
      successCriteria: 'All form fields populated',
    })
    steps.push({
      description: 'Submit form',
      expectedActions: ['CLICK submit button'],
      successCriteria: 'Form submitted, page navigated or confirmation shown',
    })
    return { steps, currentStep: 0, fallbackStrategy: 'Fill fields one by one if batch fill fails.' }
  }
}
```

**After:**
```typescript
if (intent.category === 'fill_form' && pageSnapshot && pageSnapshot.forms.length > 0) {
  const form = pageSnapshot.forms[0]
  const emptyFields = (form.fields ?? []).filter(f => !f.value || f.value.length === 0)
  if (emptyFields.length > 0) {
    // Detect wizard/multi-step indicators from page text
    const pageText = (pageSnapshot.completePageText ?? '').toLowerCase()
    const stepMatch = pageText.match(/step\s+(\d+)\s+(?:of|\/)\s+(\d+)/i)
      ?? pageText.match(/(\d+)\s*\/\s*(\d+)\s*steps?/i)
    const hasNextButton = (pageSnapshot.buttons ?? []).some(b =>
      /^(next|continue|proceed|weiter|siguiente)$/i.test(b.label?.trim() ?? ''))
    const isWizard = !!(stepMatch || hasNextButton)
    const currentStep = stepMatch ? Number(stepMatch[1]) : 1
    const totalSteps = stepMatch ? Number(stepMatch[2]) : (hasNextButton ? 2 : 1)
    const stepLabel = isWizard ? ` (Step ${currentStep} of ${totalSteps})` : ''

    const fieldNames = emptyFields.map(f => f.label || f.name).filter(Boolean)
    steps.push({
      description: `Fill ${emptyFields.length} form fields${stepLabel}: ${fieldNames.slice(0, 4).join(', ')}${fieldNames.length > 4 ? '…' : ''}`,
      expectedActions: emptyFields.map(f => `TYPE ${f.label || f.name}`),
      successCriteria: 'All visible form fields populated',
    })

    if (isWizard && currentStep < totalSteps) {
      steps.push({
        description: `Advance to next step (click Next/Continue)`,
        expectedActions: ['CLICK Next', 'CLICK Continue'],
        successCriteria: 'Page advances to next form step; previous selectors invalid',
      })
    } else {
      steps.push({
        description: 'Submit form',
        expectedActions: ['CLICK submit button'],
        successCriteria: 'Form submitted, page navigated or confirmation shown',
      })
    }

    const fallback = isWizard
      ? 'If a field is missing, try scrolling — wizard forms often hide fields below fold. After clicking Next, wait for new fields to load before interacting.'
      : 'Fill fields one by one using TYPE if FILL_FORM fails.'
    return { steps, currentStep: 0, fallbackStrategy: fallback }
  }
}
```

### Change 2: Show `expectedActions` in Band 2 task plan output (lines 773–780)

**Before (in `buildBand2_PageUnderstanding`):**
```typescript
const planLines = taskPlan.steps.map((s, i) => `${i + 1}. ${s.description}`)
parts.push(`\n## TASK PLAN\n${planLines.join('\n')}\n_Advisory only — adapt to what you find on the page._`)
```

**After:**
```typescript
const planLines = taskPlan.steps.map((s, i) => {
  const marker = i < taskPlan.currentStep ? '✓' : i === taskPlan.currentStep ? '→' : '·'
  const actions = s.expectedActions.length > 0
    ? `\n   Fields: ${s.expectedActions.slice(0, 5).join(' | ')}${s.expectedActions.length > 5 ? '…' : ''}`
    : ''
  return `${marker} Step ${i + 1}: ${s.description}${actions}`
})
parts.push(`\n## TASK PLAN\n${planLines.join('\n')}\n_Adapt to actual page — field names may differ._`)
```

### Change 3: Cross-page wizard continuity in `buildFollowUpContext()` (lines 569–585)

Add after the task progress block (line 575):
```typescript
// Wizard continuity: if page changed (navigation detected) and we're in a form task
if (taskPlan && stateDiff && stateDiff.includes('navigat')) {
  const nextStep = taskPlan.steps[taskPlan.currentStep]
  if (nextStep) {
    parts.push(`\n⚠️ FORM PAGE ADVANCED: The form moved to a new page/step. All previous selectors are now invalid — do not retry them. Focus on the new fields visible below.${nextStep.expectedActions.length > 0 ? ` Expected fields on this step: ${nextStep.expectedActions.join(', ')}.` : ''}`)
  }
}
```

### Change 4: Improve FILL_FORM and decision rules in `buildActionReference()` (lines 452–472)

**Before:**
```typescript
{ syntax: '[ACTION:FILL_FORM assignments=\'[{"selector":"Email","value":"x@y.com","inputType":"text"}]\']',
  when: 'Fill multiple fields at once. Efficient for forms with many fields.',
  categories: ['fill_form'] },
{ syntax: '[ACTION:FORM_COACH]',
  when: 'Start guided step-by-step form filling with user approval.',
  categories: ['fill_form'] },
```

**After:**
```typescript
{ syntax: '[ACTION:FILL_FORM assignments=\'[{"selector":"Email","value":"x@y.com","inputType":"email"},{"selector":"Phone","value":"+1555000","inputType":"tel"},{"selector":"Country","value":"Germany","inputType":"select"}]\']',
  when: 'Fill 2+ fields at once. Use for simple forms where all values are known. inputType: text | email | tel | password | select | textarea | number',
  categories: ['fill_form'] },
{ syntax: '[ACTION:FORM_COACH]',
  when: 'Guided step-by-step form fill — user reviews and edits each field before it is filled. Use when: (1) form has sensitive fields (password, payment, medical), (2) user said "help me fill" or "guide me", (3) form has 6+ fields and values are uncertain.',
  categories: ['fill_form'] },
```

Add a decision rule block just above these in `buildActionReference()` for `fill_form` intent:
```typescript
if (intent.category === 'fill_form') {
  sections.push(`
## FORM FILLING — WHICH ACTION TO USE
- **2+ fields, values known, non-sensitive** → use FILL_FORM (batch, fastest)
- **Sensitive data (payment, SSN, passwords)** → use FORM_COACH (user reviews each field)
- **User asked to "guide" or "help me fill"** → use FORM_COACH
- **1 field only** → use TYPE directly
- **Wizard/multi-step form** → use sequential TYPE per field, then CLICK Next for each step
- **Unknown field values** → ask user before filling`)
}
```

## Acceptance Criteria
- [ ] AC1: On a single-page form, task plan shows: "→ Step 1: Fill 3 form fields (Step 1 of 1): Email | Password | Username"
- [ ] AC2: On a multi-step checkout ("Step 2 of 4" in page text), task plan shows "Step 1 of 4" and includes "Advance to next step" step
- [ ] AC3: When follow-up context detects page navigation within a form task, model receives the cross-page continuity warning
- [ ] AC4: Model uses FILL_FORM for batch-filling 3+ non-sensitive fields on first attempt
- [ ] AC5: Model uses FORM_COACH when user message contains "guide me" or "help me fill"
- [ ] AC6: Model does NOT retry selectors from a previous wizard step after advancing
- [ ] AC7: E2E test `06-form-filling.spec.ts` passes with real Gemini 2.5 Flash Lite

## Test Scenarios
- **Input:** "Fill the shipping form" — page is Step 2 of 3 checkout, has "First Name", "Last Name", "Address" fields
  **Expected plan:** Step 1: Fill 3 fields (Step 2 of 3): First Name | Last Name | Address → Step 2: Click Next
- **Input:** "Help me fill my job application"
  **Expected action:** `[ACTION:FORM_COACH]` not `[ACTION:FILL_FORM ...]`
- **Input:** "Fill in my email and click subscribe"
  **Expected:** `[ACTION:TYPE selector="Email" value="..."]` then `[ACTION:CLICK selector="Subscribe"]`
- **Follow-up round after clicking Next on wizard:**
  **Expected:** Follow-up context contains "FORM PAGE ADVANCED" warning

## Files to Modify
- `src/background/prompt-engine.ts` — `decomposeTask()` (L306–321), `buildBand2_PageUnderstanding()` task plan rendering (L773–780), `buildFollowUpContext()` (after L575), `buildActionReference()` FILL_FORM/FORM_COACH entries (L452–472)

## Token Impact
- Task plan with field names: +30–50 tokens per request when fill_form detected
- Cross-page warning: +40 tokens (only fires when navigation detected in form context)
- Decision rule block: +60 tokens (fill_form intent only)
- Net: **+80–130 tokens** on fill_form requests only

## Regression Risk
- `decomposeTask()` change: only affects fill_form + forms.length > 0 path. No other intent affected.
- `buildFollowUpContext()` change: gated on `taskPlan && stateDiff.includes('navigat')` — safe guard
- Ensure `pageSnapshot.buttons` is populated by the page extractor (verify `buttons` field exists on `PageSnapshot` type)

## Out of Scope
- UI changes to the Form Assist card
- Saving wizard step state across sessions
- Detecting wizard steps from URL patterns
