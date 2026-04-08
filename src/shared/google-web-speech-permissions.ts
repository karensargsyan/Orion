/**
 * Web Speech reaches Google via the browser engine, not extension fetches.
 * Host access for the extension is already covered by manifest host_permissions (including all_urls),
 * so optional google.com/gstatic patterns are redundant and Chrome omits them.
 */

export function extensionSiteSettingsUrl(): string {
  const id = chrome.runtime.id
  const site = `chrome-extension://${id}/`
  return `chrome://settings/content/siteDetails?site=${encodeURIComponent(site)}`
}

export const WEB_SPEECH_NETWORK_NOTE =
  'This extension already has broad host access in its manifest, so there is nothing extra to grant for “Google hosts.” '
  + 'If Web Speech still fails—especially in Brave—that is usually Shields or the browser blocking the speech service, not a missing extension permission. '
  + 'Lower Shields for this extension or use Local Whisper Server under Speech Recognition.'
