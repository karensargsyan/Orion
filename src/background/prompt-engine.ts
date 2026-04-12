/**
 * Prompt Engine — comprehensive prompt pipeline that transforms user input into
 * optimized LLM prompts. Handles intent classification, query expansion, task
 * decomposition, token budget management, and final prompt assembly.
 */

import type { PageSnapshot } from '../shared/types'
import type { PageType, PageClassification, DomainPersona } from './page-persona'
import { classifyPage, getExpandedPersonaForPrompt, getDomainPersona } from './page-persona'
import { buildStructuredContext, formatForPrompt, type StructuredPageContext } from './page-context-builder'

// ─── Types ──────────────────────────────────────────────────────────────────

export type IntentCategory =
  | 'navigate'
  | 'search'
  | 'fill_form'
  | 'extract_info'
  | 'interact'
  | 'research'
  | 'analyze'
  | 'compose'
  | 'configure'
  | 'remember'
  | 'general'

export interface UserIntent {
  category: IntentCategory
  entities: {
    destination?: string
    query?: string
    fields?: string[]
    targetElement?: string
    value?: string
    analysisType?: string
    textOperation?: string
  }
  complexity: 'simple' | 'multi_step' | 'compound'
  confidence: number
}

export interface TaskPlan {
  steps: TaskStep[]
  currentStep: number
  fallbackStrategy: string
}

export interface TaskStep {
  description: string
  expectedActions: string[]
  successCriteria: string
}

export interface TokenBudget {
  systemCore: number
  persona: number
  pageContext: number
  a11yTree: number
  pageText: number
  memory: number
  skills: number
  taskPlan: number
  userInstructions: number
  sitemap: number
}

export interface PromptPipelineInput {
  userText: string
  pageSnapshot?: PageSnapshot
  accessibilityTree?: string
  viewportMeta?: { width: number; height: number; devicePixelRatio: number }
  memories: string
  skills: string
  behaviors: string
  instructions: string
  mempalace: string
  sitemap: string
  capabilities?: { supportsVision?: boolean }
  isLocal: boolean
  contextWindow: number
  liteMode: boolean
  knownUserData?: string
  explanationDepth?: 'quick' | 'standard' | 'deep'
  pinnedFacts?: string
  /** Additional tab contexts for cross-tab comparison (max 3) */
  additionalTabs?: Array<{ title: string; url: string; text: string }>
}

export interface PromptPipelineOutput {
  systemPrompt: string
  enhancedUserMessage: string
  intent: UserIntent
  taskPlan: TaskPlan | null
  tokenBudget: TokenBudget
  pageClassification: PageClassification
  structuredContext: StructuredPageContext
}

// ─── Intent Classification ──────────────────────────────────────────────────

const INTENT_PATTERNS: Array<{ category: IntentCategory; pattern: RegExp; confidence: number }> = [
  // Remember / memory
  { category: 'remember', pattern: /\b(remember|memorize|save\s+to\s+memory|add\s+to\s+.*memory|never\s+forget|from\s+now\s+on|always|merke?\s+dir)\b/i, confidence: 0.95 },
  // Grammar/spelling check — HIGH PRIORITY for user experience
  { category: 'analyze', pattern: /\b(check|fix|correct|improve)\s+(grammar|spelling|typo|writing|this\s+text|mistakes?|errors?)\b/i, confidence: 0.90 },
  // Navigate
  { category: 'navigate', pattern: /\b(go\s+to|open|navigate|visit|gehe?\s+zu|öffne|besuche?)\b/i, confidence: 0.85 },
  // Fill form — ENHANCED with casual variants
  { category: 'fill_form', pattern: /\b(fill|enter|type\s+in|complete|ausfüllen|eingeben|eintragen|help\s+(me\s+)?with\s+(this|the)\s+form|fill\s+(this|these|the)\s+(field|form|input)|enter\s+my\s+(info|information|details))\b/i, confidence: 0.85 },
  // Text improvement — NEW for "make this better"
  { category: 'compose', pattern: /\b(make\s+(this|it)\s+(better|clearer|more\s+professional|shorter|longer)|improve\s+(this|the)\s+(text|writing|message)|rewrite\s+this|polish\s+this)\b/i, confidence: 0.85 },
  // Compose (original)
  { category: 'compose', pattern: /\b(write|compose|draft|reply|respond|schreibe?|verfass|antwort)\b/i, confidence: 0.80 },
  // Validation/verification — NEW for "check if this is correct"
  { category: 'analyze', pattern: /\b(validate|verify|check\s+(if|whether)|is\s+this\s+(correct|right|valid|complete)|does\s+this\s+work)\b/i, confidence: 0.80 },
  // Search / find (travel, shopping, etc.)
  { category: 'search', pattern: /\b(suche?n?|find|search|flug|fl[üu]ge?|tickets?|book|buchen|finde|compare|vergleich|price|preis|hotel|cheapest|günstigste|billigste|kaufen?|shop|reise|travel|flight)\b/i, confidence: 0.80 },
  // Research (multi-tab)
  { category: 'research', pattern: /\b(research|recherche?|investigate|look\s+up|deep\s+dive|find\s+out|herausfinden)\b/i, confidence: 0.80 },
  // Analyze (general)
  { category: 'analyze', pattern: /\b(analy[sz]e?|report|bericht|summarize|zusammenfass|check|prüfe?|review|examine)\b/i, confidence: 0.75 },
  // Extract info (questions)
  { category: 'extract_info', pattern: /\b(what|how\s+much|how\s+many|when|where|who|which|show\s+me|tell\s+me|was\s+ist|wie\s+viel|wann|wo|wer|welche?)\b/i, confidence: 0.70 },
  // Interact
  { category: 'interact', pattern: /\b(click|press|tap|select|toggle|scroll|klicke?|drücke?|wähle?|mach|starte?|beginn|anfangen|durchführ|ausführ|absend|submit|continue|weiter|bestätig|confirm|run|execute|los)\b/i, confidence: 0.85 },
  // Configure
  { category: 'configure', pattern: /\b(set|change|update|config|setting|einstell|änder|aktualisier)\b/i, confidence: 0.70 },
]

export function classifyIntent(
  userText: string,
  pageType: PageType,
  pageSnapshot?: PageSnapshot
): UserIntent {
  // Guard against extremely large inputs that could hang regex operations
  const safeText = userText.length > 10_000 ? userText.slice(0, 10_000) : userText
  const lower = safeText.toLowerCase().trim()

  // URL in text → navigate (trim trailing punctuation from extracted URL)
  if (/https?:\/\/[^\s]+/.test(safeText)) {
    const url = safeText.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[.,;:!?)}\]]+$/, '')
    return {
      category: 'navigate',
      entities: { destination: url },
      complexity: 'simple',
      confidence: 0.95,
    }
  }

  // Pattern matching
  let bestCategory: IntentCategory = 'general'
  let bestConfidence = 0

  for (const { category, pattern, confidence } of INTENT_PATTERNS) {
    if (pattern.test(lower) && confidence > bestConfidence) {
      bestCategory = category
      bestConfidence = confidence
    }
  }

  // Entity extraction
  const entities: UserIntent['entities'] = {}

  // Extract destination for navigate intent
  if (bestCategory === 'navigate') {
    const dest = lower
      .replace(/\b(go\s+to|open|navigate\s+to|visit|gehe?\s+zu|öffne|besuche?)\b/gi, '')
      .trim()
    if (dest) entities.destination = dest
  }

  // Extract search query
  if (bestCategory === 'search' || bestCategory === 'research') {
    const query = userText
      .replace(/["""'']/g, '')
      .replace(/\b(bitte|please|kannst du|can you|ich möchte|i want|zeig mir|show me|finde|find|suche|search|book|buchen)\b/gi, '')
      .trim()
    if (query.length > 3) entities.query = query.slice(0, 150)
  }

  // Match user text against form field labels on the page
  if (pageSnapshot && pageSnapshot.forms.length > 0) {
    const matchedFields: string[] = []
    for (const form of pageSnapshot.forms) {
      for (const field of form.fields ?? []) {
        const label = (field.label || field.name || '').toLowerCase()
        if (label && lower.includes(label)) {
          matchedFields.push(field.label || field.name)
        }
      }
    }
    if (matchedFields.length > 0) {
      entities.fields = matchedFields
      // If user mentions form fields and we're on a page with forms, boost to fill_form
      if (bestCategory === 'general' || bestCategory === 'interact') {
        bestCategory = 'fill_form'
        bestConfidence = Math.max(bestConfidence, 0.80)
      }
    }
  }

  // Complexity assessment
  const complexity = assessComplexity(lower, bestCategory)

  return {
    category: bestCategory,
    entities,
    complexity,
    confidence: bestConfidence,
  }
}

function assessComplexity(text: string, category: IntentCategory): UserIntent['complexity'] {
  // Compound: multiple sub-goals joined by "and", "then", "after"
  const conjunctions = (text.match(/\b(and\s+then|then|after\s+that|und\s+dann|danach|anschließend|also)\b/gi) ?? []).length
  if (conjunctions >= 2) return 'compound'

  // Multi-step categories
  if (category === 'search' || category === 'research' || category === 'fill_form') return 'multi_step'

  // Count action verbs
  const actions = (text.match(/\b(click|type|fill|search|navigate|open|scroll|select|book|buy|send|write|compare|find)\b/gi) ?? []).length
  if (actions >= 3) return 'compound'
  if (actions >= 2 || conjunctions >= 1) return 'multi_step'

  return 'simple'
}

// ─── Query Expansion ────────────────────────────────────────────────────────

export function expandQuery(
  userText: string,
  intent: UserIntent,
  pageSnapshot?: PageSnapshot,
  pageType?: PageType
): string {
  // For simple intents or no page context, return raw text
  if (intent.complexity === 'simple' && intent.category !== 'fill_form') return userText
  if (!pageSnapshot) return userText

  const parts: string[] = [userText]

  // Add page-aware context for fill_form
  if (intent.category === 'fill_form' && pageSnapshot.forms.length > 0) {
    const emptyFields: string[] = []
    const filledFields: string[] = []
    for (const form of pageSnapshot.forms) {
      for (const field of form.fields ?? []) {
        const label = field.label || field.name || field.selector
        if (field.value && field.value.length > 0) {
          filledFields.push(`${label}="${field.value.slice(0, 30)}"`)
        } else {
          emptyFields.push(label)
        }
      }
    }
    if (emptyFields.length > 0) {
      parts.push(`\n[Page context: form has empty fields: ${emptyFields.join(', ')}${filledFields.length > 0 ? `. Already filled: ${filledFields.join(', ')}` : ''}]`)
    }
  }

  // Add strategy hint for search intent on matching pages
  if (intent.category === 'search' && pageType && pageType !== 'general') {
    const persona = getDomainPersona(pageType)
    if (persona && persona.taskTemplates) {
      // Find matching task template
      const query = (intent.entities.query ?? userText).toLowerCase()
      for (const [trigger, steps] of Object.entries(persona.taskTemplates)) {
        if (query.includes(trigger) || trigger.split(' ').some(w => query.includes(w))) {
          parts.push(`\n[Strategy: ${steps.join(' → ')}]`)
          break
        }
      }
    }
  }

  return parts.join('')
}

// ─── Task Decomposition ─────────────────────────────────────────────────────

export function decomposeTask(
  intent: UserIntent,
  pageSnapshot?: PageSnapshot,
  pageType?: PageType,
): TaskPlan | null {
  if (intent.complexity === 'simple') return null

  const persona = pageType ? getDomainPersona(pageType) : null
  const steps: TaskStep[] = []

  // Try to find a matching task template from the domain persona
  if (persona && persona.taskTemplates) {
    const query = (intent.entities.query ?? '').toLowerCase()
    for (const [trigger, templateSteps] of Object.entries(persona.taskTemplates)) {
      if (query.includes(trigger) || trigger.split(' ').some(w => w.length > 3 && query.includes(w))) {
        for (const step of templateSteps) {
          steps.push({
            description: step,
            expectedActions: [],  // AI decides the actual actions
            successCriteria: `${step} completed successfully`,
          })
        }
        return {
          steps,
          currentStep: 0,
          fallbackStrategy: 'If current approach fails, try alternative selectors or scroll to reveal hidden elements.',
        }
      }
    }
  }

  // Generic decomposition for multi-step tasks
  if (intent.category === 'fill_form' && pageSnapshot && pageSnapshot.forms.length > 0) {
    const form = pageSnapshot.forms[0]
    const emptyFields = (form.fields ?? []).filter(f => !f.value || f.value.length === 0)
    if (emptyFields.length > 0) {
      // Detect wizard/multi-step indicators from page text
      const pageText = (pageSnapshot.completePageText ?? '').toLowerCase()
      const stepMatch = pageText.match(/step\s+(\d+)\s+(?:of|\/)\s+(\d+)/i)
        ?? pageText.match(/(\d+)\s*\/\s*(\d+)\s*steps?/i)
      const hasNextButton = (pageSnapshot.buttons ?? []).some(b =>
        /^(next|continue|proceed|weiter|siguiente)$/i.test(b.text?.trim() ?? ''))
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

  if (intent.category === 'search' || intent.category === 'research') {
    steps.push(
      { description: 'Execute search', expectedActions: ['SEARCH or fill search form'], successCriteria: 'Search results loaded' },
      { description: 'Read results', expectedActions: ['Read page text or open result tabs'], successCriteria: 'Results analyzed' },
      { description: 'Synthesize findings', expectedActions: ['Summarize with sources'], successCriteria: 'Summary provided to user' },
    )
    return { steps, currentStep: 0, fallbackStrategy: 'If search returns no results, try broader terms or different search engine.' }
  }

  return null
}

// ─── Token Budget ───────────────────────────────────────────────────────────

export function allocateTokenBudget(
  intent: UserIntent,
  contextWindow: number,
  isLocal: boolean
): TokenBudget {
  // Reserve for output
  const outputReserve = isLocal ? 1024 : 4096
  const available = contextWindow - outputReserve

  if (isLocal) {
    // Compact budget for small models (8K)
    const base: TokenBudget = {
      systemCore: 800,
      persona: 200,
      pageContext: 600,
      a11yTree: 1000,
      pageText: 800,
      memory: 300,
      skills: 0,
      taskPlan: 200,
      userInstructions: 200,
      sitemap: 0,
    }
    return adjustByIntent(base, intent, available)
  }

  // Full budget for cloud models (32K-128K)
  const base: TokenBudget = {
    systemCore: 1200,
    persona: 600,
    pageContext: 1500,
    a11yTree: 3000,
    pageText: 3000,
    memory: 800,
    skills: 400,
    taskPlan: 400,
    userInstructions: 300,
    sitemap: 300,
  }
  return adjustByIntent(base, intent, available)
}

function adjustByIntent(base: TokenBudget, intent: UserIntent, available: number): TokenBudget {
  const budget = { ...base }

  switch (intent.category) {
    case 'extract_info':
      // Maximize page text, minimize interaction context
      budget.pageText = Math.floor(budget.pageText * 2)
      budget.a11yTree = Math.floor(budget.a11yTree * 0.3)
      budget.persona = Math.floor(budget.persona * 0.5)
      break

    case 'fill_form':
    case 'interact':
      // Maximize page context + a11y, reduce text
      budget.pageContext = Math.floor(budget.pageContext * 1.5)
      budget.a11yTree = Math.floor(budget.a11yTree * 1.5)
      budget.pageText = Math.floor(budget.pageText * 0.5)
      budget.persona = Math.floor(budget.persona * 1.3)
      break

    case 'navigate':
      // Maximize sitemap, minimize everything else
      budget.sitemap = Math.floor(budget.sitemap * 3)
      budget.pageText = Math.floor(budget.pageText * 0.3)
      budget.a11yTree = Math.floor(budget.a11yTree * 0.3)
      budget.memory = Math.floor(budget.memory * 0.5)
      break

    case 'search':
    case 'research':
      // Moderate everything, boost memory
      budget.memory = Math.floor(budget.memory * 1.5)
      budget.pageText = Math.floor(budget.pageText * 0.5)
      break

    case 'remember':
      // Minimal everything
      budget.pageText = 200
      budget.a11yTree = 0
      budget.sitemap = 0
      budget.skills = 0
      break

    case 'compose':
      // Moderate page text (for context), boost persona
      budget.persona = Math.floor(budget.persona * 1.5)
      budget.pageText = Math.floor(budget.pageText * 0.8)
      break
  }

  // Scale to fit available tokens
  const total = Object.values(budget).reduce((s, v) => s + v, 0)
  if (total > available) {
    const scale = available / total
    for (const key of Object.keys(budget) as (keyof TokenBudget)[]) {
      budget[key] = Math.floor(budget[key] * scale)
    }
  }

  return budget
}

// ─── Action Reference by Intent ─────────────────────────────────────────────

export function buildActionReference(intent: UserIntent, hasA11y: boolean): string {
  const sections: string[] = []

  // Always include: text selector explanation
  sections.push(`## ACTIONS — TEXT SELECTORS (most reliable)
Use visible text, labels, placeholders, or aria-labels as selectors:`)

  // Form filling decision rules (only for fill_form intent)
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

  // Prioritized action list based on intent
  const allActions: Array<{ syntax: string; when: string; categories: IntentCategory[] }> = [
    { syntax: '[ACTION:TYPE selector="label" value="text"]', when: 'Enter text in a field. Use the field\'s visible LABEL or placeholder.', categories: ['fill_form', 'interact', 'compose', 'search', 'general'] },
    { syntax: '[ACTION:CLICK selector="Button Text"]', when: 'Click a button, link, or interactive element by its visible text.', categories: ['fill_form', 'interact', 'navigate', 'search', 'general', 'extract_info'] },
    { syntax: '[ACTION:SELECT_OPTION selector="Dropdown" value="Option"]', when: 'Select from a dropdown/select menu. NOT for text inputs.', categories: ['fill_form', 'interact', 'configure', 'general'] },
    { syntax: '[ACTION:TOGGLE selector="Checkbox label" value="on|off"]', when: 'Toggle a checkbox or switch. Checks current state before clicking.', categories: ['fill_form', 'interact', 'configure', 'general'] },
    { syntax: '[ACTION:KEYPRESS key="Enter|Tab|Escape"]', when: 'Press a keyboard key. Use after TYPE to submit, or Tab to move to next field.', categories: ['fill_form', 'interact', 'search', 'general'] },
    { syntax: '[ACTION:FILL_FORM assignments=\'[{"selector":"Email","value":"x@y.com","inputType":"email"},{"selector":"Phone","value":"+1555000","inputType":"tel"},{"selector":"Country","value":"Germany","inputType":"select"}]\']', when: 'Fill 2+ fields at once. Use for simple forms where all values are known. inputType: text | email | tel | password | select | textarea | number', categories: ['fill_form'] },
    { syntax: '[ACTION:HOVER selector="text"]', when: 'Hover over element to reveal tooltip/dropdown.', categories: ['interact', 'general'] },
    { syntax: '[ACTION:DOUBLECLICK selector="text"]', when: 'Double-click to select word or open item.', categories: ['interact', 'general'] },
    { syntax: '[ACTION:NAVIGATE url="URL"]', when: 'Go to a specific URL in current tab.', categories: ['navigate', 'general'] },
    { syntax: '[ACTION:BACK] / [ACTION:FORWARD]', when: 'Browser back/forward navigation.', categories: ['navigate', 'general'] },
    { syntax: '[ACTION:SCROLL direction="down|up"]', when: 'Scroll the page to see more content.', categories: ['interact', 'extract_info', 'search', 'general'] },
    { syntax: '[ACTION:SCROLL_TO selector="text"]', when: 'Scroll to a specific element by its text.', categories: ['interact', 'fill_form', 'general'] },
    { syntax: '[ACTION:WAIT ms="1500"]', when: 'Wait for dynamic content to load.', categories: ['interact', 'fill_form', 'search', 'general'] },
    { syntax: '[ACTION:SEARCH query="terms"]', when: 'Google search. Use for finding information or websites.', categories: ['search', 'research', 'navigate', 'general'] },
    { syntax: '[ACTION:OPEN_TAB url="URL"]', when: 'Open a URL in a new background tab and read its content.', categories: ['research', 'search', 'general'] },
    { syntax: '[ACTION:RESEARCH_DONE]', when: 'Close all research tabs when done synthesizing.', categories: ['research', 'search'] },
    { syntax: '[ACTION:GET_PAGE_TEXT]', when: 'Get full text of the current page.', categories: ['extract_info', 'analyze', 'general'] },
    { syntax: '[ACTION:READ_PAGE filter="interactive"]', when: 'Get element IDs for complex pages (use text selectors first).', categories: ['interact', 'fill_form'] },
    { syntax: '[ACTION:SCREENSHOT]', when: 'Take a visual screenshot of the page.', categories: ['analyze', 'extract_info', 'general'] },
    { syntax: '[ACTION:FORM_COACH]', when: 'Guided step-by-step form fill — user reviews and edits each field before it is filled. Use when: (1) form has sensitive fields (password, payment, medical), (2) user said "help me fill" or "guide me", (3) form has 6+ fields and values are uncertain.', categories: ['fill_form'] },
  ]

  // Filter and order by intent relevance
  const relevant = allActions.filter(a => a.categories.includes(intent.category) || a.categories.includes('general'))
  const primary = relevant.filter(a => a.categories[0] === intent.category || a.categories.includes(intent.category))
  const secondary = relevant.filter(a => !primary.includes(a))

  for (const a of primary) {
    sections.push(`${a.syntax} — ${a.when}`)
  }

  if (secondary.length > 0) {
    sections.push('\nOther available actions:')
    for (const a of secondary.slice(0, 6)) {
      sections.push(`${a.syntax}`)
    }
  }

  // Selector tips — short reference (full sequence is in Band 1 SELECTOR STRATEGY above)
  sections.push(`
## SELECTOR ORDER (summary)
Visible text → Placeholder → Aria-label → CSS → Element ID (after READ_PAGE)
Use exact text from the page. If one fails, move to the next type — never retry the same.`)

  // Element IDs (after READ_PAGE)
  if (hasA11y) {
    sections.push(`
## ELEMENT IDs (only after READ_PAGE)
After calling READ_PAGE, you may use JSON: {"element_id": 5, "action": "click"}
But text selectors are preferred — element IDs can become stale.`)
  }

  // Grammar & spelling check format
  if (intent.category === 'analyze' && intent.entities.analysisType === 'grammar') {
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
[full corrected version]`)
  }

  return sections.join('\n')
}

// ─── Follow-Up Context Builder ──────────────────────────────────────────────

export function buildFollowUpContext(params: {
  resultSummary: string
  freshContext: string
  a11ySection: string
  extraPageText: string
  stateDiff: string
  verification: string
  failureInstructions: string
  palaceHints: string
  postScreenshot: boolean
  userIsActive: boolean
  round: number
  maxRounds: number
  mode: 'auto' | 'guided' | 'restricted'
  taskPlan?: TaskPlan | null
}): string {
  const { resultSummary, freshContext, a11ySection, extraPageText, stateDiff,
    verification, failureInstructions, palaceHints, postScreenshot, userIsActive,
    round, maxRounds, mode, taskPlan } = params

  const parts: string[] = []

  // Action results — always first
  parts.push(`Action results:\n${resultSummary}`)

  // State changes
  if (verification) parts.push(`\n${verification}`)
  if (stateDiff) parts.push(`\nELEMENT STATE CHANGES:\n${stateDiff}`)

  // Visual verification
  if (postScreenshot) parts.push('\nScreenshot attached — verify actions worked visually.')

  // Failure recovery
  if (failureInstructions) parts.push(`\n${failureInstructions}`)

  // Memory hints
  if (palaceHints) parts.push(palaceHints.slice(0, 1000))

  // User activity
  if (userIsActive) parts.push('\nUser is also interacting.')

  // Page state (skip in guided mode for lightweight context)
  if (mode !== 'guided' && freshContext) {
    parts.push(`\nUpdated page state:\n${freshContext}`)
  } else if (mode === 'guided' && freshContext) {
    parts.push(`\nPage: ${freshContext}`)
  }

  // A11y tree and page text (auto mode only)
  if (mode === 'auto') {
    if (a11ySection) parts.push(a11ySection)
    if (extraPageText) parts.push(`\n\nPage Content (excerpt):\n${extraPageText}`)
  }

  // Task progress
  if (taskPlan && taskPlan.currentStep < taskPlan.steps.length) {
    const step = taskPlan.steps[taskPlan.currentStep]
    const completed = taskPlan.steps.slice(0, taskPlan.currentStep).map((s, i) => `  ✓ Step ${i + 1}: ${s.description}`).join('\n')
    const current = `  → Step ${taskPlan.currentStep + 1}: ${step.description}`
    const remaining = taskPlan.steps.slice(taskPlan.currentStep + 1).map((s, i) => `  · Step ${taskPlan.currentStep + 2 + i}: ${s.description}`).join('\n')
    parts.push(`\nTask Progress:\n${completed ? completed + '\n' : ''}${current}${remaining ? '\n' + remaining : ''}`)
  }

  // Wizard continuity: if page changed (navigation detected) and we're in a form task
  if (taskPlan && stateDiff && stateDiff.includes('navigat')) {
    const nextStep = taskPlan.steps[taskPlan.currentStep]
    if (nextStep) {
      parts.push(`\n⚠️ FORM PAGE ADVANCED: The form moved to a new page/step. All previous selectors are now invalid — do not retry them. Focus on the new fields visible below.${nextStep.expectedActions.length > 0 ? ` Expected fields on this step: ${nextStep.expectedActions.join(', ')}.` : ''}`)
    }
  }

  // Mode-specific instructions
  const anyFailed = failureInstructions.length > 0
  if (mode === 'guided') {
    parts.push(`\nRound ${round}/${maxRounds}. The user is clicking elements you highlight. What should they do next? Give clear instructions.`)
  } else if (mode === 'restricted') {
    parts.push(`\nRound ${round}/${maxRounds}. ${anyFailed ? 'RETRY with a DIFFERENT approach.' : 'Act on the results above — do NOT repeat the same action.'}`)
  } else {
    parts.push(`\nRound ${round}/${maxRounds}. ${anyFailed ? 'RETRY with a DIFFERENT approach.' : 'Continue if more steps needed, or give a SHORT summary.'}`)
  }

  return parts.join('\n')
}

// ─── Prompt Pipeline ────────────────────────────────────────────────────────

export function buildPromptPipeline(input: PromptPipelineInput): PromptPipelineOutput {
  const { userText, pageSnapshot, accessibilityTree, viewportMeta, isLocal, contextWindow, liteMode } = input

  // 1. Classify the page
  const pageClassification = classifyPage(
    pageSnapshot?.url ?? '',
    pageSnapshot?.title ?? '',
    pageSnapshot?.headings ?? [],
    pageSnapshot?.completePageText ?? pageSnapshot?.pageText ?? ''
  )

  // 2. Classify the intent
  const intent = classifyIntent(userText, pageClassification.type, pageSnapshot)

  // 3. Allocate token budget
  const tokenBudget = allocateTokenBudget(intent, contextWindow, isLocal)

  // 4. Build structured page context
  const structuredContext = buildStructuredContext(pageSnapshot, intent)

  // 5. Decompose task if complex
  const taskPlan = decomposeTask(intent, pageSnapshot, pageClassification.type)

  // 6. Expand user query
  const enhancedUserMessage = expandQuery(userText, intent, pageSnapshot, pageClassification.type)

  // 7. Assemble system prompt
  const systemPrompt = liteMode
    ? assembleCompactPrompt(input, intent, tokenBudget, structuredContext, pageClassification)
    : assembleFullPrompt(input, intent, tokenBudget, structuredContext, pageClassification, taskPlan)

  return {
    systemPrompt,
    enhancedUserMessage,
    intent,
    taskPlan,
    tokenBudget,
    pageClassification,
    structuredContext,
  }
}

// ─── Prompt Assembly ────────────────────────────────────────────────────────

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * 3.5)
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

// ─── Band 1: Action Execution Framework ────────────────────────────────────

function buildBand1_ActionFramework(
  intent: UserIntent,
  hasA11y: boolean,
  _hasVision: boolean,
): string {
  const now = new Date().toLocaleString()
  const parts: string[] = []

  // Identity (compact — capabilities are discoverable, not listed)
  parts.push(`You are Orion — a fully autonomous AI browser assistant embedded as a Chrome extension. Current time: ${now}

You have an encrypted vault (PIN-protected AES-256), persistent memory, 33 browser action types (click, type, navigate, scroll, search, fill forms, open tabs, screenshot, and more — all via Chrome DevTools Protocol), voice input, tab groups, multi-step automation (up to 25 rounds), web research (multi-tab), clipboard history, calendar detection, and a command palette. You run locally via LM Studio or with the user's own cloud API key.

When asked about yourself, describe these capabilities. When filling forms, check vault data and page content BEFORE asking the user.`)

  // 6 Action Execution Rules
  parts.push(`
## ACTION EXECUTION RULES

### Rule 1: Actions Are Your Only Interface
[ACTION:...] tags are the ONLY way to interact with the page. Text alone does NOTHING.
- WRONG: "I'll click Submit" → nothing happens on the page
- WRONG: "I have clicked Submit" → this is a lie, nothing happened
- RIGHT: [ACTION:CLICK selector="Submit"] → this actually clicks the button
If you want something to happen, you MUST emit an [ACTION:...] tag.

### Rule 2: Never Repeat a Failed Approach
If an action failed or nothing changed after executing it:
1. Do NOT retry the same selector — it will fail again
2. Try a DIFFERENT selector: alternate text, CSS, aria-label, or element ID
3. After 2 failures: use [ACTION:READ_PAGE filter="interactive"] to see what actually exists
4. After 3 failures: use [ACTION:SCREENSHOT] to see the actual visual state
5. If still stuck: tell the user what you tried and ask for guidance
NEVER repeat the same action with the same selector more than once.

### Rule 3: Read Before Acting
Page content is provided below. Answer questions DIRECTLY from it.
- Do NOT emit [ACTION:GET_PAGE_TEXT] when the answer is already in Page Content below
- Do NOT emit read actions just to "check" — the page state is already provided
- DO emit read actions only when you need content not visible in the provided excerpt

### Rule 4: Verify After Acting
After actions that change page state (submit, navigate, toggle, delete):
- Check that the page actually changed as expected
- If nothing changed: the action hit the wrong element — try a different approach
- After navigation: previous selectors are INVALID on the new page — re-read before acting

### Rule 5: Completion Signal
Include {"is_complete": true} ONLY when ALL requested work is genuinely finished.
- NEVER as your first or only response
- NEVER before performing the requested actions
- NEVER when actions failed and the task isn't done
- If you cannot complete the task, explain why — do not signal complete

### Rule 6: Be Autonomous, Not Reckless
- Chain actions across multiple rounds until the task is done
- Only ask permission for: purchases, deletions, sending messages, financial transactions
- For everything else (clicking, typing, navigating, scrolling): just do it
- If stuck after exhausting approaches: report clearly what you tried and what went wrong`)

  // Selector Strategy (replaces scattered tips)
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

  // Action reference (filtered by intent — existing function)
  parts.push(`\n${buildActionReference(intent, hasA11y)}`)

  // Compact domain knowledge
  parts.push(`
## TOGGLES & CHECKBOXES
Check [State: ON/OFF] before toggling. Use TOGGLE action.

## WEB RESEARCH
1. [ACTION:SEARCH query="..."] 2. [ACTION:OPEN_TAB url="..."] 3. Synthesize 4. [ACTION:RESEARCH_DONE]
Cite sources and dates.

## USER WIDGETS
Choices: [CHOICE:id="id"] Option A | Option B [/CHOICE]
Confirmations: [CONFIRM:id="id"] Button Label [/CONFIRM]

## SECURITY
Analyze emails/messages for phishing: urgency, mismatched domains, credential requests, suspicious links.`)

  return parts.join('\n')
}

// ─── Band 2: Page Understanding ────────────────────────────────────────────

function buildBand2_PageUnderstanding(
  input: PromptPipelineInput,
  intent: UserIntent,
  budget: TokenBudget,
  ctx: StructuredPageContext,
  classification: PageClassification,
  taskPlan: TaskPlan | null,
): string {
  const hasA11yTree = !!input.accessibilityTree
  const hasVision = input.capabilities?.supportsVision ?? false
  const parts: string[] = []

  // Expert persona (expanded with domain strategies)
  if (budget.persona > 0 && classification.type !== 'general') {
    const personaBlock = getExpandedPersonaForPrompt(
      input.pageSnapshot?.url ?? '',
      input.pageSnapshot?.title ?? '',
      input.pageSnapshot?.headings ?? [],
      input.pageSnapshot?.completePageText ?? '',
      intent.category,
      budget.persona
    )
    if (personaBlock) parts.push(`\n${personaBlock}`)
  }

  // Task guidance
  if (intent.category !== 'general' && intent.category !== 'remember' && ctx.affordances.length > 0) {
    parts.push(`\n## TASK GUIDANCE
The user wants to: **${intent.category.replace(/_/g, ' ')}**.
${ctx.primaryWorkflow}
${ctx.affordances.length > 0 ? `Available actions on this page: ${ctx.affordances.join(', ')}.` : ''}`)
  }

  // Smart form filling guidance
  if (intent.category === 'fill_form' && ctx.flows.length > 0) {
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
- Message: [ask user what message to include]"`)
  }

  // Task plan (advisory)
  if (taskPlan && taskPlan.steps.length > 0 && budget.taskPlan > 0) {
    const planLines = taskPlan.steps.map((s, i) => {
      const marker = i < taskPlan.currentStep ? '✓' : i === taskPlan.currentStep ? '→' : '·'
      const actions = s.expectedActions.length > 0
        ? `\n   Fields: ${s.expectedActions.slice(0, 5).join(' | ')}${s.expectedActions.length > 5 ? '…' : ''}`
        : ''
      return `${marker} Step ${i + 1}: ${s.description}${actions}`
    })
    const planSection = truncateToTokens(
      `\n## TASK PLAN\n${planLines.join('\n')}\n_Adapt to actual page — field names may differ._`,
      budget.taskPlan
    )
    parts.push(planSection)
  }

  // Accessibility tree
  if (hasA11yTree && budget.a11yTree > 0) {
    const treeText = truncateToTokens(input.accessibilityTree!, budget.a11yTree)
    parts.push(`\n## ACCESSIBILITY TREE${input.viewportMeta ? ` (Viewport: ${input.viewportMeta.width}x${input.viewportMeta.height})` : ''}\n${treeText}`)
  }

  // Vision
  if (hasVision) {
    parts.push(`\n## VISION\nScreenshot attached for visual layout.${input.viewportMeta ? ` Viewport: ${input.viewportMeta.width}x${input.viewportMeta.height} px.` : ''}`)
  }

  // Structured page context
  const formattedContext = formatForPrompt(ctx, input.pageSnapshot, budget.pageContext)
  parts.push(`\n## Current Page State\n${formattedContext}`)

  // Page text
  if (budget.pageText > 0) {
    const pageText = input.pageSnapshot?.completePageText ?? input.pageSnapshot?.pageText ?? ''
    if (pageText) {
      const truncated = truncateToTokens(pageText, budget.pageText)
      parts.push(`\n## Page Content\nFull text content of the current page. READ THIS to answer questions. Do NOT issue read actions when the answer is here.\n\n${truncated}`)
    }
  }

  return parts.join('\n')
}

// ─── Band 3: Output Formatting (cloud models only) ─────────────────────────

function buildBand3_OutputFormatting(depth?: string): string {
  const parts: string[] = []

  parts.push(`
## CORE RESPONSE RULES
1. **Use Markdown.** Format with **bold**, bullet lists, headings. No raw HTML. No emoji.
2. **Answer first, evidence second, actions third.** Lead with the direct answer. Follow with supporting details. Offer actions last.
3. **Date your information.** When citing memory, state the date. When citing research, note it is current.

## SOURCE GROUNDING (REQUIRED)
End EVERY informational response with source tags:
- [SOURCE:page] — from current page content
- [SOURCE:selection] — from user's selected text
- [SOURCE:visible] — from visible viewport only
- [SOURCE:memory] — from prior conversation or session memory
- [SOURCE:general] — general knowledge not from the page
- [SOURCE:stale] — may be based on outdated page context
Always include at least one source tag. If mixed sources, include all relevant tags.

## MESSAGE TYPE MARKERS
Mark message type at the start when applicable:
- [MSG_TYPE:warning] — warnings, caution alerts, risk notices
- [MSG_TYPE:clarification] — need user clarification before proceeding
- [MSG_TYPE:system] — status updates or system messages
Do NOT use these for normal answers.

## PAGE REFERENCES
Reference page elements with REF tags: [REF:css-selector]descriptive label[/REF]
Example: [REF:#submit-btn]Submit button[/REF]

## STRUCTURED EXTRACTION
Extract structured data with EXTRACT tags:
[EXTRACT title="Title"]
Key: Value
[/EXTRACT]

## STRUCTURED COMPARISON
Compare options with COMPARE tags:
[COMPARE title="Title"]
Criteria|Option A|Option B
Price|$10/mo|$20/mo
> Recommendation: ...
[/COMPARE]

## FOLLOW-UP SUGGESTIONS
Suggest 2-4 follow-up actions: [FOLLOWUP]Option 1|Option 2|Option 3[/FOLLOWUP]

## PINNED FACTS
Pin values for comparison: [PIN]Label: Value[/PIN]

## JARGON AND TERMINOLOGY
When content contains legal, technical, financial, or medical jargon:
- Define unfamiliar terms inline with "in other words" or "this means"
- For legal/policy pages: translate to plain language
- For technical docs: provide analogies when helpful

## "WHY" REASONING MODE
When user asks "why can't I...?", "why is this disabled?", "what's blocking me?":
1. Inspect form state: required fields, disabled buttons, validation messages
2. Check for hidden blockers: modals, overlays, JS validation
3. Present each blocker with a [REF] to the relevant element
4. Suggest specific fixes and offer to help

## CLARIFICATION POLICY
Ask only when: target ambiguity is high, action is risky/irreversible, or context is missing.
Present constrained choices, not open questions:
- "I found 3 'Continue' buttons. Which one: [REF:.checkout-btn]Checkout[/REF], [REF:.next-step]Next Step[/REF]?"

## UNCERTAINTY AND TRANSPARENCY
Be explicit about analysis limitations:
- State if you only scanned visible content
- State if the page has dynamic/lazy-loaded content
- State if multiple matches exist
- State if the page requires login or has gated content
Never present uncertain information as definitive.`)

  // Explanation depth
  const d = depth || 'standard'
  if (d === 'quick') {
    parts.push(`\n## EXPLANATION DEPTH: QUICK\nKeep answers to 1-3 sentences maximum. Answer directly, skip details.`)
  } else if (d === 'deep') {
    parts.push(`\n## EXPLANATION DEPTH: DEEP\nProvide thorough explanations with definitions, step-by-step breakdowns, examples, references, and caveats.`)
  }

  return parts.join('\n')
}

// ─── Band 4: Extended Context ──────────────────────────────────────────────

function buildBand4_ExtendedContext(
  input: PromptPipelineInput,
  budget: TokenBudget,
): string {
  const parts: string[] = []

  // Sitemap
  if (input.sitemap && budget.sitemap > 0) {
    parts.push(`\n## SITE MAP\n${truncateToTokens(input.sitemap, budget.sitemap)}`)
  }

  // Known user data
  if (input.knownUserData) {
    parts.push(`\n## Known User Data\n${input.knownUserData}`)
  }

  // Pinned facts
  if (input.pinnedFacts) parts.push(`\n${input.pinnedFacts}`)

  // Domain skills, behaviors, instructions
  if (input.skills && budget.skills > 0) parts.push(`\n${truncateToTokens(input.skills, budget.skills)}`)
  if (input.behaviors) parts.push(`\n${input.behaviors}`)
  if (input.instructions && budget.userInstructions > 0) parts.push(`\n${truncateToTokens(input.instructions, budget.userInstructions)}`)

  // Additional tab contexts (cross-tab compare)
  if (input.additionalTabs && input.additionalTabs.length > 0) {
    const tabParts = input.additionalTabs.slice(0, 3).map((t, i) => {
      const truncText = truncateToTokens(t.text, 2000)
      return `### Tab ${i + 2}: ${t.title}\nURL: ${t.url}\n${truncText}`
    })
    parts.push(`\n## Additional Tab Contexts\nContent from other tabs for comparison or reference.\n${tabParts.join('\n\n')}`)
  }

  // MemPalace (long-term memory)
  if (input.mempalace && budget.memory > 0) {
    parts.push(`\n## MemPalace (long-term memory — check dates)\n${truncateToTokens(input.mempalace, Math.floor(budget.memory * 0.6))}`)
  }

  // Recent context
  if (input.memories && budget.memory > 0) {
    parts.push(`\n## Recent Context (entries prefixed with [date])\n${truncateToTokens(input.memories, Math.floor(budget.memory * 0.4))}`)
  }

  return parts.join('\n')
}

// ─── Prompt Assembly ────────────────────────────────────────────────────────

function assembleFullPrompt(
  input: PromptPipelineInput,
  intent: UserIntent,
  budget: TokenBudget,
  ctx: StructuredPageContext,
  classification: PageClassification,
  taskPlan: TaskPlan | null,
): string {
  const hasA11yTree = !!input.accessibilityTree
  const hasVision = input.capabilities?.supportsVision ?? false

  const parts: string[] = []

  // Band 1: Action Execution Framework (always included)
  parts.push(buildBand1_ActionFramework(intent, hasA11yTree, hasVision))

  // Band 2: Page Understanding (always included)
  parts.push(buildBand2_PageUnderstanding(input, intent, budget, ctx, classification, taskPlan))

  // Band 3: Output Formatting (cloud models only — local models skip this)
  if (!input.isLocal) {
    parts.push(buildBand3_OutputFormatting(input.explanationDepth))
  }

  // Band 4: Extended Context (variable by budget)
  parts.push(buildBand4_ExtendedContext(input, budget))

  return parts.join('\n').trim()
}

function assembleCompactPrompt(
  input: PromptPipelineInput,
  intent: UserIntent,
  budget: TokenBudget,
  ctx: StructuredPageContext,
  classification: PageClassification,
): string {
  const hasA11yTree = !!input.accessibilityTree
  const hasVision = input.capabilities?.supportsVision ?? false

  const parts: string[] = []

  // Band 1: Action Execution Framework (IDENTICAL to full prompt)
  parts.push(buildBand1_ActionFramework(intent, hasA11yTree, hasVision))

  // Band 2: Page Understanding (same structure, budget-limited)
  parts.push(buildBand2_PageUnderstanding(input, intent, budget, ctx, classification, null))

  // Skip Band 3 (output formatting) — local models don't need formatting instructions
  // Skip Band 4 (extended context) — doesn't fit in small context windows

  // Include lightweight essentials only
  if (input.pinnedFacts) parts.push(`\n${input.pinnedFacts}`)
  if (input.instructions && budget.userInstructions > 0) {
    parts.push(`\n${truncateToTokens(input.instructions, budget.userInstructions)}`)
  }

  return parts.join('\n').trim()
}


// ─── Context Stack Inspector (V3: FR-V3-2) ─────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface ContextSource {
  name: string
  type: 'page' | 'memory' | 'system' | 'user'
  tokens: number
  enabled: boolean
  preview: string
}

export function getContextSources(input: PromptPipelineInput): ContextSource[] {
  const sources: ContextSource[] = []

  // Page context
  const pageText = input.pageSnapshot?.completePageText ?? input.pageSnapshot?.pageText ?? ''
  sources.push({
    name: 'Page content',
    type: 'page',
    tokens: estimateTokens(pageText),
    enabled: !!pageText,
    preview: pageText.slice(0, 200),
  })

  // Selected text
  const selText = input.pageSnapshot?.selectedText ?? ''
  sources.push({
    name: 'Selected text',
    type: 'page',
    tokens: estimateTokens(selText),
    enabled: !!selText,
    preview: selText.slice(0, 200),
  })

  // Accessibility tree
  const a11y = input.accessibilityTree ?? ''
  sources.push({
    name: 'Accessibility tree',
    type: 'page',
    tokens: estimateTokens(a11y),
    enabled: !!a11y,
    preview: a11y.slice(0, 200),
  })

  // Pinned facts
  const pins = input.pinnedFacts ?? ''
  sources.push({
    name: 'Pinned facts',
    type: 'user',
    tokens: estimateTokens(pins),
    enabled: !!pins,
    preview: pins.slice(0, 200),
  })

  // Additional tabs
  const tabs = input.additionalTabs ?? []
  sources.push({
    name: `Additional tabs (${tabs.length})`,
    type: 'page',
    tokens: tabs.reduce((sum, t) => sum + estimateTokens(t.text), 0),
    enabled: tabs.length > 0,
    preview: tabs.map(t => t.title).join(', ').slice(0, 200),
  })

  // Session memory
  sources.push({
    name: 'Session memory',
    type: 'memory',
    tokens: estimateTokens(input.memories),
    enabled: !!input.memories,
    preview: input.memories.slice(0, 200),
  })

  // Domain skills
  sources.push({
    name: 'Domain skills',
    type: 'memory',
    tokens: estimateTokens(input.skills),
    enabled: !!input.skills,
    preview: input.skills.slice(0, 200),
  })

  // Learned behaviors
  sources.push({
    name: 'Learned behaviors',
    type: 'memory',
    tokens: estimateTokens(input.behaviors),
    enabled: !!input.behaviors,
    preview: input.behaviors.slice(0, 200),
  })

  // User instructions
  sources.push({
    name: 'User instructions',
    type: 'user',
    tokens: estimateTokens(input.instructions),
    enabled: !!input.instructions,
    preview: input.instructions.slice(0, 200),
  })

  // Sitemap
  sources.push({
    name: 'Site map',
    type: 'page',
    tokens: estimateTokens(input.sitemap),
    enabled: !!input.sitemap,
    preview: input.sitemap.slice(0, 200),
  })

  // MemPalace
  sources.push({
    name: 'MemPalace',
    type: 'memory',
    tokens: estimateTokens(input.mempalace),
    enabled: !!input.mempalace,
    preview: input.mempalace.slice(0, 200),
  })

  // Known user data
  const kud = input.knownUserData ?? ''
  sources.push({
    name: 'Known user data',
    type: 'user',
    tokens: estimateTokens(kud),
    enabled: !!kud,
    preview: kud.slice(0, 200),
  })

  return sources
}
