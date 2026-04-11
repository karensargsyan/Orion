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
  // Navigate
  { category: 'navigate', pattern: /\b(go\s+to|open|navigate|visit|gehe?\s+zu|öffne|besuche?)\b/i, confidence: 0.85 },
  // Fill form
  { category: 'fill_form', pattern: /\b(fill|enter|type\s+in|ausfüllen|eingeben|eintragen|fill\s+(in|out)|complete\s+the\s+form)\b/i, confidence: 0.85 },
  // Compose
  { category: 'compose', pattern: /\b(write|compose|draft|reply|respond|schreibe?|verfass|antwort)\b/i, confidence: 0.80 },
  // Search / find (travel, shopping, etc.)
  { category: 'search', pattern: /\b(suche?n?|find|search|flug|fl[üu]ge?|tickets?|book|buchen|finde|compare|vergleich|price|preis|hotel|cheapest|günstigste|billigste|kaufen?|shop|reise|travel|flight)\b/i, confidence: 0.80 },
  // Research (multi-tab)
  { category: 'research', pattern: /\b(research|recherche?|investigate|look\s+up|deep\s+dive|find\s+out|herausfinden)\b/i, confidence: 0.80 },
  // Analyze
  { category: 'analyze', pattern: /\b(analy[sz]e?|report|bericht|summarize|zusammenfass|check|prüfe?|review|examine)\b/i, confidence: 0.75 },
  // Extract info (questions)
  { category: 'extract_info', pattern: /\b(what|how\s+much|how\s+many|when|where|who|which|show\s+me|tell\s+me|was\s+ist|wie\s+viel|wann|wo|wer|welche?)\b/i, confidence: 0.70 },
  // Interact
  { category: 'interact', pattern: /\b(click|press|tap|select|toggle|scroll|klicke?|drücke?|wähle?)\b/i, confidence: 0.85 },
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

  // Prioritized action list based on intent
  const allActions: Array<{ syntax: string; when: string; categories: IntentCategory[] }> = [
    { syntax: '[ACTION:TYPE selector="label" value="text"]', when: 'Enter text in a field. Use the field\'s visible LABEL or placeholder.', categories: ['fill_form', 'interact', 'compose', 'search', 'general'] },
    { syntax: '[ACTION:CLICK selector="Button Text"]', when: 'Click a button, link, or interactive element by its visible text.', categories: ['fill_form', 'interact', 'navigate', 'search', 'general', 'extract_info'] },
    { syntax: '[ACTION:SELECT_OPTION selector="Dropdown" value="Option"]', when: 'Select from a dropdown/select menu. NOT for text inputs.', categories: ['fill_form', 'interact', 'configure', 'general'] },
    { syntax: '[ACTION:TOGGLE selector="Checkbox label" value="on|off"]', when: 'Toggle a checkbox or switch. Checks current state before clicking.', categories: ['fill_form', 'interact', 'configure', 'general'] },
    { syntax: '[ACTION:KEYPRESS key="Enter|Tab|Escape"]', when: 'Press a keyboard key. Use after TYPE to submit, or Tab to move to next field.', categories: ['fill_form', 'interact', 'search', 'general'] },
    { syntax: '[ACTION:FILL_FORM assignments=\'[{"selector":"Email","value":"x@y.com","inputType":"text"}]\']', when: 'Fill multiple fields at once. Efficient for forms with many fields.', categories: ['fill_form'] },
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
    { syntax: '[ACTION:FORM_COACH]', when: 'Start guided step-by-step form filling with user approval.', categories: ['fill_form'] },
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

  // Selector tips
  sections.push(`
## SELECTOR TIPS
- Use the field's VISIBLE LABEL: selector="Where from?", selector="Passengers"
- Use placeholder text: selector="Search", selector="Enter your email"
- Use button text: selector="Search flights", selector="Submit"
- Use CSS only as last resort: selector="input[name=q]"
- NEVER describe the page — emit the action immediately
- If an action fails, try a DIFFERENT selector (CSS, aria-label, etc.)`)

  // Element IDs (after READ_PAGE)
  if (hasA11y) {
    sections.push(`
## ELEMENT IDs (only after READ_PAGE)
After calling READ_PAGE, you may use JSON: {"element_id": 5, "action": "click"}
But text selectors are preferred — element IDs can become stale.`)
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

function assembleFullPrompt(
  input: PromptPipelineInput,
  intent: UserIntent,
  budget: TokenBudget,
  ctx: StructuredPageContext,
  classification: PageClassification,
  taskPlan: TaskPlan | null,
): string {
  const now = new Date().toLocaleString()
  const hasVision = input.capabilities?.supportsVision ?? false
  const hasA11yTree = !!input.accessibilityTree

  const parts: string[] = []

  // 1. Header
  parts.push(`You are Orion — a fully autonomous AI browser assistant. Current time: ${now}

## YOUR CAPABILITIES
You are a Chrome extension with these features:
- **Chat**: Natural language sidebar chat — answer questions, give advice, execute browser actions
- **Form Filling**: Read forms, classify fields, fill from encrypted vault data, or generate appropriate values. Use FILL_FORM for batch fill, FORM_COACH for step-by-step guided fill, or TYPE for individual fields
- **Encrypted Vault**: PIN-protected AES-256 storage for credentials, addresses, cards, contacts, identities. Always check vault before asking users for personal data
- **Web Research**: Open background tabs, search Google, read multiple pages, synthesize findings with sources
- **Page Analysis**: Read any page via accessibility tree + full text extraction. Classify 17 page types (email, shopping, travel, banking, social media, etc.)
- **33 Action Types**: Click, type, navigate, scroll, search, open/close tabs, fill forms, toggle, select, screenshot, hover, double-click, key press, and more — all via Chrome DevTools Protocol
- **Memory**: Per-tab memory, per-domain knowledge, global user instructions, optional MemPalace long-term memory
- **Tab Groups**: Color-coded groups, pause/resume groups, manage multiple concurrent sessions
- **Workflows**: Multi-step automation up to 25 rounds per request with visual verification
- **Voice Input**: Speech-to-text via Web Speech API or local Whisper model
- **Privacy First**: Runs 100% locally via LM Studio — zero data leaves the machine. Cloud mode sends data only to user's chosen provider
- **Clipboard Manager**: Records and searches clipboard history
- **Calendar Detection**: Detects calendar events with .ics export
- **Command Palette**: Quick access via Alt+Space

When asked about yourself, describe these capabilities confidently. You ARE Orion.
When filling forms, ALWAYS check if the answer is already available in page content, vault data, memory, or can be derived from context BEFORE asking the user.`)

  // 2. Expert persona (expanded with strategies)
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

  // 3. Task-aligned guidance (NEW — connects intent to page capabilities)
  if (intent.category !== 'general' && intent.category !== 'remember' && ctx.affordances.length > 0) {
    const guidance = `\n## TASK GUIDANCE
The user wants to: **${intent.category.replace(/_/g, ' ')}**.
${ctx.primaryWorkflow}
${ctx.affordances.length > 0 ? `Available actions on this page: ${ctx.affordances.join(', ')}.` : ''}`
    parts.push(guidance)
  }

  // 4. Core principles
  parts.push(`
## CORE PRINCIPLES
1. **READ first, ACT second.** The page content is provided below. Answer questions directly from it — do NOT issue read actions when the answer is already there.
2. **ACT, don't describe.** When asked to do something, DO IT with actions. Never narrate.
3. **Be autonomous.** Chain actions across rounds until COMPLETE. Only ask permission for destructive/financial actions.
4. **Recover from failures.** If an action fails, try a different approach immediately.
5. **Verify results.** After important actions, check the page changed as expected.
6. **Date your information.** When citing memory, state the date. When citing research, note it is current.
7. **Use Markdown.** Format with **bold**, bullet lists, headings. No raw HTML. No emoji.`)

  // 5. Action reference (prioritized by intent)
  parts.push(`\n${buildActionReference(intent, hasA11yTree)}`)

  // 6. Workflow
  parts.push(`
## WORKFLOW
1. **READ**: Page content is below. If you need more, use GET_PAGE_TEXT.
2. **ACT**: Use text selectors. Emit actions immediately.
3. **VERIFY**: Check results. If a selector failed, try a different one.
4. **COMPLETE**: When done, include {"is_complete": true} in your response.`)

  // 7. Task plan
  if (taskPlan && taskPlan.steps.length > 0 && budget.taskPlan > 0) {
    const planLines = taskPlan.steps.map((s, i) => `${i + 1}. ${s.description}`)
    const planSection = truncateToTokens(
      `\n## TASK PLAN\nFollow these steps:\n${planLines.join('\n')}\nThis plan is advisory — adapt if the page differs from expectations.`,
      budget.taskPlan
    )
    parts.push(planSection)
  }

  // 8. Toggles, research, widgets, security (compact)
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

  // 9. Accessibility tree
  if (hasA11yTree && budget.a11yTree > 0) {
    const treeText = truncateToTokens(input.accessibilityTree!, budget.a11yTree)
    parts.push(`\n## ACCESSIBILITY TREE${input.viewportMeta ? ` (Viewport: ${input.viewportMeta.width}x${input.viewportMeta.height})` : ''}\n${treeText}`)
  }

  // 10. Vision
  if (hasVision) {
    parts.push(`\n## VISION\nScreenshot attached for visual layout.${input.viewportMeta ? ` Viewport: ${input.viewportMeta.width}x${input.viewportMeta.height} px.` : ''}`)
  }

  // 11. Sitemap
  if (input.sitemap && budget.sitemap > 0) {
    parts.push(`\n## SITE MAP\n${truncateToTokens(input.sitemap, budget.sitemap)}`)
  }

  // 12. Known user data
  if (input.knownUserData) {
    parts.push(`\n## Known User Data\n${input.knownUserData}`)
  }

  // 13. Domain skills, behaviors, instructions
  if (input.skills && budget.skills > 0) parts.push(`\n${truncateToTokens(input.skills, budget.skills)}`)
  if (input.behaviors) parts.push(`\n${input.behaviors}`)
  if (input.instructions && budget.userInstructions > 0) parts.push(`\n${truncateToTokens(input.instructions, budget.userInstructions)}`)

  // 14. Structured page context (replaces flat tabState.summarize)
  const formattedContext = formatForPrompt(ctx, input.pageSnapshot, budget.pageContext)
  parts.push(`\n## Current Page State\n${formattedContext}`)

  // 15. Page text
  if (budget.pageText > 0) {
    const pageText = input.pageSnapshot?.completePageText ?? input.pageSnapshot?.pageText ?? ''
    if (pageText) {
      const truncated = truncateToTokens(pageText, budget.pageText)
      parts.push(`\n## Page Content\nFull text content of the current page. READ THIS to answer questions. Do NOT issue read actions when the answer is here.\n\n${truncated}`)
    }
  }

  // 16. MemPalace
  if (input.mempalace && budget.memory > 0) {
    parts.push(`\n## MemPalace (long-term memory — check dates)\n${truncateToTokens(input.mempalace, Math.floor(budget.memory * 0.6))}`)
  }

  // 17. Recent context
  if (input.memories && budget.memory > 0) {
    parts.push(`\n## Recent Context (entries prefixed with [date])\n${truncateToTokens(input.memories, Math.floor(budget.memory * 0.4))}`)
  }

  return parts.join('\n').trim()
}

function assembleCompactPrompt(
  input: PromptPipelineInput,
  intent: UserIntent,
  budget: TokenBudget,
  ctx: StructuredPageContext,
  classification: PageClassification,
): string {
  const now = new Date().toLocaleString()
  const hasA11yTree = !!input.accessibilityTree

  // Compact persona
  const persona = classification.type !== 'general' && classification.domainPersona
    ? `\n## EXPERT ROLE — ${classification.type.toUpperCase()}\n${classification.domainPersona.role}`
    : ''

  // Compact task guidance
  const guidance = intent.category !== 'general' && ctx.affordances.length > 0
    ? `\nTask: ${intent.category.replace(/_/g, ' ')}. ${ctx.primaryWorkflow}`
    : ''

  return `You are Orion — autonomous browser AI with encrypted vault, persistent memory, form filling, web research, 33 action types, tab groups, and voice input. Privacy-first: runs locally or with user's own API key. Current time: ${now}${persona}${guidance}

## RULES
- DO actions, don't describe them. Emit actions and give SHORT status text.
- Use Markdown. No emoji. No HTML tags.
- Actions inside [ACTION:...] are hidden from user.
- Always include dates when sharing information.
- Read page content below FIRST. Never guess CSS selectors.

## WORKFLOW
1. Read page content — understand what's on the page
2. If asked a question: answer from page content
3. If asked to do something: use TEXT SELECTORS
4. Emit the action, verify, continue. If it fails, try different selector.

## ACTIONS
${buildActionReference(intent, hasA11yTree)}

## COMPLETION
When done: {"is_complete": true}
${hasA11yTree ? `
## ACCESSIBILITY TREE${input.viewportMeta ? ` (Viewport: ${input.viewportMeta.width}x${input.viewportMeta.height})` : ''}
${truncateToTokens(input.accessibilityTree!, budget.a11yTree)}` : ''}
${input.instructions ? `\n${truncateToTokens(input.instructions, budget.userInstructions)}` : ''}

## Current Page State
${formatForPrompt(ctx, input.pageSnapshot, budget.pageContext)}
${budget.pageText > 0 && (input.pageSnapshot?.completePageText ?? input.pageSnapshot?.pageText) ? `
## Page Content
${truncateToTokens(input.pageSnapshot!.completePageText ?? input.pageSnapshot!.pageText ?? '', budget.pageText)}` : ''}`.trim()
}
