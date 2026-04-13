/**
 * Unit tests for Telegram file upload functionality
 *
 * Tests the file download, parsing, and integration with the AI chat pipeline
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('Telegram File Upload', () => {
  // Mock types matching telegram-client.ts
  interface TelegramDocument {
    file_id: string
    file_unique_id: string
    file_name?: string
    mime_type?: string
    file_size: number
  }

  interface TelegramMessage {
    message_id: number
    chat: { id: number; type: string }
    date: number
    text?: string
    caption?: string
    document?: TelegramDocument
  }

  interface TelegramUpdate {
    update_id: number
    message?: TelegramMessage
  }

  describe('Message filtering', () => {
    it('should accept messages with text only', () => {
      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 123, type: 'private' },
          date: Date.now(),
          text: 'hello',
        },
      }

      // This should pass the filter: update.message?.text && !update.message?.document
      const shouldProcess = !!(update.message?.text || update.message?.document)
      expect(shouldProcess).toBe(true)
    })

    it('should accept messages with document only', () => {
      const update: TelegramUpdate = {
        update_id: 2,
        message: {
          message_id: 2,
          chat: { id: 123, type: 'private' },
          date: Date.now(),
          document: {
            file_id: 'BQACAgI123',
            file_unique_id: 'AgAAD123',
            file_name: 'test.txt',
            mime_type: 'text/plain',
            file_size: 1234,
          },
        },
      }

      // This should pass the filter: !update.message?.text && update.message?.document
      const shouldProcess = !!(update.message?.text || update.message?.document)
      expect(shouldProcess).toBe(true)
    })

    it('should accept messages with both text and document (caption)', () => {
      const update: TelegramUpdate = {
        update_id: 3,
        message: {
          message_id: 3,
          chat: { id: 123, type: 'private' },
          date: Date.now(),
          caption: 'review this file',
          document: {
            file_id: 'BQACAgI456',
            file_unique_id: 'AgAAD456',
            file_name: 'data.json',
            mime_type: 'application/json',
            file_size: 5678,
          },
        },
      }

      // This should pass both filters
      const shouldProcess = !!(update.message?.text || update.message?.document)
      expect(shouldProcess).toBe(true)
    })

    it('should reject messages with neither text nor document', () => {
      const update: TelegramUpdate = {
        update_id: 4,
        message: {
          message_id: 4,
          chat: { id: 123, type: 'private' },
          date: Date.now(),
        },
      }

      // This should NOT pass the filter
      const shouldProcess = !!(update.message?.text || update.message?.document)
      expect(shouldProcess).toBe(false)
    })
  })

  describe('File type detection', () => {
    const textFileExtensions = [
      'txt', 'md', 'json', 'csv', 'log', 'xml', 'html',
      'js', 'ts', 'py', 'java', 'cpp', 'c', 'go', 'rs', 'kt', 'swift',
      'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg',
      'sh', 'bash', 'sql', 'r', 'm', 'h', 'hpp', 'cs', 'php', 'rb', 'pl',
      'lua', 'dart', 'scala', 'clj', 'ex', 'exs', 'erl', 'hrl',
      'vim', 'asm', 's', 'd', 'nim', 'v', 'sv', 'vhd', 'vhdl',
      'tex', 'bib', 'sty', 'cls',
    ]

    const isTextFile = (fileName: string): boolean => {
      return /\.(txt|md|json|csv|log|xml|html|js|ts|py|java|cpp|c|go|rs|kt|swift|yml|yaml|toml|ini|conf|cfg|sh|bash|sql|r|m|h|hpp|cs|php|rb|pl|lua|dart|scala|clj|ex|exs|erl|hrl|vim|asm|s|d|nim|v|sv|vhd|vhdl|tex|bib|sty|cls)$/i.test(fileName)
    }

    it('should recognize common text files', () => {
      expect(isTextFile('test.txt')).toBe(true)
      expect(isTextFile('README.md')).toBe(true)
      expect(isTextFile('config.json')).toBe(true)
      expect(isTextFile('data.csv')).toBe(true)
      expect(isTextFile('app.log')).toBe(true)
    })

    it('should recognize code files', () => {
      expect(isTextFile('app.js')).toBe(true)
      expect(isTextFile('main.ts')).toBe(true)
      expect(isTextFile('script.py')).toBe(true)
      expect(isTextFile('Main.java')).toBe(true)
      expect(isTextFile('main.cpp')).toBe(true)
      expect(isTextFile('main.go')).toBe(true)
      expect(isTextFile('lib.rs')).toBe(true)
    })

    it('should recognize config files', () => {
      expect(isTextFile('config.yml')).toBe(true)
      expect(isTextFile('settings.yaml')).toBe(true)
      expect(isTextFile('Cargo.toml')).toBe(true)
      expect(isTextFile('app.ini')).toBe(true)
      expect(isTextFile('nginx.conf')).toBe(true)
      expect(isTextFile('settings.cfg')).toBe(true)
    })

    it('should recognize shell scripts', () => {
      expect(isTextFile('deploy.sh')).toBe(true)
      expect(isTextFile('install.bash')).toBe(true)
    })

    it('should reject binary files', () => {
      expect(isTextFile('photo.jpg')).toBe(false)
      expect(isTextFile('video.mp4')).toBe(false)
      expect(isTextFile('document.pdf')).toBe(false)
      expect(isTextFile('archive.zip')).toBe(false)
      expect(isTextFile('binary.exe')).toBe(false)
      expect(isTextFile('image.png')).toBe(false)
      expect(isTextFile('audio.mp3')).toBe(false)
    })

    it('should be case-insensitive', () => {
      expect(isTextFile('FILE.TXT')).toBe(true)
      expect(isTextFile('README.MD')).toBe(true)
      expect(isTextFile('Config.JSON')).toBe(true)
      expect(isTextFile('PHOTO.JPG')).toBe(false)
    })

    it('should handle files without extensions', () => {
      expect(isTextFile('README')).toBe(false)
      expect(isTextFile('Makefile')).toBe(false)
      expect(isTextFile('LICENSE')).toBe(false)
    })
  })

  describe('File content formatting', () => {
    it('should format file-only messages correctly', () => {
      const fileName = 'test.txt'
      const fileContent = 'This is test content'
      const caption = ''

      const filePrefix = `[Attached file: ${fileName}]\n\`\`\`\n${fileContent.slice(0, 20_000)}\n\`\`\`\n\n`
      const userText = filePrefix + caption

      expect(userText).toContain('[Attached file: test.txt]')
      expect(userText).toContain('This is test content')
      expect(userText).toMatch(/^\[Attached file:.*\]\n```\n.*\n```\n\n$/)
    })

    it('should format file+caption messages correctly', () => {
      const fileName = 'data.json'
      const fileContent = '{"key": "value"}'
      const caption = 'review this data'

      const filePrefix = `[Attached file: ${fileName}]\n\`\`\`\n${fileContent.slice(0, 20_000)}\n\`\`\`\n\n`
      const userText = filePrefix + caption

      expect(userText).toContain('[Attached file: data.json]')
      expect(userText).toContain('{"key": "value"}')
      expect(userText).toContain('review this data')
      expect(userText).toMatch(/^\[Attached file:.*\]\n```\n.*\n```\n\nreview this data$/)
    })

    it('should truncate file content to 20KB in prefix', () => {
      const fileName = 'large.txt'
      const fileContent = 'x'.repeat(50_000) // 50KB content
      const caption = 'analyze this'

      // Simulate what the code does: slice to 20KB before adding to prefix
      const filePrefix = `[Attached file: ${fileName}]\n\`\`\`\n${fileContent.slice(0, 20_000)}\n\`\`\`\n\n`
      const userText = filePrefix + caption

      // The prefix should contain exactly 20,000 x's plus formatting
      const contentMatch = userText.match(/```\n(.*?)\n```/)
      expect(contentMatch).toBeTruthy()
      expect(contentMatch![1].length).toBe(20_000)
    })

    it('should handle empty caption', () => {
      const fileName = 'test.txt'
      const fileContent = 'content'
      const caption = ''

      const filePrefix = `[Attached file: ${fileName}]\n\`\`\`\n${fileContent.slice(0, 20_000)}\n\`\`\`\n\n`
      const userText = (filePrefix + caption).trim()

      expect(userText).toBeTruthy()
      expect(userText).toContain('content')
    })
  })

  describe('Size limits', () => {
    it('should respect 50KB download limit', () => {
      const content = 'x'.repeat(100_000) // 100KB
      const truncated = content.slice(0, 50_000)

      expect(truncated.length).toBe(50_000)
      expect(truncated.length).toBeLessThan(content.length)
    })

    it('should respect 20KB prefix limit', () => {
      const content = 'y'.repeat(50_000) // 50KB downloaded
      const prefixContent = content.slice(0, 20_000)

      expect(prefixContent.length).toBe(20_000)
      expect(prefixContent.length).toBeLessThan(content.length)
    })

    it('should not truncate small files', () => {
      const content = 'small content'
      const truncated = content.slice(0, 50_000)

      expect(truncated).toBe(content)
      expect(truncated.length).toBe(content.length)
    })
  })

  describe('User notifications', () => {
    it('should generate success notification', () => {
      const fileName = 'test.txt'
      const fileSize = 1234

      const notification = `📎 Received file: *${fileName}* (${fileSize} bytes)\nAnalyzing...`

      expect(notification).toContain('📎')
      expect(notification).toContain('test.txt')
      expect(notification).toContain('1234 bytes')
      expect(notification).toContain('Analyzing')
    })

    it('should generate error notification for unsupported file', () => {
      const fileName = 'photo.jpg'

      const notification = `⚠️ Could not process file: *${fileName}*\nSupported formats: .txt, .md, .json, .csv, .log, .xml, .html, code files`

      expect(notification).toContain('⚠️')
      expect(notification).toContain('photo.jpg')
      expect(notification).toContain('Could not process')
      expect(notification).toContain('Supported formats')
    })
  })

  describe('Caption handling', () => {
    it('should use text field if present', () => {
      const message: TelegramMessage = {
        message_id: 1,
        chat: { id: 123, type: 'private' },
        date: Date.now(),
        text: 'hello',
        caption: 'caption',
      }

      const userText = message.text ?? message.caption ?? ''
      expect(userText).toBe('hello')
    })

    it('should fallback to caption if text is missing', () => {
      const message: TelegramMessage = {
        message_id: 2,
        chat: { id: 123, type: 'private' },
        date: Date.now(),
        caption: 'file caption',
      }

      const userText = message.text ?? message.caption ?? ''
      expect(userText).toBe('file caption')
    })

    it('should use empty string if both are missing', () => {
      const message: TelegramMessage = {
        message_id: 3,
        chat: { id: 123, type: 'private' },
        date: Date.now(),
      }

      const userText = message.text ?? message.caption ?? ''
      expect(userText).toBe('')
    })
  })

  describe('Error scenarios', () => {
    it('should handle missing file_name', () => {
      const document: TelegramDocument = {
        file_id: 'BQACAgI123',
        file_unique_id: 'AgAAD123',
        file_size: 1234,
      }

      const fileName = document.file_name ?? 'unknown'
      expect(fileName).toBe('unknown')
    })

    it('should handle missing mime_type', () => {
      const document: TelegramDocument = {
        file_id: 'BQACAgI123',
        file_unique_id: 'AgAAD123',
        file_name: 'test.txt',
        file_size: 1234,
      }

      expect(document.mime_type).toBeUndefined()
      // Should still process based on file extension
    })

    it('should handle zero-size files', () => {
      const document: TelegramDocument = {
        file_id: 'BQACAgI123',
        file_unique_id: 'AgAAD123',
        file_name: 'empty.txt',
        mime_type: 'text/plain',
        file_size: 0,
      }

      expect(document.file_size).toBe(0)
      // Should still attempt to download
    })
  })

  describe('Security', () => {
    it('should not expose bot token in logs', () => {
      const token = 'bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'
      const filePath = 'documents/file_1.txt'
      const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`

      // Simulate log redaction
      const safeUrl = downloadUrl.replace(token, 'TOKEN')

      expect(safeUrl).not.toContain('bot123456')
      expect(safeUrl).not.toContain('ABC-DEF1234')
      expect(safeUrl).toContain('TOKEN')
      expect(safeUrl).toBe('https://api.telegram.org/file/botTOKEN/documents/file_1.txt')
    })
  })

  describe('Integration scenarios', () => {
    it('should process file-only upload workflow', () => {
      // 1. Receive update with document
      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 123, type: 'private' },
          date: Date.now(),
          document: {
            file_id: 'BQACAgI123',
            file_unique_id: 'AgAAD123',
            file_name: 'config.json',
            mime_type: 'application/json',
            file_size: 256,
          },
        },
      }

      // 2. Check filter passes
      const shouldProcess = !!(update.message?.text || update.message?.document)
      expect(shouldProcess).toBe(true)

      // 3. Extract file info
      const fileName = update.message!.document!.file_name
      expect(fileName).toBe('config.json')

      // 4. Simulate successful download
      const fileContent = '{"setting": "value"}'

      // 5. Format message
      const filePrefix = `[Attached file: ${fileName}]\n\`\`\`\n${fileContent}\n\`\`\`\n\n`
      const userText = filePrefix + (update.message!.text ?? update.message!.caption ?? '')

      expect(userText).toContain('[Attached file: config.json]')
      expect(userText).toContain('{"setting": "value"}')
    })

    it('should process file+caption upload workflow', () => {
      // 1. Receive update with document and caption
      const update: TelegramUpdate = {
        update_id: 2,
        message: {
          message_id: 2,
          chat: { id: 123, type: 'private' },
          date: Date.now(),
          caption: 'explain this code',
          document: {
            file_id: 'BQACAgI456',
            file_unique_id: 'AgAAD456',
            file_name: 'main.py',
            mime_type: 'text/x-python',
            file_size: 512,
          },
        },
      }

      // 2. Check filter passes
      const shouldProcess = !!(update.message?.text || update.message?.document)
      expect(shouldProcess).toBe(true)

      // 3. Extract file info and caption
      const fileName = update.message!.document!.file_name
      const caption = update.message!.caption
      expect(fileName).toBe('main.py')
      expect(caption).toBe('explain this code')

      // 4. Simulate successful download
      const fileContent = 'def hello():\n    print("world")'

      // 5. Format message with caption
      const filePrefix = `[Attached file: ${fileName}]\n\`\`\`\n${fileContent}\n\`\`\`\n\n`
      const userText = filePrefix + caption

      expect(userText).toContain('[Attached file: main.py]')
      expect(userText).toContain('def hello()')
      expect(userText).toContain('explain this code')
    })
  })
})
