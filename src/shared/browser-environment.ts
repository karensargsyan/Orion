/** Brave often omits "Brave" from userAgent; `navigator.brave.isBrave()` is the reliable signal. */

export function isLikelyBraveBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  if (/Brave/i.test(navigator.userAgent)) return true
  const b = (navigator as Navigator & { brave?: unknown }).brave
  return typeof b === 'object' && b !== null
}

export async function isBraveBrowserAsync(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false
  if (/Brave/i.test(navigator.userAgent)) return true
  const brave = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave
  if (!brave?.isBrave) return false
  try {
    return await brave.isBrave()
  } catch {
    return false
  }
}

/**
 * User-facing explanation when Web Speech fails with a network error (often Brave Shields or offline).
 * Shared by side panel formatting and the offscreen STT document.
 *
 * Brave: there is no second “Brave-only” speech engine exposed to extensions—Web Speech still uses Google’s
 * service, which Shields often blocks. The practical alternative in Brave is Local Whisper (this extension).
 */
export function getWebSpeechNetworkBlockedMessage(): string {
  const generic =
    'Web Speech uses Google’s online recognition service; this browser blocked the connection (network, VPN, firewall, or Shields). '
    + 'Switch to Settings → Speech Recognition → Local Whisper Server for STT on your machine, or fix the connection and retry.'

  if (isLikelyBraveBrowser()) {
    return (
      'Brave does not provide a different built-in speech-to-text API for extensions—Web Speech still reaches Google’s servers, and Shields often blocks that. '
      + 'Practical options: (1) Settings → Speech Recognition → Local Whisper Server (recommended; audio stays local and works in Brave). '
      + '(2) Address bar Brave icon → Shields → turn off for this extension, then retry Web Speech. '
      + '(3) Use Chrome for Web Speech if you are not running a local Whisper server.'
    )
  }
  return generic
}
