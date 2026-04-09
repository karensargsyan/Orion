import { test, expect } from '../fixtures/extension'
import { RESPONSES } from '../helpers/sse'

test.describe('Basic Chat', () => {
  test('user message appears in chat', async ({ sidePanelPage, sendChat, mockAI }) => {
    mockAI.enqueue(RESPONSES.hello)
    await sendChat('Hello there')

    // User message should appear
    const userMsg = sidePanelPage.locator('.message-user').last()
    await expect(userMsg).toContainText('Hello there')
  })

  test('AI streaming response renders', async ({ sendChat, waitForResponse, mockAI }) => {
    mockAI.enqueue(RESPONSES.hello)
    await sendChat('Hi')
    const response = await waitForResponse()
    expect(response).toContain('Hello')
    expect(response).toContain('help you today')
  })

  test('typing indicator shows during streaming', async ({ sidePanelPage, sendChat, mockAI }) => {
    // Queue a response with delay to catch the typing indicator
    mockAI.enqueue('This is a longer response that takes time to stream.', { delay: 200 })
    await sendChat('Tell me something')

    // During streaming, the stop button should be visible
    await expect(sidePanelPage.locator('.btn-stop-tab')).toBeVisible({ timeout: 5000 })
  })

  test('stop button aborts stream', async ({ sidePanelPage, sendChat, mockAI }) => {
    // Queue a very long response
    mockAI.enqueue('Word '.repeat(200), { delay: 100 })
    await sendChat('Tell me a long story')

    // Wait for streaming to start
    await expect(sidePanelPage.locator('.btn-stop-tab')).toBeVisible({ timeout: 5000 })

    // Click stop
    await sidePanelPage.locator('.btn-stop-tab').click()

    // Send button should reappear
    await expect(sidePanelPage.locator('.btn-send-tab')).toBeVisible({ timeout: 5000 })
  })

  test('multiple messages create conversation', async ({ sidePanelPage, sendChat, waitForResponse, mockAI }) => {
    mockAI.enqueue('First response. {"is_complete": true}')
    await sendChat('First message')
    await waitForResponse()

    mockAI.enqueue('Second response. {"is_complete": true}')
    await sendChat('Second message')
    await waitForResponse()

    // Should have 2 user messages and 2 assistant messages
    const userMsgs = sidePanelPage.locator('.message-user')
    const assistantMsgs = sidePanelPage.locator('.message-assistant')
    expect(await userMsgs.count()).toBeGreaterThanOrEqual(2)
    expect(await assistantMsgs.count()).toBeGreaterThanOrEqual(2)
  })

  test('mock server records requests correctly', async ({ sendChat, waitForResponse, mockAI }) => {
    mockAI.enqueue('Test response.')
    await sendChat('Test message')
    await waitForResponse()

    // Check that the mock server received the request
    const chatReqs = mockAI.chatRequests
    expect(chatReqs.length).toBeGreaterThanOrEqual(1)

    // Verify the request contains our message
    const lastReq = chatReqs[chatReqs.length - 1]
    expect(lastReq.body.messages).toBeDefined()
    const userMessages = lastReq.body.messages.filter((m: any) => m.role === 'user')
    expect(userMessages.length).toBeGreaterThan(0)
  })
})
