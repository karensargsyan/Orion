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
 * User-facing explanation when Web Speech fails with a network error.
 *
 * Brave permanently blocks Google’s speech service at the code level — there is no flag or setting
 * to re-enable it. The only in-extension alternative is Local Whisper. OS-level dictation also works.
 */
export function getWebSpeechNetworkBlockedMessage(): string {
  const generic =
    `Web Speech uses Google\u2019s online service and this browser blocked the connection. `
    + `Options: (1) Switch to Local Whisper Server in Settings \u2192 Speech Recognition (works offline, audio stays local). `
    + `(2) Use OS dictation instead (Mac: Fn key twice, Windows: Win+H). `
    + `(3) Check your network/firewall if you believe this browser should support Web Speech.`

  if (isLikelyBraveBrowser()) {
    return (
      `Brave permanently blocks Google\u2019s speech service \u2014 there is no flag or setting to enable it. `
      + `Options: (1) Use Local Whisper Server in Settings \u2192 Speech Recognition (recommended \u2014 works offline, audio stays on your machine). `
      + `(2) Use OS dictation (Mac: press Fn twice, Windows: Win+H) \u2014 works in any app. `
      + `(3) Use Chrome or Edge if you need Google Web Speech.`
    )
  }
  return generic
}
