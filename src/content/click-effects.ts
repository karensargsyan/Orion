const EFFECT_ID_PREFIX = '__localai-click-effect-'
const STYLE_ID = '__localai-click-effects-style'

let styleInjected = false

function injectStyles(): void {
  if (styleInjected) return
  if (document.getElementById(STYLE_ID)) { styleInjected = true; return }

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    @keyframes __localai-ripple {
      0% { transform: translate(-50%, -50%) scale(0); opacity: 0.7; }
      70% { transform: translate(-50%, -50%) scale(1); opacity: 0.3; }
      100% { transform: translate(-50%, -50%) scale(1.2); opacity: 0; }
    }
    @keyframes __localai-dot-pulse {
      0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
      100% { transform: translate(-50%, -50%) scale(0.3); opacity: 0; }
    }
  `
  document.head.appendChild(style)
  styleInjected = true
}

export function showClickEffect(x: number, y: number): void {
  injectStyles()

  const id = `${EFFECT_ID_PREFIX}${Date.now()}`

  const ripple = document.createElement('div')
  ripple.id = id
  ripple.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y}px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 2px solid rgba(108, 92, 231, 0.8);
    background: radial-gradient(circle, rgba(108, 92, 231, 0.25) 0%, transparent 70%);
    pointer-events: none;
    z-index: 2147483646;
    animation: __localai-ripple 500ms ease-out forwards;
  `

  const dot = document.createElement('div')
  dot.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y}px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: rgba(108, 92, 231, 0.9);
    pointer-events: none;
    z-index: 2147483646;
    animation: __localai-dot-pulse 400ms ease-out 100ms forwards;
  `

  document.body.appendChild(ripple)
  document.body.appendChild(dot)

  setTimeout(() => {
    ripple.remove()
    dot.remove()
  }, 600)
}

export function showClickEffectOnElement(el: HTMLElement): void {
  const rect = el.getBoundingClientRect()
  showClickEffect(rect.left + rect.width / 2, rect.top + rect.height / 2)
}
