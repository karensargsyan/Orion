import { describe, it, expect, beforeEach } from 'vitest'
import { logError, getRecentErrors, getErrorCount, clearErrors, formatDebugInfo } from '../../src/background/error-logger'

describe('error-logger', () => {
  beforeEach(() => {
    clearErrors()
  })

  describe('logError', () => {
    it('should log an Error object', () => {
      logError('test-module', new Error('boom'))
      const errors = getRecentErrors(10)
      expect(errors.length).toBe(1)
      expect(errors[0].module).toBe('test-module')
      expect(errors[0].message).toBe('boom')
      expect(errors[0].stack).toBeDefined()
    })

    it('should log a string error', () => {
      logError('mod', 'something went wrong')
      const errors = getRecentErrors(10)
      expect(errors[0].message).toBe('something went wrong')
      expect(errors[0].stack).toBeUndefined()
    })

    it('should log a number error', () => {
      logError('mod', 404)
      expect(getRecentErrors(1)[0].message).toBe('404')
    })

    it('should truncate stack to 500 chars', () => {
      const err = new Error('x')
      err.stack = 'a'.repeat(1000)
      logError('mod', err)
      expect(getRecentErrors(1)[0].stack!.length).toBe(500)
    })

    it('should enforce circular buffer limit of 200', () => {
      for (let i = 0; i < 210; i++) {
        logError('mod', `error ${i}`)
      }
      expect(getErrorCount()).toBe(200)
    })

    it('should evict oldest entries when buffer overflows', () => {
      for (let i = 0; i < 205; i++) {
        logError('mod', `error ${i}`)
      }
      // Oldest surviving should be error 5 (0–4 evicted)
      const all = getRecentErrors(200)
      const oldest = all[all.length - 1]
      expect(oldest.message).toBe('error 5')
    })
  })

  describe('getRecentErrors', () => {
    it('should return newest first', () => {
      logError('a', 'first')
      logError('b', 'second')
      logError('c', 'third')

      const errors = getRecentErrors(3)
      expect(errors[0].message).toBe('third')
      expect(errors[2].message).toBe('first')
    })

    it('should respect limit', () => {
      logError('a', '1')
      logError('a', '2')
      logError('a', '3')

      const errors = getRecentErrors(2)
      expect(errors.length).toBe(2)
      expect(errors[0].message).toBe('3')
      expect(errors[1].message).toBe('2')
    })
  })

  describe('getErrorCount', () => {
    it('should return 0 when empty', () => {
      expect(getErrorCount()).toBe(0)
    })

    it('should return correct count', () => {
      logError('a', '1')
      logError('a', '2')
      expect(getErrorCount()).toBe(2)
    })
  })

  describe('clearErrors', () => {
    it('should empty the buffer', () => {
      logError('a', '1')
      logError('a', '2')
      clearErrors()
      expect(getErrorCount()).toBe(0)
      expect(getRecentErrors(10)).toEqual([])
    })
  })

  describe('formatDebugInfo', () => {
    it('should return a formatted debug string', () => {
      logError('net', 'timeout')
      const info = formatDebugInfo()
      expect(info).toContain('Orion Debug Report')
      expect(info).toContain('Errors: 1/200')
      expect(info).toContain('net: timeout')
    })

    it('should include stack traces when present', () => {
      logError('ai', new Error('connection refused'))
      const info = formatDebugInfo()
      expect(info).toContain('connection refused')
    })
  })
})
