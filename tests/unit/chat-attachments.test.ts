import { buildAttachmentPlaceholder, buildOutgoingChatText, inferAttachmentKind } from '../../src/sidepanel/chat-attachments'

describe('chat attachment helpers', () => {
  it('classifies common code and data files as text', () => {
    expect(inferAttachmentKind('config.json', 'application/json')).toBe('text')
    expect(inferAttachmentKind('main.ts', '')).toBe('text')
    expect(inferAttachmentKind('README.md', 'text/markdown')).toBe('text')
  })

  it('classifies images and pdfs separately', () => {
    expect(inferAttachmentKind('diagram.png', 'image/png')).toBe('image')
    expect(inferAttachmentKind('report.pdf', 'application/pdf')).toBe('pdf')
  })

  it('builds a file-analysis request when the user sends only an attachment', () => {
    const result = buildOutgoingChatText({
      text: '',
      fileName: 'notes.txt',
      fileContext: 'alpha\nbeta\ngamma',
      hasImage: false,
    })

    expect(result.usedAutoPrompt).toBe(true)
    expect(result.displayText).toContain('Analyze this attached file')
    expect(result.requestText).toContain('[Attached file: notes.txt]')
    expect(result.requestText).toContain('alpha\nbeta\ngamma')
  })

  it('builds an image-analysis request when the user sends only an image', () => {
    const result = buildOutgoingChatText({
      text: '',
      hasImage: true,
    })

    expect(result.usedAutoPrompt).toBe(true)
    expect(result.requestText).toContain('Describe this attached image')
  })

  it('creates a metadata placeholder for pdfs', () => {
    const placeholder = buildAttachmentPlaceholder('manual.pdf', 'application/pdf', 12345, 'pdf')

    expect(placeholder).toContain('manual.pdf')
    expect(placeholder).toContain('Full PDF text extraction is not available')
  })
})
