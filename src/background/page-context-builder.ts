/**
 * Structured Page Context Builder — transforms flat PageSnapshot data into
 * action-oriented, hierarchical context for the LLM system prompt.
 * Replaces the flat tabState.summarize() dump with semantic grouping,
 * interactive flow detection, and action affordances.
 */

import type { PageSnapshot, FormInfo, FormField, PageButton, PageLink } from '../shared/types'
import type { UserIntent } from './prompt-engine'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InteractiveFlow {
  name: string
  type: 'search' | 'login' | 'registration' | 'checkout' | 'contact' | 'filter' | 'settings' | 'compose' | 'generic'
  elements: FlowElement[]
  submitAction: string | null   // "Click 'Search flights'" or null
}

export interface FlowElement {
  label: string
  fieldType: string
  state: string  // "empty", "filled: STR", "checked", "unchecked"
  required: boolean
  options?: string[]  // for select/radio
}

export interface StructuredPageContext {
  url: string
  title: string
  pageType: string
  primaryWorkflow: string          // "This is a flight search form. Fill departure, destination, dates, then click Search."
  flows: InteractiveFlow[]
  affordances: string[]            // "You can: search flights, filter results, sort by price"
  navigation: string[]             // top nav links
  contextText: string              // final formatted text for prompt
}

// ─── Flow type detection from form fields ───────────────────────────────────

const FLOW_PATTERNS: Array<{ type: InteractiveFlow['type']; keywords: RegExp; name: string }> = [
  { type: 'login', keywords: /\b(password|passwort|sign.?in|log.?in|email|username|anmelden)\b/i, name: 'Login' },
  { type: 'registration', keywords: /\b(sign.?up|register|create.?account|registrieren|confirm.?password|repeat.?password)\b/i, name: 'Registration' },
  { type: 'search', keywords: /\b(search|suche|find|from|to|depart|arriv|destination|origin|where|when|check.?in|check.?out|query)\b/i, name: 'Search' },
  { type: 'checkout', keywords: /\b(card.?number|cvv|cvc|expir|billing|shipping|payment|pay|checkout|bezahl|kreditkarte)\b/i, name: 'Checkout' },
  { type: 'contact', keywords: /\b(message|nachricht|subject|betreff|your.?name|phone|telefon|enquiry|feedback|kontakt)\b/i, name: 'Contact' },
  { type: 'compose', keywords: /\b(compose|reply|forward|draft|new.?message|new.?email|antwort|weiterleiten)\b/i, name: 'Compose' },
  { type: 'filter', keywords: /\b(filter|sort|price.?range|min|max|category|brand|size|color|farbe|größe)\b/i, name: 'Filters' },
  { type: 'settings', keywords: /\b(setting|preference|option|config|profil|notification|privacy|datenschutz)\b/i, name: 'Settings' },
]

function classifyFlow(form: FormInfo, buttons: PageButton[]): InteractiveFlow['type'] {
  const text = form.fields.map(f => `${f.label} ${f.name} ${f.type} ${f.autocomplete}`).join(' ')
  const submitText = findSubmitButton(form, buttons)
  const combined = `${text} ${submitText ?? ''}`

  for (const pattern of FLOW_PATTERNS) {
    if (pattern.keywords.test(combined)) return pattern.type
  }
  return 'generic'
}

function flowTypeName(type: InteractiveFlow['type']): string {
  return FLOW_PATTERNS.find(p => p.type === type)?.name ?? 'Form'
}

// ─── Form analysis helpers ──────────────────────────────────────────────────

function findSubmitButton(form: FormInfo, buttons: PageButton[]): string | null {
  // Look for submit-type buttons within form context
  for (const b of buttons) {
    const t = b.text.toLowerCase()
    if (t.includes('search') || t.includes('submit') || t.includes('sign') ||
        t.includes('log in') || t.includes('register') || t.includes('send') ||
        t.includes('book') || t.includes('buy') || t.includes('pay') ||
        t.includes('suchen') || t.includes('absenden') || t.includes('anmelden') ||
        t.includes('buchen') || t.includes('kaufen') || t.includes('apply') ||
        t.includes('continue') || t.includes('next') || t.includes('weiter')) {
      return b.text
    }
  }
  return null
}

function describeFieldState(field: FormField): string {
  if (field.checked !== undefined) {
    return field.checked ? 'checked' : 'unchecked'
  }
  if (field.value && field.value.length > 0) {
    return `filled: "${field.value.slice(0, 40)}"`
  }
  return 'empty'
}

function buildFlowElement(field: FormField): FlowElement {
  return {
    label: field.label || field.name || field.selector,
    fieldType: field.type,
    state: describeFieldState(field),
    required: field.required,
    options: field.options?.slice(0, 10).map(o => `${o.selected ? '✓' : ''}${o.label}`),
  }
}

// ─── Affordance detection ───────────────────────────────────────────────────

function detectAffordances(
  snapshot: PageSnapshot,
  flows: InteractiveFlow[]
): string[] {
  const affordances: string[] = []

  for (const flow of flows) {
    const emptyCount = flow.elements.filter(e => e.state === 'empty').length
    if (flow.type === 'search' && emptyCount > 0) {
      const labels = flow.elements.filter(e => e.state === 'empty').map(e => e.label).join(', ')
      affordances.push(`fill the search form (${labels})`)
    } else if (flow.type === 'login') {
      affordances.push('sign in with credentials')
    } else if (flow.type === 'checkout') {
      affordances.push('complete checkout')
    } else if (flow.type === 'compose') {
      affordances.push('compose/reply to message')
    } else if (flow.type === 'contact') {
      affordances.push('send a message/enquiry')
    } else if (flow.type === 'filter') {
      affordances.push('filter/sort results')
    } else if (flow.type === 'registration') {
      affordances.push('create an account')
    } else if (emptyCount > 0) {
      affordances.push(`fill out form (${emptyCount} fields)`)
    }
  }

  // Buttons as affordances
  const actionButtons = snapshot.buttons
    .filter(b => b.role !== 'row' && b.role !== 'listitem' && b.role !== 'option' && b.role !== 'gridcell' && b.role !== 'treeitem')
    .slice(0, 8)
  for (const b of actionButtons) {
    const t = b.text.toLowerCase()
    if (t.includes('add to cart') || t.includes('in den warenkorb')) affordances.push('add item to cart')
    else if (t.includes('buy') || t.includes('kaufen')) affordances.push('buy/purchase')
    else if (t.includes('download') || t.includes('herunterladen')) affordances.push('download')
    else if (t.includes('share') || t.includes('teilen')) affordances.push('share')
    else if (t.includes('compare') || t.includes('vergleichen')) affordances.push('compare items')
  }

  // Navigation links
  const navLinks = snapshot.links.filter(l => l.isNav).slice(0, 5)
  if (navLinks.length > 0) {
    affordances.push(`navigate to: ${navLinks.map(l => l.text).join(', ')}`)
  }

  return [...new Set(affordances)] // deduplicate
}

// ─── Intent-aware element prioritization ────────────────────────────────────

function prioritizeByIntent(flows: InteractiveFlow[], intent?: UserIntent): InteractiveFlow[] {
  if (!intent) return flows

  // For fill_form/interact, put the most relevant flow first
  if (intent.category === 'fill_form' || intent.category === 'interact') {
    // If intent has entity mentions, find the flow whose fields match
    if (intent.entities.fields && intent.entities.fields.length > 0) {
      const target = intent.entities.fields.join(' ').toLowerCase()
      return [...flows].sort((a, b) => {
        const aMatch = a.elements.some(e => target.includes(e.label.toLowerCase())) ? 0 : 1
        const bMatch = b.elements.some(e => target.includes(e.label.toLowerCase())) ? 0 : 1
        return aMatch - bMatch
      })
    }
    // Otherwise prefer search/compose flows (most common fill targets)
    return [...flows].sort((a, b) => {
      const order: Record<string, number> = { search: 0, compose: 1, contact: 2, login: 3, registration: 4, checkout: 5, filter: 6, settings: 7, generic: 8 }
      return (order[a.type] ?? 9) - (order[b.type] ?? 9)
    })
  }

  return flows
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function buildStructuredContext(
  snapshot: PageSnapshot | undefined,
  intent?: UserIntent
): StructuredPageContext {
  if (!snapshot) {
    return {
      url: '', title: '', pageType: 'unknown',
      primaryWorkflow: 'No page data available.',
      flows: [], affordances: [], navigation: [],
      contextText: 'No page data available for this tab.',
    }
  }

  // Build interactive flows from forms
  const flows: InteractiveFlow[] = []
  for (const form of snapshot.forms) {
    const type = classifyFlow(form, snapshot.buttons)
    const elements = form.fields.map(buildFlowElement)
    const submitBtn = findSubmitButton(form, snapshot.buttons)

    flows.push({
      name: `${flowTypeName(type)} Form`,
      type,
      elements,
      submitAction: submitBtn ? `Click "${submitBtn}"` : null,
    })
  }

  // Prioritize by intent
  const prioritizedFlows = prioritizeByIntent(flows, intent)

  // Detect affordances
  const affordances = detectAffordances(snapshot, flows)

  // Navigation links
  const navigation = snapshot.links
    .filter(l => l.isNav)
    .slice(0, 8)
    .map(l => l.text)

  // Build primary workflow description
  let primaryWorkflow = ''
  if (prioritizedFlows.length > 0) {
    const main = prioritizedFlows[0]
    const emptyFields = main.elements.filter(e => e.state === 'empty')
    if (emptyFields.length > 0) {
      const fieldNames = emptyFields.map(e => e.label).join(', ')
      primaryWorkflow = `This page has a ${main.name.toLowerCase()} with empty fields: ${fieldNames}.`
      if (main.submitAction) primaryWorkflow += ` ${main.submitAction} to submit.`
    } else if (main.elements.length > 0) {
      primaryWorkflow = `This page has a ${main.name.toLowerCase()} (all fields filled).`
      if (main.submitAction) primaryWorkflow += ` ${main.submitAction} to submit.`
    }
  }
  if (!primaryWorkflow && snapshot.buttons.length > 0) {
    primaryWorkflow = `This page has ${snapshot.buttons.length} interactive elements.`
  }
  if (!primaryWorkflow) {
    primaryWorkflow = 'This is a content page.'
  }

  return {
    url: snapshot.url,
    title: snapshot.title,
    pageType: 'detected', // will be set externally by prompt-engine
    primaryWorkflow,
    flows: prioritizedFlows,
    affordances,
    navigation,
    contextText: '', // computed by formatForPrompt
  }
}

export function formatForPrompt(
  ctx: StructuredPageContext,
  snapshot: PageSnapshot | undefined,
  maxTokens = 3000
): string {
  if (!snapshot) return 'No page data available for this tab.'

  const parts: string[] = []
  const estTokens = (s: string) => Math.ceil(s.length / 3.5)
  let budget = maxTokens

  // Header — always included
  const header = `URL: ${ctx.url}\nTitle: ${ctx.title}`
  parts.push(header)
  budget -= estTokens(header)

  if (snapshot.metaDescription) {
    parts.push(`Description: ${snapshot.metaDescription}`)
    budget -= estTokens(snapshot.metaDescription)
  }

  // Affordances line
  if (ctx.affordances.length > 0 && budget > 100) {
    const line = `You can: ${ctx.affordances.join(', ')}`
    parts.push(line)
    budget -= estTokens(line)
  }

  // Interactive flows (forms) — most important for action execution
  for (const flow of ctx.flows) {
    if (budget < 200) break

    const flowParts: string[] = [`\n### ${flow.name}`]
    for (const el of flow.elements) {
      let line = `- ${el.label} (${el.fieldType}): [${el.state}]`
      if (el.required) line += ' [required]'
      if (el.options && el.options.length > 0) {
        line += `\n  Options: ${el.options.slice(0, 12).join(', ')}`
      }
      flowParts.push(line)
    }
    if (flow.submitAction) {
      flowParts.push(`- Submit: ${flow.submitAction}`)
    }

    const flowText = flowParts.join('\n')
    if (estTokens(flowText) <= budget) {
      parts.push(flowText)
      budget -= estTokens(flowText)
    }
  }

  // Buttons (non-form)
  const regularButtons = snapshot.buttons.filter(
    b => b.role !== 'row' && b.role !== 'listitem' && b.role !== 'option' && b.role !== 'gridcell' && b.role !== 'treeitem'
  )
  if (regularButtons.length > 0 && budget > 150) {
    const btnLines = regularButtons.slice(0, 10).map(b => `  - "${b.text}" → ${b.selector}`)
    const section = `\nButtons:\n${btnLines.join('\n')}`
    if (estTokens(section) <= budget) {
      parts.push(section)
      budget -= estTokens(section)
    }
  }

  // Interactive elements (rows, listitems etc.)
  const interactiveItems = snapshot.buttons.filter(
    b => b.role === 'row' || b.role === 'listitem' || b.role === 'option' || b.role === 'interactive' || b.role === 'gridcell' || b.role === 'treeitem'
  )
  if (interactiveItems.length > 0 && budget > 150) {
    const itemLines = interactiveItems.slice(0, 8).map(b => `  - "${b.text.slice(0, 80)}" → ${b.selector}`)
    const section = `\nInteractive Elements:\n${itemLines.join('\n')}`
    if (estTokens(section) <= budget) {
      parts.push(section)
      budget -= estTokens(section)
    }
  }

  // Navigation links
  if (ctx.navigation.length > 0 && budget > 100) {
    const navSection = `\nNavigation: ${ctx.navigation.join(' | ')}`
    if (estTokens(navSection) <= budget) {
      parts.push(navSection)
      budget -= estTokens(navSection)
    }
  }

  // Non-nav links
  const contentLinks = snapshot.links.filter(l => !l.isNav).slice(0, 10)
  if (contentLinks.length > 0 && budget > 150) {
    const linkLines = contentLinks.map(l => `  - "${l.text}" → ${l.href}`)
    const section = `\nLinks:\n${linkLines.join('\n')}`
    if (estTokens(section) <= budget) {
      parts.push(section)
      budget -= estTokens(section)
    }
  }

  // Headings
  if (snapshot.headings.length > 0 && budget > 80) {
    const headings = `\nHeadings: ${snapshot.headings.slice(0, 5).join(' | ')}`
    if (estTokens(headings) <= budget) {
      parts.push(headings)
      budget -= estTokens(headings)
    }
  }

  // Selected text
  if (snapshot.selectedText && budget > 50) {
    const sel = `\nUser Selected Text:\n${snapshot.selectedText.slice(0, 500)}`
    parts.push(sel)
  }

  return parts.join('\n')
}
