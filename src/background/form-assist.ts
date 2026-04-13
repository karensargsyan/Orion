import { MSG } from '../shared/constants'
import type { Settings, FormAssistField, VaultEntry, VaultData, FormField } from '../shared/types'
import type { StreamPort } from './ai-client'
import { callAI } from './ai-client'
import { tabState } from './tab-state'
import { classifyField, resolveValue } from './form-intelligence'
import { vaultList } from './memory-manager'
import { decryptData, isSessionUnlocked } from './crypto-manager'
import { getCDPAccessibilityTreeCached } from './cdp-accessibility'

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Analyze the current page's form fields, match against vault, ask AI for
 * missing values, then send a FORM_ASSIST card to the sidepanel.
 */
export async function analyzeAndGenerateFormValues(
  tabId: number,
  settings: Settings,
  port: StreamPort
): Promise<void> {
  const snap = tabState.get(tabId)
  if (!snap || snap.forms.length === 0) {
    port.postMessage({ type: MSG.STREAM_CHUNK, chunk: 'No form found on this page. I can still help — tell me what you need to fill.\n' })
    port.postMessage({ type: MSG.STREAM_END })
    return
  }

  // Notify user that analysis is starting
  port.postMessage({ type: MSG.STREAM_CHUNK, chunk: 'Analyzing the form...\n\n' })

  // 1. Gather all form fields from all forms on the page
  const allFields: Array<FormField & { formIndex: number }> = []
  for (let fi = 0; fi < snap.forms.length; fi++) {
    for (const field of snap.forms[fi].fields) {
      allFields.push({ ...field, formIndex: fi })
    }
  }

  if (allFields.length === 0) {
    port.postMessage({ type: MSG.STREAM_CHUNK, chunk: 'No fillable form fields detected. The page may use a non-standard form.\n' })
    port.postMessage({ type: MSG.STREAM_END })
    return
  }

  // 2. Decrypt vault entries (if unlocked)
  const vaultEntries = await getDecryptedVaultEntries()

  // 3. Classify each field and attempt vault match
  const assistFields: FormAssistField[] = []
  const needsAI: Array<{ index: number; field: FormField }> = []

  for (let i = 0; i < allFields.length; i++) {
    const field = allFields[i]
    const hint = classifyField(field)
    let bestValue = ''
    let confidence: FormAssistField['confidence'] = 'low'
    let hintText = 'Please provide'

    // Try matching against each vault entry
    if (hint !== 'unknown') {
      for (const { data } of vaultEntries) {
        const val = resolveValue(hint, data)
        if (val) {
          bestValue = val
          confidence = 'high'
          hintText = 'From your vault'
          break
        }
      }
    }

    const assistField: FormAssistField = {
      fieldId: `field_${i}`,
      selector: field.selector,
      label: field.label || field.name || field.autocomplete || `Field ${i + 1}`,
      inputType: field.type || 'text',
      value: bestValue,
      confidence,
      hint: hintText,
      required: field.required ?? false,
      options: field.options?.map(o => typeof o === 'string' ? o : (o as { label?: string; value: string }).label ?? (o as { value: string }).value),
    }

    assistFields.push(assistField)

    // Fields without vault match need AI help
    if (!bestValue) {
      needsAI.push({ index: i, field })
    }
  }

  // 4. Ask AI to generate values for unmatched fields
  if (needsAI.length > 0) {
    await generateAIValues(tabId, settings, snap, assistFields, needsAI)
  }

  // 5. Build form title from page context
  const formTitle = snap.title || new URL(snap.url || '').hostname || 'Form'

  // 6. Send the card to sidepanel
  const vaultCount = assistFields.filter(f => f.confidence === 'high').length
  port.postMessage({
    type: MSG.FORM_ASSIST,
    id: `assist_${Date.now()}`,
    formTitle,
    fields: assistFields,
  })

  // 7. Send a brief summary message
  const totalFields = assistFields.length
  const aiCount = assistFields.filter(f => f.confidence === 'medium').length
  const emptyCount = assistFields.filter(f => f.confidence === 'low' && !f.value).length

  let summary = `Found **${totalFields}** fields.`
  if (vaultCount > 0) summary += ` ${vaultCount} pre-filled from vault.`
  if (aiCount > 0) summary += ` ${aiCount} suggested by AI.`
  if (emptyCount > 0) summary += ` ${emptyCount} need your input.`
  summary += '\n\nEdit any value below, then use **Copy** or **Fill** for each field.'

  port.postMessage({ type: MSG.STREAM_CHUNK, chunk: summary })
  port.postMessage({ type: MSG.STREAM_END })
}

// ─── AI Value Generation ──────────────────────────────────────────────────────

async function generateAIValues(
  tabId: number,
  settings: Settings,
  snap: { url?: string; title?: string; pageText?: string; completePageText?: string },
  assistFields: FormAssistField[],
  needsAI: Array<{ index: number; field: FormField }>
): Promise<void> {
  // Build compact field descriptions for the AI
  const fieldDescs = needsAI.map(({ index, field }) => {
    const label = field.label || field.name || field.autocomplete || `Field ${index}`
    const type = field.type || 'text'
    const opts = field.options?.length ? ` Options: ${field.options.slice(0, 20).join(', ')}` : ''
    return `- fieldId: "field_${index}", label: "${label}", type: "${type}"${opts}`
  }).join('\n')

  // Page context (truncated)
  const pageText = (snap.completePageText ?? snap.pageText ?? '').slice(0, 3000)

  // Take screenshot for visual context
  let screenshotData: string | undefined
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 60 })
    screenshotData = dataUrl
  } catch { /* no screenshot available */ }

  const systemPrompt = `You are a form-filling assistant. Given a web page and its form fields, suggest appropriate values.
The page is: ${snap.title ?? ''} (${snap.url ?? ''})

RULES:
- Read the page content carefully. If it contains information relevant to a field, USE IT.
- For text fields like "justification", "description", "reason" — generate a professional, contextually appropriate response.
- For personal data fields (name, email, phone) — leave blank unless context suggests specific values.
- For selection fields — pick the most appropriate option from the available choices.
- Output ONLY a JSON array. Each element: { "fieldId": "field_N", "value": "suggested text", "confidence": "medium" or "low" }
- "medium" = you have a reasonable suggestion. "low" = just a placeholder or blank.
- NO markdown, NO explanation, JUST the JSON array.`

  const userMsg = `Page content:\n${pageText}\n\nFields that need values:\n${fieldDescs}\n\nSuggest values as JSON array:`

  try {
    const messages: Array<{ role: 'system' | 'user'; content: string; imageData?: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg, ...(screenshotData ? { imageData: screenshotData } : {}) },
    ]

    const aiResponse = await callAI(messages as Parameters<typeof callAI>[0], settings, 4096)

    // Parse JSON from AI response (handle markdown code blocks)
    // Use non-greedy match to avoid capturing unrelated brackets
    const jsonMatch = aiResponse.match(/\[[\s\S]*?\](?=\s*(?:```|$))/)
    if (jsonMatch) {
      const suggestions = JSON.parse(jsonMatch[0]) as Array<{ fieldId: string; value: string; confidence?: string }>
      for (const s of suggestions) {
        const idx = assistFields.findIndex(f => f.fieldId === s.fieldId)
        if (idx >= 0 && s.value) {
          assistFields[idx].value = s.value
          assistFields[idx].confidence = s.confidence === 'low' ? 'low' : 'medium'
          assistFields[idx].hint = s.confidence === 'low' ? 'AI placeholder' : 'AI suggestion'
        }
      }
    }
  } catch (err) {
    console.warn('[FormAssist] AI value generation failed:', err)
    // Continue with empty values — user can still fill manually
  }
}

// ─── Vault Helpers ────────────────────────────────────────────────────────────

async function getDecryptedVaultEntries(): Promise<Array<{ entry: VaultEntry; data: VaultData }>> {
  try {
    const unlocked = await isSessionUnlocked()
    if (!unlocked) return []

    const entries = await vaultList()
    const results: Array<{ entry: VaultEntry; data: VaultData }> = []

    for (const entry of entries) {
      try {
        const plaintext = await decryptData(entry.encryptedData)
        const data = JSON.parse(plaintext) as VaultData
        results.push({ entry, data })
      } catch { /* skip entries that fail to decrypt */ }
    }

    return results
  } catch {
    return []
  }
}
