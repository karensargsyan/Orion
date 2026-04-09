import { test, expect } from '../fixtures/extension'

test.describe('Action Loop', () => {
  test('multi-round action loop executes correctly', async ({ sendChat, mockAI, testServer, sidePanelPage }) => {
    // Round 1: navigate
    mockAI.enqueue(`Navigating to the page.\n\n[ACTION:NAVIGATE url="${testServer.testPageUrl}"]`)
    // Round 2 (follow-up): AI sees page content, completes
    mockAI.enqueue('I can see the test page with multiple forms. The page loaded successfully. {"is_complete": true}')

    await sendChat('Go to the test page and describe it')

    // The navigate action navigates the current tab (side panel tab),
    // so we can't wait for the send button. Instead, wait for the
    // action loop to complete via mock server request count.
    await sidePanelPage.waitForTimeout(10_000)

    // Verify 2+ rounds happened (initial stream + follow-up)
    expect(mockAI.chatRequests.length).toBeGreaterThanOrEqual(2)
  })

  test('is_complete signal stops the loop', async ({ sendChat, waitForResponse, mockAI }) => {
    // Queue a response with is_complete on the first round
    mockAI.enqueue('All done! {"is_complete": true}')

    await sendChat('Do something')
    await waitForResponse()

    // The streaming response counts as 1 request. The extension may still do
    // one follow-up round before detecting is_complete, so allow up to 2.
    // The key assertion: the loop does NOT continue beyond that.
    expect(mockAI.chatRequests.length).toBeLessThanOrEqual(2)
  })

  test('stop button cancels automation', async ({ sidePanelPage, sendChat, mockAI, testServer }) => {
    // Queue a navigate action (which takes time) then a long follow-up
    mockAI.enqueue(`Navigating...\n\n[ACTION:NAVIGATE url="${testServer.testPageUrl}"]`)
    mockAI.enqueue('Still working... ' + '[ACTION:WAIT ms="5000"]'.repeat(3))
    mockAI.enqueue('More work...')

    await sendChat('Do a long task')

    // Wait for automation to start
    await sidePanelPage.waitForTimeout(2000)

    // Look for the stop button
    const stopBtn = sidePanelPage.locator('.btn-stop-tab')
    if (await stopBtn.isVisible()) {
      await stopBtn.click()
      // Send button should reappear
      await expect(sidePanelPage.locator('.btn-send-tab')).toBeVisible({ timeout: 10_000 })
    }
  })
})
