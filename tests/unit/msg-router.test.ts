import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerHandler, registerHandlers, routeMessage, hasHandler, getHandlerCount } from '../../src/background/handlers/msg-router'

// The module uses a module-level Map, so we need to reset between tests.
// We'll re-import fresh each time via vitest's module isolation.

// Since the handlers Map persists, we track state across tests in this file.
// Tests are written to be order-independent by using unique type names.

describe('msg-router', () => {
  const mockSender = {} as chrome.runtime.MessageSender

  describe('registerHandler', () => {
    it('should register a handler', () => {
      registerHandler('TEST_A', async () => ({ ok: true }))
      expect(hasHandler('TEST_A')).toBe(true)
    })

    it('should overwrite existing handler with warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      registerHandler('TEST_B', async () => 1)
      registerHandler('TEST_B', async () => 2) // overwrite
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TEST_B'))
      warnSpy.mockRestore()
    })
  })

  describe('registerHandlers', () => {
    it('should register multiple handlers', () => {
      registerHandlers({
        TEST_C: async () => 'c',
        TEST_D: async () => 'd',
      })
      expect(hasHandler('TEST_C')).toBe(true)
      expect(hasHandler('TEST_D')).toBe(true)
    })
  })

  describe('routeMessage', () => {
    it('should route to correct handler', async () => {
      registerHandler('TEST_ROUTE', async (msg) => ({ echo: msg.value }))
      const result = await routeMessage({ type: 'TEST_ROUTE', value: 42 }, mockSender)
      expect(result).toEqual({ echo: 42 })
    })

    it('should return undefined for unknown type', async () => {
      const result = await routeMessage({ type: 'NONEXISTENT_XYZ' }, mockSender)
      expect(result).toBeUndefined()
    })

    it('should return undefined for missing type', async () => {
      const result = await routeMessage({}, mockSender)
      expect(result).toBeUndefined()
    })

    it('should pass sender to handler', async () => {
      const sender = { id: 'test-ext' } as chrome.runtime.MessageSender
      registerHandler('TEST_SENDER', async (_msg, s) => ({ senderId: s.id }))
      const result = await routeMessage({ type: 'TEST_SENDER' }, sender)
      expect(result).toEqual({ senderId: 'test-ext' })
    })

    it('should handle sync handlers', async () => {
      registerHandler('TEST_SYNC', () => 'sync-result')
      const result = await routeMessage({ type: 'TEST_SYNC' }, mockSender)
      expect(result).toBe('sync-result')
    })
  })

  describe('hasHandler', () => {
    it('should return false for unregistered type', () => {
      expect(hasHandler('TOTALLY_UNKNOWN_999')).toBe(false)
    })
  })

  describe('getHandlerCount', () => {
    it('should return number of registered handlers', () => {
      const count = getHandlerCount()
      expect(count).toBeGreaterThan(0) // we've registered several above
    })
  })
})
