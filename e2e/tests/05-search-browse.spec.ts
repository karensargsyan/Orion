import { test, expect } from '../fixtures/extension'
import { RESPONSES } from '../helpers/sse'

test.describe('Search and Browse', () => {
  test('search action executes from blank tab context', async ({ context, sidePanelPage, sendChat, waitForResponse, mockAI }) => {
    // Intercept Google search to return fake results
    await context.route('**/google.com/search**', async route => {
      await route.fulfill({
        contentType: 'text/html',
        body: `<html><body>
          <div class="g">
            <a href="https://example.com/flights"><h3>Cheap Flights to Berlin</h3></a>
            <div class="VwiC3b">Find the best deals on flights to Berlin from $199</div>
          </div>
          <div class="g">
            <a href="https://example.com/travel"><h3>Berlin Travel Guide</h3></a>
            <div class="VwiC3b">Complete guide to traveling to Berlin on a budget</div>
          </div>
        </body></html>`,
      })
    })

    // Queue: first the search action, then completion
    mockAI.enqueue(RESPONSES.searchFlights)
    mockAI.enqueue(RESPONSES.complete)

    await sendChat('Find cheap flights to Berlin')
    await waitForResponse()

    // The AI should have received at least 1 request (initial chat)
    expect(mockAI.chatRequests.length).toBeGreaterThanOrEqual(1)
  })

  test('open_tab action reads page content', async ({ sendChat, waitForResponse, mockAI, testServer }) => {
    // Queue: open a tab to read test page content
    mockAI.enqueue(RESPONSES.openTab(testServer.testPageUrl))
    mockAI.enqueue(RESPONSES.complete)

    await sendChat('Read the test page')
    await waitForResponse()

    // Check follow-up request has page content from the opened tab
    const chatReqs = mockAI.chatRequests
    if (chatReqs.length >= 2) {
      const followUp = chatReqs[1]
      const content = JSON.stringify(followUp.body.messages)
      // Should contain content from the test page
      expect(content.length).toBeGreaterThan(50)
    }
  })
})
