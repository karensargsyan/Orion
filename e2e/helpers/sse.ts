/**
 * Build deterministic SSE response payloads for the mock AI server.
 */

/** Build an OpenAI-format SSE stream from a text string */
export function buildOpenAISSE(text: string): string {
  // Split into word-level tokens for realistic streaming
  const tokens = text.match(/.{1,8}/g) ?? [text]
  const chunks = tokens.map(token =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`
  )
  chunks.push('data: [DONE]\n\n')
  return chunks.join('')
}

/** Build an OpenAI-format non-streaming JSON response */
export function buildOpenAIJSON(text: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: text } }],
  })
}

/** Build a model list response */
export function buildModelList(models: string[] = ['test-model']): string {
  return JSON.stringify({
    data: models.map(id => ({ id, object: 'model', owned_by: 'test' })),
  })
}

/** Build a capabilities/health probe response */
export function buildProbeResponse(): string {
  return JSON.stringify({
    data: [{ id: 'test-model', object: 'model' }],
  })
}

/** Common AI responses for testing */
export const RESPONSES = {
  /** Simple text reply — includes is_complete so the action loop doesn't follow up */
  hello: 'Hello! How can I help you today? {"is_complete": true}',

  navigateTestPage: (url: string) =>
    `I'll navigate to that page for you.\n\n[ACTION:NAVIGATE url="${url}"]`,

  searchFlights: `Let me search for flights.\n\n[ACTION:SEARCH query="cheap flights to Berlin"]`,

  openTab: (url: string) =>
    `I'll open that page to read it.\n\n[ACTION:OPEN_TAB url="${url}"]`,

  fillForm: (fields: Array<{ selector: string; value: string }>) => {
    const actions = fields.map(f => `[ACTION:TYPE selector="${f.selector}" value="${f.value}"]`).join('\n')
    return `I'll fill in the form for you.\n\n${actions}`
  },

  complete: `I've completed the task. {"is_complete": true}`,

  analysisResult: `Based on the page content, here is my analysis:\n\n**Summary:** This is a test page with multiple form sections for testing form detection and auto-fill capabilities.\n\n{"is_complete": true}`,
}
