/**
 * Minimal Markdown renderer — zero dependencies.
 * Handles: headings, bold, italic, inline code, code blocks, lists, paragraphs, links, blockquotes.
 */

export function renderMarkdown(md: string): string {
  let html = convertHtmlToMarkdown(md)
  html = escapeForRender(html)

  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  )

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>')

  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>')

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')

  html = html.replace(/^[*\-] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, match => `<ul>${match}</ul>`)

  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>(?!.*<ul>).*<\/li>\n?)+/g, match => {
    if (match.includes('<ul>')) return match
    return `<ol>${match}</ol>`
  })

  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')

  html = html.replace(/^---+$/gm, '<hr>')

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

function convertHtmlToMarkdown(text: string): string {
  let out = text
  out = out.replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**')
  out = out.replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**')
  out = out.replace(/<i>([\s\S]*?)<\/i>/gi, '*$1*')
  out = out.replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*')
  out = out.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  out = out.replace(/<br\s*\/?>/gi, '\n')
  out = out.replace(/<p>([\s\S]*?)<\/p>/gi, '$1\n\n')
  out = out.replace(/<h1>([\s\S]*?)<\/h1>/gi, '# $1\n')
  out = out.replace(/<h2>([\s\S]*?)<\/h2>/gi, '## $1\n')
  out = out.replace(/<h3>([\s\S]*?)<\/h3>/gi, '### $1\n')
  out = out.replace(/<li>([\s\S]*?)<\/li>/gi, '- $1\n')
  out = out.replace(/<\/?(ul|ol|div|span|table|tr|td|th|thead|tbody|section|article|header|footer|nav|main|aside|figure|figcaption|details|summary|mark|sub|sup|abbr|cite|dfn|kbd|samp|var|time|wbr|hr)[^>]*>/gi, '')
  out = out.replace(/<[^>]+>/g, '')
  return out
}

function escapeForRender(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Sanitize HTML output before inserting into DOM. Basic allow-list. */
export function sanitizeHtml(html: string): string {
  const allowed = new Set(['p','h1','h2','h3','strong','em','code','pre','ul','ol','li','a','hr','br','blockquote','div','span','button'])

  return html.replace(/<\/?([a-z][a-z0-9]*)[^>]*>/gi, (tag, name) => {
    if (!allowed.has(name.toLowerCase())) return ''
    if (name.toLowerCase() === 'a') {
      const href = tag.match(/href="([^"]+)"/)
      const isClose = tag.startsWith('</')
      if (isClose) return '</a>'
      return href ? `<a href="${href[1]}" target="_blank" rel="noopener noreferrer">` : ''
    }
    if (name.toLowerCase() === 'div' || name.toLowerCase() === 'span' || name.toLowerCase() === 'button') {
      return tag
    }
    return tag.replace(/\s+[a-zA-Z\-]+="[^"]*"/g, '')
  })
}
