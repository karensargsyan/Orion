const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1FA00}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]{3,}/gu

const REPEAT_CHAR_RE = /(.)\1{5,}/g

const REPEAT_PATTERN_RE = /(.{2,8}?)\1{4,}/g

const MAX_OUTPUT_LENGTH = 5000

const MALFORMED_ACTION_RE = /call:[\w]*:?[\w]*\{[^}]*\}/gi
const ABILITY_MARKER_RE = /ability:\s*\[?\s*(?:ACTION_?RESULT|ACTIONRESULT)\s*\]?/gi
const TOOLCALL_RE = /<\|?tool_?(?:call|response)\|?>(?:[^<]*<\|?\/?\s*tool_?(?:call|response)\|?>)?/gi
const ACTIONRESULT_INLINE_RE = /\[?\s*ACTIONRESULT\s*\]?/gi
const INTERNAL_PROTOCOL_RE = /call:(?:LocalAI|Orion)[^\n]*/gi

export function stripMalformedActions(text: string): string {
  return text
    .replace(MALFORMED_ACTION_RE, '')
    .replace(ABILITY_MARKER_RE, '')
    .replace(TOOLCALL_RE, '')
    .replace(ACTIONRESULT_INLINE_RE, '')
    .replace(INTERNAL_PROTOCOL_RE, '')
}

export function sanitizeModelOutput(text: string): string {
  let out = stripMalformedActions(text)

  out = out.replace(EMOJI_RE, '')

  out = out.replace(REPEAT_CHAR_RE, '$1')

  out = out.replace(REPEAT_PATTERN_RE, '$1')

  out = out.replace(/\n{4,}/g, '\n\n')

  out = out.replace(/^\s*\n/gm, '\n')

  if (out.length > MAX_OUTPUT_LENGTH) {
    out = out.slice(0, MAX_OUTPUT_LENGTH) + '...'
  }

  return out.trim()
}
