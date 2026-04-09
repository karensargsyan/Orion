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
    `Web Speech uses Google\u2019s online recognition service; this browser blocked the connection (network, VPN, firewall, or Shields). `
    + `Switch to Settings \u2192 Speech Recognition \u2192 Local Whisper Server for STT on your machine, or fix the connection and retry.`

  if (isLikelyBraveBrowser()) {
    return (
      `Brave blocks Google\u2019s speech service by default (even with Shields off). `
      + `To enable Web Speech in Brave: open brave://flags, search "Web Speech API", set it to Enabled, then restart Brave. `
      + `Alternative: use Local Whisper Server in Settings \u2192 Speech Recognition (recommended \u2014 audio stays on your machine).`
    )
  }
  return generic
}
