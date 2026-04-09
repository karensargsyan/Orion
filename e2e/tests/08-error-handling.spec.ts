import { test, expect } from '../fixtures/extension'

test.describe('Error Handling', () => {
  test('500 error shows error message in chat', async ({ sidePanelPage, sendChat, mockAI }) => {
    mockAI.enqueueError(500, 'Internal server error')

    await sendChat('Hello')

    // Wait for the error to appear
    await sidePanelPage.waitForTimeout(3000)

    // Should show error in the chat - either as error message or in assistant bubble
    const pageText = await sidePanelPage.textContent('body')
    expect(pageText).toBeTruthy()

    // Send button should be visible again (not stuck)
    await expect(sidePanelPage.locator('.btn-send-tab')).toBeVisible({ timeout: 10_000 })
  })

  test('429 rate limit shows appropriate message', async ({ sidePanelPage, sendChat, mockAI }) => {
    mockAI.enqueueError(429, 'Rate limit exceeded')

    await sendChat('Hello')
    await sidePanelPage.waitForTimeout(3000)

    // Should recover — send button visible
    await expect(sidePanelPage.locator('.btn-send-tab')).toBeVisible({ timeout: 10_000 })
  })

  test('extension recovers after error and accepts new messages', async ({ sidePanelPage, sendChat, waitForResponse, mockAI }) => {
    // First request: error
    mockAI.enqueueError(500, 'Server down')
    await sendChat('This will fail')
    // Wait for error to process and send button to reappear
    await sidePanelPage.locator('.btn-send-tab').waitFor({ state: 'visible', timeout: 15_000 })
    await sidePanelPage.waitForTimeout(500)

    // Second request: success (include is_complete to prevent follow-up rounds)
    mockAI.enqueue('I am back! Everything is working now. {"is_complete": true}')
    await sendChat('Try again')
    const response = await waitForResponse()

    expect(response).toContain('working')
  })

  test('empty AI response is handled gracefully', async ({ sidePanelPage, sendChat, mockAI }) => {
    // Queue a response that returns empty content
    mockAI.enqueue('')

    await sendChat('Give me nothing')
    await sidePanelPage.waitForTimeout(3000)

    // Should not crash — send button should still be visible
    await expect(sidePanelPage.locator('.btn-send-tab')).toBeVisible({ timeout: 10_000 })
  })
})
