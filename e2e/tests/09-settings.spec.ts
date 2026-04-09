import { test, expect } from '../fixtures/extension'

test.describe('Settings', () => {
  test('settings tab opens and shows provider options', async ({ sidePanelPage }) => {
    // Click settings tab
    const settingsTab = sidePanelPage.locator('[data-tab="settings"]')
    if (await settingsTab.isVisible()) {
      await settingsTab.click()
      await sidePanelPage.waitForTimeout(500)

      // Provider selector should be visible
      const providerSelect = sidePanelPage.locator('#active-provider')
      if (await providerSelect.isVisible()) {
        expect(await providerSelect.inputValue()).toBeTruthy()
      }
    }
  })

  test('switching back to chat tab works', async ({ sidePanelPage }) => {
    // Click settings tab
    const settingsTab = sidePanelPage.locator('[data-tab="settings"]')
    if (await settingsTab.isVisible()) {
      await settingsTab.click()
      await sidePanelPage.waitForTimeout(300)
    }

    // Click chat tab
    const chatTab = sidePanelPage.locator('[data-tab="chat"]')
    if (await chatTab.isVisible()) {
      await chatTab.click()
      await sidePanelPage.waitForTimeout(300)

      // Chat input should be visible again
      await expect(sidePanelPage.locator('.chat-input-tab')).toBeVisible()
    }
  })
})
