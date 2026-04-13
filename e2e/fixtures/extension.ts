/**
 * Playwright fixture that launches Chrome with the extension loaded,
 * discovers the extension ID, and provides helpers for tests.
 */
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { AIMockServer } from './ai-mock-server'
import { RealAIProvider, type AIProvider } from './real-ai-provider'
import { TestServer } from './test-server'

const PROJECT_ROOT = path.resolve(__dirname, '../..')
const DIST_DIR = path.join(PROJECT_ROOT, 'dist')
const USER_DATA_DIR = path.join(PROJECT_ROOT, '.test-chrome-profile')

export interface ExtensionFixtures {
  context: BrowserContext
  extensionId: string
  sidePanelPage: Page
  serviceWorker: Worker
  mockAI: AIMockServer
  testServer: TestServer
  /** Navigate a page and wait for content script */
  navigateAndWait: (page: Page, url: string) => Promise<void>
  /** Send a chat message from the side panel */
  sendChat: (text: string) => Promise<void>
  /** Wait for assistant response to finish */
  waitForResponse: () => Promise<string>
}

export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    // Ensure dist exists
    if (!fs.existsSync(path.join(DIST_DIR, 'manifest.json'))) {
      throw new Error(`Extension not built. Run "npm run build" first. Expected: ${DIST_DIR}/manifest.json`)
    }

    // Clean up old profile
    if (fs.existsSync(USER_DATA_DIR)) {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
    }

    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      args: [
        `--disable-extensions-except=${DIST_DIR}`,
        `--load-extension=${DIST_DIR}`,
        '--no-first-run',
        '--disable-default-apps',
        '--disable-popup-blocking',
        '--disable-translate',
        '--disable-sync',
        '--disable-background-timer-throttling',
      ],
    })

    await use(context)

    await context.close()
    // Clean up profile
    if (fs.existsSync(USER_DATA_DIR)) {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
    }
  },

  serviceWorker: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0]
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 10_000 })
    }
    await use(sw)
  },

  extensionId: async ({ serviceWorker }, use) => {
    const url = serviceWorker.url()
    // URL format: chrome-extension://<ID>/background/service-worker.js
    const match = url.match(/chrome-extension:\/\/([^/]+)/)
    if (!match) throw new Error(`Could not extract extension ID from SW URL: ${url}`)
    await use(match[1])
  },

  mockAI: async ({}, use) => {
    // Check if real AI testing is enabled
    const useRealAI = process.env.USE_REAL_AI === 'true'
    const provider = (process.env.PROVIDER || 'gemini') as AIProvider

    if (useRealAI) {
      console.log(`[Test] Using REAL AI: ${provider}`)
      const realAI = new RealAIProvider({
        provider,
        geminiApiKey: process.env.GEMINI_API_KEY,
        lmStudioUrl: process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234',
        lmStudioModel: process.env.LM_STUDIO_MODEL || 'test-model',
        openaiApiKey: process.env.OPENAI_API_KEY,
        openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      })
      await realAI.start()
      // Cast to AIMockServer interface for compatibility (RealAIProvider implements same interface)
      await use(realAI as any)
      await realAI.stop()
    } else {
      console.log('[Test] Using MOCK AI')
      const server = new AIMockServer()
      await server.start()
      await use(server)
      await server.stop()
    }
  },

  testServer: async ({}, use) => {
    const server = new TestServer(PROJECT_ROOT)
    await server.start()
    await use(server)
    await server.stop()
  },

  sidePanelPage: async ({ context, extensionId, mockAI, serviceWorker }, use) => {
    // Pre-seed settings via IndexedDB in the service worker context.
    // Settings are stored as individual key-value rows in IDB store "settings".
    // The SW may have already cached stale settings during init — we'll clear
    // the cache later from the page context using SETTINGS_SET message.
    await serviceWorker.evaluate(async (mockUrl: string) => {
      const DB_NAME = 'pwa_memory'
      const DB_VERSION = 11

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          const d = req.result
          // Create stores if they don't exist (first run) — keep in sync with idb.ts v11
          const stores = ['chat_history', 'session_memory', 'global_memory', 'vault',
            'settings', 'calendar_events', 'habit_patterns', 'domain_skills',
            'user_behaviors', 'learning_sessions', 'supervised_playbooks',
            'supervised_sessions', 'visual_sitemap', 'local_memory', 'input_journal',
            'pinned_facts', 'workflows']
          for (const name of stores) {
            if (!d.objectStoreNames.contains(name)) {
              d.createObjectStore(name, { keyPath: 'key' })
            }
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })

      const settings: Record<string, unknown> = {
        activeProvider: 'local',
        lmStudioUrl: mockUrl,
        lmStudioModel: 'test-model',
        authToken: 'test-token',
        onboardingComplete: true,
        rateLimitRpm: 100,
        monitoringEnabled: false,
        visionEnabled: false,
        liteMode: false,
        maxContextMessages: 20,
        hasPinSetup: false,
        safetyBorderEnabled: false,
        screenshotLoopEnabled: false,
        screenshotIntervalSec: 10,
        composeAssistantEnabled: false,
        textRewriteEnabled: false,
        calendarDetectionEnabled: false,
        aiActionLearningEnabled: false,
        sttProvider: 'web-speech',
        confirmationPreferences: [],
        globalAutoAccept: true,
        automationPreference: 'auto',  // skip mode-choice dialog in tests
      }

      const tx = db.transaction('settings', 'readwrite')
      const store = tx.objectStore('settings')
      for (const [key, value] of Object.entries(settings)) {
        store.put({ key, value })
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    }, mockAI.url)

    // Open side panel as a regular tab
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    })

    // Wait for the page to initialize its JS
    await page.waitForTimeout(1000)

    // Send SETTINGS_SET from the PAGE context (not service worker).
    // chrome.runtime.sendMessage from an extension page correctly triggers
    // the SW's onMessage listener, which calls setSettings() + clears the cache.
    // A service worker cannot sendMessage to itself — that was the previous bug.
    await page.evaluate(async (mockUrl: string) => {
      await (globalThis as any).chrome.runtime.sendMessage({
        type: 'SETTINGS_SET',
        partial: {
          activeProvider: 'local',
          lmStudioUrl: mockUrl,
          lmStudioModel: 'test-model',
          authToken: 'test-token',
          onboardingComplete: true,
          rateLimitRpm: 100,
          monitoringEnabled: false,
          visionEnabled: false,
          liteMode: false,
          maxContextMessages: 20,
          safetyBorderEnabled: false,
          screenshotLoopEnabled: false,
          composeAssistantEnabled: false,
          textRewriteEnabled: false,
          calendarDetectionEnabled: false,
          aiActionLearningEnabled: false,
          globalAutoAccept: true,
          automationPreference: 'auto',  // skip mode-choice dialog in tests
        },
      })
    }, mockAI.url)

    // Reload the side panel to pick up the new settings
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    // If onboarding is still showing, try one more reload
    const hasChat = await page.locator('.chat-input-tab').isVisible().catch(() => false)
    if (!hasChat) {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1000)
    }

    // Wait for the chat UI to initialize
    await page.waitForSelector('.chat-input-tab', { timeout: 15_000 })

    // The side panel auto-triggers triggerPageAnalysis() on load, which
    // streams an AI response. Wait for it to finish (send button reappears)
    // before starting the test.
    await page.locator('.btn-send-tab').waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(500)

    // Clear any responses/requests consumed by page analysis
    mockAI.reset()

    await use(page)
  },

  sendChat: async ({ sidePanelPage }, use) => {
    const fn = async (text: string) => {
      const input = sidePanelPage.locator('.chat-input-tab')
      await input.fill(text)
      await sidePanelPage.locator('.btn-send-tab').click()
    }
    await use(fn)
  },

  waitForResponse: async ({ sidePanelPage }, use) => {
    const fn = async (): Promise<string> => {
      // Wait for streaming to finish — stop button disappears, send button reappears
      await sidePanelPage.locator('.btn-send-tab').waitFor({ state: 'visible', timeout: 30_000 })
      // Extra wait for action loop processing and final DOM render
      await sidePanelPage.waitForTimeout(1000)

      // Get the last NON-EMPTY assistant message.
      // The action loop may create an empty trailing bubble for a follow-up
      // that hasn't finished yet — skip those.
      const messages = sidePanelPage.locator('.message-assistant')
      const count = await messages.count()
      for (let i = count - 1; i >= 0; i--) {
        const text = await messages.nth(i).textContent()
        if (text && text.trim()) return text.trim()
      }
      return ''
    }
    await use(fn)
  },

  navigateAndWait: async ({}, use) => {
    const fn = async (page: Page, url: string) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      // Wait for content script to inject (it sets up message listeners)
      await page.waitForTimeout(1000)
    }
    await use(fn)
  },
})

export { expect } from '@playwright/test'
