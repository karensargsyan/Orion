/**
 * Minimal Markdown renderer — zero dependencies.
 * Handles: headings, bold, italic, inline code, code blocks, lists, paragraphs, links.
 */

export function renderMarkdown(md: string): string {
  let html = escapeForRender(md)

  // Code blocks (```...```)
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  )

  // Inline code (`...`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  // Bold **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>')

  // Italic *text* or _text_
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>')

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')

  // Unordered lists
  html = html.replace(/^[*\-] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, match => `<ul>${match}</ul>`)

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr>')

  // Paragraphs: wrap lines not already wrapped in block tags
  const blockTags = /^<(h[1-6]|ul|ol|li|pre|hr|blockquote)/
  const lines = html.split('\n')
  const result: string[] = []
  let inPre = false

  for (const line of lines) {
    if (line.includes('<pre>')) inPre = true
    if (line.includes('</pre>')) inPre = false

    if (inPre || !line.trim() || blockTags.test(line.trim())) {
      result.push(line)
    } else {
      result.push(`<p>${line}</p>`)
    }
  }

  return result.join('\n')
}

function escapeForRender(text: string): string {
  // Escape HTML that's not from our own rendering
  // We want to keep user-submitted content safe
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Restore our special patterns after escaping (we unescape our own angle brackets)
}

/** Sanitize HTML output before inserting into DOM. Basic allow-list. */
export function sanitizeHtml(html: string): string {
  // Allow common safe tags from our renderer
  const allowed = new Set(['p','h1','h2','h3','strong','em','code','pre','ul','ol','li','a','hr','br'])

  return html.replace(/<\/?([a-z][a-z0-9]*)[^>]*>/gi, (tag, name) => {
    if (!allowed.has(name.toLowerCase())) return ''
    // Strip all attributes except href on <a>
    if (name.toLowerCase() === 'a') {
      const href = tag.match(/href="([^"]+)"/)
      const isClose = tag.startsWith('</')
      if (isClose) return '</a>'
      return href ? `<a href="${href[1]}" target="_blank" rel="noopener noreferrer">` : ''
    }
    return tag.replace(/\s+[a-zA-Z\-]+="[^"]*"/g, '')
  })
}
