import { describe, it, expect, beforeEach } from 'vitest'
import { recordClip, searchClips, getRecentClips, clearClips } from '../../src/background/clipboard-manager'

describe('clipboard-manager', () => {
  beforeEach(() => {
    clearClips()
  })

  describe('recordClip', () => {
    it('should record a clip with text and URL', () => {
      const clip = recordClip('Hello world', 'https://example.com/page')
      expect(clip.text).toBe('Hello world')
      expect(clip.sourceUrl).toBe('https://example.com/page')
      expect(clip.sourceDomain).toBe('example.com')
      expect(clip.timestamp).toBeGreaterThan(0)
    })

    it('should detect email type', () => {
      const clip = recordClip('user@example.com', '')
      expect(clip.detectedType).toBe('email')
    })

    it('should detect link type', () => {
      const clip = recordClip('https://github.com/repo', '')
      expect(clip.detectedType).toBe('link')
    })

    it('should detect phone type', () => {
      const clip = recordClip('+1-555-123-4567', '')
      expect(clip.detectedType).toBe('phone')
    })

    it('should detect code type', () => {
      const clip = recordClip('function hello() { return true; }', '')
      expect(clip.detectedType).toBe('code')
    })

    it('should truncate text to 5000 chars', () => {
      const longText = 'x'.repeat(6000)
      const clip = recordClip(longText, '')
      expect(clip.text.length).toBe(5000)
    })

    it('should enforce circular buffer limit', () => {
      for (let i = 0; i < 55; i++) {
        recordClip(`clip ${i}`, '')
      }
      const recent = getRecentClips(100)
      expect(recent.length).toBe(50)
    })
  })

  describe('searchClips', () => {
    it('should find clips by text content', () => {
      recordClip('TypeScript compiler', 'https://ts.dev')
      recordClip('JavaScript runtime', 'https://js.dev')
      recordClip('Python interpreter', 'https://py.org')

      const results = searchClips('script')
      expect(results.length).toBe(2)
    })

    it('should return empty array for no matches', () => {
      recordClip('Hello world', '')
      const results = searchClips('nonexistent')
      expect(results.length).toBe(0)
    })
  })

  describe('getRecentClips', () => {
    it('should return clips in reverse chronological order', () => {
      recordClip('first', '')
      recordClip('second', '')
      recordClip('third', '')

      const recent = getRecentClips(3)
      expect(recent[0].text).toBe('third')
      expect(recent[2].text).toBe('first')
    })

    it('should respect limit parameter', () => {
      recordClip('a', '')
      recordClip('b', '')
      recordClip('c', '')

      const recent = getRecentClips(2)
      expect(recent.length).toBe(2)
    })
  })
})
