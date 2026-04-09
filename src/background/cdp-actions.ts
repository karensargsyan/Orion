/**
 * CDP Action Primitives — executes browser actions via Chrome DevTools Protocol.
 *
 * All actions produce TRUSTED browser events (isTrusted: true) that modern
 * frameworks like Gmail, React, Angular, and Vue respond to correctly.
 * This replaces the unreliable synthetic-event approach from content scripts.
 */

import { cdpSend, isSessionActive } from './cdp-session'

// ─── Click ───────────────────────────────────────────────────────────────────

/** Trusted click at pixel coordinates. Returns false if CDP unavailable. */
export async function cdpClickAt(tabId: number, x: number, y: number): Promise<boolean> {
  if (!isSessionActive(tabId)) return false
  try {
    // Move mouse to target (generates hover/enter events)
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    })
    // Press
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    })
    // Release
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    })
    return true
  } catch {
    return false
  }
}

/** Trusted double-click at pixel coordinates. */
export async function cdpDoubleClickAt(tabId: number, x: number, y: number): Promise<boolean> {
  if (!isSessionActive(tabId)) return false
  try {
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    })
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    })
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    })
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 2,
    })
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 2,
    })
    return true
  } catch {
    return false
  }
}

/** Trusted hover (mouse move) at pixel coordinates. */
export async function cdpHoverAt(tabId: number, x: number, y: number): Promise<boolean> {
  if (!isSessionActive(tabId)) return false
  try {
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    })
    return true
  } catch {
    return false
  }
}

// ─── Typing ──────────────────────────────────────────────────────────────────

/**
 * Trusted text insertion. Uses Input.insertText which generates a trusted
 * InputEvent that React's onChange and Angular's ngModel detect correctly.
 */
export async function cdpTypeText(tabId: number, text: string): Promise<boolean> {
  if (!isSessionActive(tabId)) return false
  try {
    await cdpSend(tabId, 'Input.insertText', { text })
    return true
  } catch {
    return false
  }
}

/** Trusted single key press (Enter, Tab, Escape, Backspace, etc.). */
export async function cdpPressKey(
  tabId: number,
  key: string,
  modifiers?: number, // 1=Alt, 2=Ctrl, 4=Meta, 8=Shift
): Promise<boolean> {
  if (!isSessionActive(tabId)) return false

  const keyDef = KEY_MAP[key.toLowerCase()] ?? { key, code: `Key${key.toUpperCase()}` }

  try {
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode ?? 0,
      nativeVirtualKeyCode: keyDef.keyCode ?? 0,
      modifiers: modifiers ?? 0,
    })
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode ?? 0,
      nativeVirtualKeyCode: keyDef.keyCode ?? 0,
      modifiers: modifiers ?? 0,
    })
    return true
  } catch {
    return false
  }
}

const KEY_MAP: Record<string, { key: string; code: string; keyCode?: number }> = {
  enter:     { key: 'Enter',     code: 'Enter',      keyCode: 13 },
  tab:       { key: 'Tab',       code: 'Tab',        keyCode: 9 },
  escape:    { key: 'Escape',    code: 'Escape',     keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace',  keyCode: 8 },
  delete:    { key: 'Delete',    code: 'Delete',     keyCode: 46 },
  arrowup:   { key: 'ArrowUp',   code: 'ArrowUp',    keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown',  keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft',  keyCode: 37 },
  arrowright:{ key: 'ArrowRight',code: 'ArrowRight', keyCode: 39 },
  home:      { key: 'Home',      code: 'Home',       keyCode: 36 },
  end:       { key: 'End',       code: 'End',        keyCode: 35 },
  pageup:    { key: 'PageUp',    code: 'PageUp',     keyCode: 33 },
  pagedown:  { key: 'PageDown',  code: 'PageDown',   keyCode: 34 },
  space:     { key: ' ',         code: 'Space',      keyCode: 32 },
}

// ─── Focus ───────────────────────────────────────────────────────────────────

/** Focus an element by its CDP backend node ID. */
export async function cdpFocusNode(tabId: number, backendNodeId: number): Promise<boolean> {
  if (!isSessionActive(tabId)) return false
  try {
    await cdpSend(tabId, 'DOM.focus', { backendNodeId })
    return true
  } catch {
    return false
  }
}

// ─── Scroll ──────────────────────────────────────────────────────────────────

/** Scroll page via trusted mouse wheel events. */
export async function cdpScrollPage(
  tabId: number,
  direction: 'up' | 'down',
  amount?: number,
): Promise<boolean> {
  if (!isSessionActive(tabId)) return false
  const delta = amount ?? 400
  const deltaY = direction === 'down' ? delta : -delta

  try {
    // Get viewport center for wheel event
    const metrics = await cdpSend<{
      layoutViewport: { clientWidth: number; clientHeight: number }
    }>(tabId, 'Page.getLayoutMetrics')
    const cx = Math.round(metrics.layoutViewport.clientWidth / 2)
    const cy = Math.round(metrics.layoutViewport.clientHeight / 2)

    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY,
    })
    return true
  } catch {
    return false
  }
}

// ─── Wait Utilities ──────────────────────────────────────────────────────────

/** Wait for navigation to complete (frame stopped loading). Max timeout. */
export async function cdpWaitForNavigation(tabId: number, timeoutMs = 5000): Promise<boolean> {
  if (!isSessionActive(tabId)) return false
  return new Promise<boolean>((resolve) => {
    let resolved = false
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(false) }
    }, timeoutMs)

    const handler = (
      source: chrome.debugger.Debuggee,
      method: string,
    ) => {
      if (source.tabId !== tabId) return
      if (method === 'Page.frameStoppedLoading' || method === 'Page.loadEventFired') {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          chrome.debugger.onEvent.removeListener(handler)
          // Small extra delay for SPA post-load rendering
          setTimeout(() => resolve(true), 200)
        }
      }
    }
    chrome.debugger.onEvent.addListener(handler)
  })
}

/**
 * Wait for DOM to stabilize after an action. Listens for DOM.documentUpdated
 * then waits for a quiet period with no further updates.
 */
export async function cdpWaitForDOMStable(tabId: number, timeoutMs = 1500): Promise<boolean> {
  if (!isSessionActive(tabId)) return false

  return new Promise<boolean>((resolve) => {
    let resolved = false
    let quietTimer: ReturnType<typeof setTimeout> | null = null
    const QUIET_MS = 200 // 200ms with no DOM changes = stable

    const deadline = setTimeout(() => {
      cleanup()
      if (!resolved) { resolved = true; resolve(true) } // timeout = assume stable
    }, timeoutMs)

    const handler = (
      source: chrome.debugger.Debuggee,
      method: string,
    ) => {
      if (source.tabId !== tabId) return
      if (method === 'DOM.documentUpdated' || method === 'DOM.childNodeCountUpdated' || method === 'DOM.childNodeInserted') {
        // DOM changed — reset quiet timer
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(() => {
          cleanup()
          if (!resolved) { resolved = true; resolve(true) }
        }, QUIET_MS)
      }
    }

    function cleanup() {
      clearTimeout(deadline)
      if (quietTimer) clearTimeout(quietTimer)
      chrome.debugger.onEvent.removeListener(handler)
    }

    chrome.debugger.onEvent.addListener(handler)

    // If no DOM event fires within 300ms, resolve immediately
    quietTimer = setTimeout(() => {
      cleanup()
      if (!resolved) { resolved = true; resolve(true) }
    }, 300)
  })
}

// ─── Screenshot ──────────────────────────────────────────────────────────────

/** Capture screenshot via CDP (faster when debugger is already attached). */
export async function cdpScreenshot(tabId: number, quality = 30): Promise<string | null> {
  if (!isSessionActive(tabId)) return null
  try {
    const result = await cdpSend<{ data: string }>(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality,
    })
    return `data:image/jpeg;base64,${result.data}`
  } catch {
    return null
  }
}

/**
 * Scroll an element into view using CDP.
 * Uses DOM.scrollIntoViewIfNeeded which handles all scroll containers.
 */
export async function cdpScrollIntoView(tabId: number, backendNodeId: number): Promise<boolean> {
  if (!isSessionActive(tabId)) return false
  try {
    await cdpSend(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
    return true
  } catch {
    return false
  }
}

/**
 * Clear a text field by selecting all content and deleting it.
 */
export async function cdpClearField(tabId: number): Promise<boolean> {
  if (!isSessionActive(tabId)) return false
  try {
    // Select all (Ctrl+A / Cmd+A)
    await cdpPressKey(tabId, 'a', 2) // 2 = Ctrl
    await cdpPressKey(tabId, 'backspace')
    return true
  } catch {
    return false
  }
}
