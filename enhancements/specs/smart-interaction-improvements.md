# Smart Interaction Improvements — Natural Language Understanding

**Slug:** smart-interaction-improvements
**Type:** Prompt Engineering + Feature
**Priority:** P0 (user-requested)
**Requested:** 2026-04-12
**Status:** SPECCED

## Summary

Enhance the AI's ability to understand natural, casual user requests like "fill this fields", "check this text", and "correct grammar of selected text". Add grammar correction to context menu, improve intent detection for ambiguous requests, and make the chat feel more intelligent and responsive.

## User Problem Statement

Currently, users must be precise with their language:
- ❌ "fill this fields" → AI doesn't understand which fields or context
- ❌ "check this text" → unclear if user wants grammar check, fact-check, or analysis
- ❌ Right-click selected text → no grammar correction option
- ❌ "make this better" → too vague, AI asks clarifying questions instead of inferring from context

**Desired behavior:**
- ✅ "fill this fields" → AI looks at page, identifies empty required fields, offers to fill them
- ✅ "check this text" → AI infers from context (grammar if it's editable text, facts if it's content)
- ✅ Right-click selected text → "Fix grammar" option appears
- ✅ "make this better" → AI improves clarity, grammar, and tone based on text type

## Root Cause Analysis

### Problem 1: Weak form filling intent detection
`src/background/prompt-engine.ts` lines 105:
```typescript
{ category: 'fill_form', pattern: /\b(fill|enter|type\s+in|ausfüllen|eingeben|eintragen|fill\s+(in|out)|complete\s+the\s+form)\b/i, confidence: 0.85 },
```
This pattern only catches explicit "fill form" commands, not casual variants like:
- "fill this" / "fill these"
- "complete this"
- "help me with this form"
- "enter my information"

### Problem 2: "Check" intent is too vague
Line 113 classifies "check" as `analyze`, but user intent varies:
- "check this text" on editable field = grammar/spelling check
- "check this text" on article = fact-check
- "check this" on form = validate completeness
- "check this" on button/link = test if it works

### Problem 3: No grammar correction in context menu
`src/background/service-worker.ts` lines 254-260 define context menu items:
- "Ask Orion about this"
- "Explain this"
- "Research this topic"

Missing:
- "Fix grammar/spelling"
- "Improve writing"
- "Check for errors"

### Problem 4: Intent detection doesn't consider page context
`classifyIntent()` (line 122-210) uses pattern matching but doesn't strongly weight:
- Page type (form vs article vs email composer)
- Element type (editable vs readonly)
- Selected text type (user-written vs webpage content)

## Desired Behavior

### Scenario 1: "Fill this fields" (casual form request)
**Before:**
- User: "fill this fields"
- AI: "Which fields would you like me to fill?"
- Requires clarification, breaks flow

**After:**
- User: "fill this fields"
- AI detects page has a form, classifies as `fill_form` intent
- AI: "I see a contact form with Name, Email, and Message fields. I'll fill these with your information."
- Automatically fills visible required fields

### Scenario 2: "Check this text" (context-aware analysis)
**Before:**
- User selects editable text, says "check this text"
- AI: "What should I check for?"

**After:**
- If text is in editable field (textarea, contenteditable):
  - AI: "I've checked your text for grammar and spelling. Here are 3 suggestions..."
  - Shows inline corrections
- If text is webpage content:
  - AI: "I've fact-checked the key claims in this text. Here's what I found..."

### Scenario 3: Grammar correction via context menu
**Before:**
- User right-clicks selected text
- No grammar option available
- Must type "fix grammar" manually

**After:**
- User right-clicks selected text
- Context menu shows: "Fix grammar & spelling"
- Click → AI corrects inline OR shows corrections in chat
- Option to replace original text directly

### Scenario 4: "Make this better" (smart improvement)
**Before:**
- User: "make this better"
- AI: "What would you like me to improve?"

**After:**
- AI detects text type and context:
  - Email draft → makes more professional/concise
  - Form description → makes clearer/more complete
  - Social media post → makes more engaging
  - Code comment → makes more descriptive
- Provides before/after comparison

## Implementation Design

### Part 1: Enhanced Intent Patterns (Prompt Engineering)

**File:** `src/background/prompt-engine.ts`

**Add new patterns at line 105:**

```typescript
const INTENT_PATTERNS: Array<{ category: IntentCategory; pattern: RegExp; confidence: number }> = [
  // Remember / memory (existing)
  { category: 'remember', pattern: /\b(remember|memorize|save\s+to\s+memory|add\s+to\s+.*memory|never\s+forget|from\s+now\s+on|always|merke?\s+dir)\b/i, confidence: 0.95 },

  // Fill form — ENHANCED with casual variants
  {
    category: 'fill_form',
    pattern: /\b(fill|enter|type\s+in|complete|ausfüllen|eingeben|eintragen|help\s+(me\s+)?with\s+(this|the)\s+form|fill\s+(this|these|the)\s+(field|form|input)|enter\s+my\s+(info|information|details))\b/i,
    confidence: 0.85
  },

  // Grammar/spelling check — NEW
  {
    category: 'analyze',
    pattern: /\b(check|fix|correct|improve)\s+(grammar|spelling|typo|writing|this\s+text|mistakes?|errors?)\b/i,
    confidence: 0.90
  },

  // Text improvement — NEW
  {
    category: 'compose',
    pattern: /\b(make\s+(this|it)\s+(better|clearer|more\s+professional|shorter|longer)|improve\s+(this|the)\s+(text|writing|message)|rewrite\s+this|polish\s+this)\b/i,
    confidence: 0.85
  },

  // Validation/verification — NEW
  {
    category: 'analyze',
    pattern: /\b(validate|verify|check\s+(if|whether)|is\s+this\s+(correct|right|valid|complete)|does\s+this\s+work)\b/i,
    confidence: 0.80
  },

  // ...rest of existing patterns
]
```

### Part 2: Context-Aware Intent Classification

**Add to `classifyIntent()` function (after line 191):**

```typescript
// Context-aware intent boosting
if (pageSnapshot) {
  const hasEditableFields = pageSnapshot.forms.some(f => f.fields?.length > 0)
  const hasTextarea = pageSnapshot.forms.some(f => f.fields?.some(field => field.type === 'textarea'))

  // Boost fill_form if user says "this" or "these" and page has forms
  if ((lower.includes('this') || lower.includes('these')) && hasEditableFields) {
    if (bestCategory === 'general' || bestCategory === 'interact') {
      bestCategory = 'fill_form'
      bestConfidence = 0.85
    }
  }

  // "Check this" on editable text = grammar check
  if (lower.match(/\b(check|fix|correct)\s+(this|it)\b/) && hasTextarea) {
    bestCategory = 'analyze'
    entities.analysisType = 'grammar'
    bestConfidence = 0.85
  }
}

// If user selected text and says "check/fix/improve", it's likely a text operation
if (pageSnapshot?.selectedText && pageSnapshot.selectedText.length > 10) {
  if (lower.match(/\b(check|fix|correct|improve|make\s+better|rewrite)\b/)) {
    const isUserWritten = pageSnapshot.selectedText.match(/[.!?]/) // has sentences = likely user-written
    if (isUserWritten) {
      bestCategory = 'compose' // Text improvement
      entities.textOperation = 'improve'
      entities.value = pageSnapshot.selectedText
    } else {
      bestCategory = 'analyze' // Analyze existing content
      entities.analysisType = 'fact-check'
    }
    bestConfidence = 0.85
  }
}
```

### Part 3: Add Grammar Correction to Context Menu

**File:** `src/background/service-worker.ts`

**Modify `setupContextMenus()` at line 253:**

```typescript
function setupContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    // Text operations (when text is selected)
    chrome.contextMenus.create({
      id: 'orion-fix-grammar',
      title: 'Fix grammar & spelling',
      contexts: ['selection', 'editable']
    })
    chrome.contextMenus.create({
      id: 'orion-improve',
      title: 'Improve writing',
      contexts: ['selection', 'editable']
    })
    chrome.contextMenus.create({ id: 'orion-separator-1', type: 'separator', contexts: ['selection'] })

    // Existing options
    chrome.contextMenus.create({ id: 'orion-ask', title: 'Ask Orion about this', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-explain', title: 'Explain this', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'orion-research', title: 'Research this topic', contexts: ['selection'] })

    chrome.contextMenus.create({ id: 'orion-separator-2', type: 'separator', contexts: ['all'] })

    // Page-level actions
    chrome.contextMenus.create({ id: 'orion-summarize', title: 'Summarize this page', contexts: ['page'] })
    chrome.contextMenus.create({ id: 'orion-fill', title: 'Fill this form with Orion', contexts: ['page', 'editable'] })
  })
}
```

**Add handlers in `chrome.contextMenus.onClicked.addListener()` at line 278:**

```typescript
switch (info.menuItemId) {
  case 'orion-fix-grammar':
    if (selectedText) {
      broadcastToPanel({
        type: 'CONTEXT_MENU_CHAT',
        text: `Fix grammar and spelling in this text:\n\n"${selectedText}"\n\nProvide corrected version.`,
        tabId,
        mode: 'grammar-fix'
      })
    }
    break

  case 'orion-improve':
    if (selectedText) {
      broadcastToPanel({
        type: 'CONTEXT_MENU_CHAT',
        text: `Improve the clarity, tone, and professionalism of this text:\n\n"${selectedText}"\n\nProvide rewritten version.`,
        tabId,
        mode: 'text-improve'
      })
    }
    break

  // ...existing cases
}
```

### Part 4: Smart Form Field Detection (Prompt Enhancement)

**File:** `src/background/prompt-engine.ts`

**Add to Band 2 domain persona section (around line 740):**

```typescript
// Smart form assistance guidance
if (intent.category === 'fill_form' && structuredContext.forms.length > 0) {
  parts.push(`
## SMART FORM FILLING GUIDANCE
The user wants help filling a form. Here's the intelligent approach:

1. **Identify required fields** (marked with *, required attribute, or validation messages)
2. **Infer user intent from page context:**
   - Contact form → use user's name, email from known data
   - Checkout form → use shipping/billing info
   - Login form → ask for credentials (don't guess)
   - Search form → use user's query from their message

3. **Handle ambiguity smartly:**
   - If user says "fill this" with multiple forms → ask which one
   - If user says "fill these fields" → fill visible fields only
   - If required info is missing → ask once, not field-by-field

4. **Validation awareness:**
   - Check field types (email, phone, date) and format correctly
   - Look for placeholder text showing expected format
   - Respect maxlength and pattern attributes

**Example:**
User: "fill this fields"
Page: Contact form with Name, Email, Phone (optional), Message (required)
You: "I'll fill the contact form with:
- Name: [user's name]
- Email: [user's email]
- Message: [ask user what message to include]"
`)
}
```

### Part 5: Grammar Check System Prompt

**Add new Band 1 action type for grammar checking:**

```typescript
// In buildActionReference() after existing actions
if (intent.category === 'analyze' && entities.analysisType === 'grammar') {
  sections.push(`
## GRAMMAR & SPELLING CHECK FORMAT
When checking grammar/spelling, respond with:

**Corrections found:** [number]

1. **Original:** "their going to the store"
   **Corrected:** "they're going to the store"
   **Reason:** Incorrect use of "their" (possessive) instead of "they're" (contraction)

2. **Original:** "I seen him yesterday"
   **Corrected:** "I saw him yesterday"
   **Reason:** Incorrect past tense verb form

**Summary:** [1-2 sentences about overall writing quality]
**Corrected full text:**
[full corrected version]
`)
}
```

## Acceptance Criteria

- [ ] AC1: User says "fill this fields" on a contact form → AI fills Name, Email without asking
- [ ] AC2: User says "check this text" while selecting editable text → AI checks grammar
- [ ] AC3: User right-clicks selected text → "Fix grammar & spelling" appears in context menu
- [ ] AC4: User says "make this better" on email draft → AI rewrites for clarity/professionalism
- [ ] AC5: User says "check if this is correct" on form → AI validates field values
- [ ] AC6: User says "help me with this form" → AI identifies form and offers to fill it
- [ ] AC7: User says "correct the grammar" → classified as `analyze` intent with `grammar` type
- [ ] AC8: Grammar corrections show original → corrected with explanations

## Test Scenarios

**Test 1: Casual form filling**
- Page: LinkedIn profile form (Name, Headline, About)
- User: "fill these"
- Expected: AI fills Name with user's actual name, asks for Headline and About
- NOT expected: "Which fields?" clarification question

**Test 2: Context-aware "check this"**
- Scenario A: User selects text in Gmail compose box, says "check this"
  - Expected: Grammar/spelling check with corrections
- Scenario B: User selects text in news article, says "check this"
  - Expected: Fact-checking of claims

**Test 3: Grammar correction via context menu**
- User types: "Their going too the store tommorow"
- User selects text, right-clicks → "Fix grammar & spelling"
- Expected AI response:
  ```
  Corrections found: 3

  1. "Their" → "They're" (wrong form of there/their/they're)
  2. "too" → "to" (incorrect word)
  3. "tommorow" → "tomorrow" (spelling)

  Corrected: "They're going to the store tomorrow"
  ```

**Test 4: Smart "make this better"**
- Email: "hey can u send me the report asap thx"
- User: "make this more professional"
- Expected: "Hi [Name], Could you please send me the report at your earliest convenience? Thank you."

**Test 5: Form validation**
- User fills email field with "john@"
- User: "check if this is correct"
- Expected: "The email address appears incomplete. Valid format is: name@domain.com"

## Files to Modify

1. **src/background/prompt-engine.ts**
   - Lines 99-120: Add enhanced intent patterns
   - Lines 170-195: Add context-aware intent boosting
   - Lines 460-480: Add grammar check action reference
   - Lines 720-750: Add smart form filling guidance

2. **src/background/service-worker.ts**
   - Lines 253-260: Add grammar/improve to context menu
   - Lines 278-299: Add context menu handlers

3. **src/shared/types.ts** (if needed)
   - Add `analysisType?: string` and `textOperation?: string` to UserIntent entities

## Token Impact

- Intent patterns: ~50 tokens additional
- Grammar check prompt section: ~150 tokens (only when triggered)
- Smart form guidance: ~200 tokens (only for fill_form intent)
- Net impact: ~50 tokens per request on average, ~400 tokens for grammar checks

## Regression Risk

**Low risk:**
- Additive changes (new patterns, new context menu items)
- Doesn't change existing intent patterns
- Fallback to 'general' category if no patterns match

**Medium risk:**
- Context-aware boosting might mis-classify some edge cases
- Need to test that existing form filling still works

## Open Questions

1. Should grammar corrections auto-replace the selected text, or just show in chat?
   - **Recommendation:** Show in chat by default, add "Replace" button
2. Should "fix grammar" work on readonly text (like articles)?
   - **Recommendation:** Yes, but explain it's for reference (can't edit the actual page)
3. What's the minimum text length for grammar checking?
   - **Recommendation:** 5 words minimum (avoid checking single words/phrases)

## Success Metrics

After implementation, measure:
1. **Intent classification accuracy** — % of casual requests correctly classified
2. **Grammar correction usage** — how often users use the context menu option
3. **Form filling success rate** — % of forms filled without clarification questions
4. **User satisfaction** — qualitative feedback on "smartness" of interactions

Target: 90%+ correct intent classification, 50%+ reduction in clarification questions
