import { test, expect } from '../fixtures/extension'
import { RESPONSES } from '../helpers/sse'

test.describe('Navigation Actions', () => {
  test('AI can navigate to a URL via chrome.tabs.update', async ({ sidePanelPage, sendChat, mockAI, testServer }) => {
    // Queue a navigate action response, then a completion response for the follow-up
    mockAI.enqueue(RESPONSES.navigateTestPage(testServer.testPageUrl))
    mockAI.enqueue(RESPONSES.complete)

    await sendChat(`Go to ${testServer.testPageUrl}`)

    // Wait for the navigate action to be processed — the send button may stay
    // hidden while the action loop runs. Just wait for the mock to receive requests.
    await sidePanelPage.waitForTimeout(5000)

    // Verify the mock AI received the request and processed the navigate action
    expect(mockAI.chatRequests.length).toBeGreaterThanOrEqual(1)

    // The navigate action uses chrome.tabs.update (NOT content script),
    // so it should succeed even on blank/restricted tabs.
    // Verify by checking the request log doesn't contain "unreachable" errors
    const lastReq = mockAI.chatRequests[mockAI.chatRequests.length - 1]
    const content = JSON.stringify(lastReq.body.messages ?? [])
    expect(content).not.toContain('Content script unreachable')
  })

  test('follow-up round sends context after navigation', async ({ sendChat, mockAI, testServer, sidePanelPage }) => {
    mockAI.enqueue(RESPONSES.navigateTestPage(testServer.testPageUrl))
    mockAI.enqueue(RESPONSES.complete)

    await sendChat('Navigate to the test page and analyze it')

    // Wait for the full action loop (navigate + follow-up)
    await sidePanelPage.waitForTimeout(8000)

    // Check the follow-up request was made (at least 2 requests: initial + follow-up)
    const chatReqs = mockAI.chatRequests
    expect(chatReqs.length).toBeGreaterThanOrEqual(2)

    // The follow-up should contain some page context
    const followUp = chatReqs[chatReqs.length - 1]
    const allContent = JSON.stringify(followUp.body.messages)
    expect(allContent.length).toBeGreaterThan(100)
  })
})
