/**
 * Tab-level safety indicator: green (low risk), orange (caution), red (high risk).
 * Informational only — not a guarantee of safety.
 */

export type SafetyLevel = 'safe' | 'warn' | 'danger'

const BORDER_ID = '__orion-safety-border'
const STYLE_ID = `${BORDER_ID}-style`

const COLORS: Record<SafetyLevel, { border: string; glow: string; label: string }> = {
  safe: {
    border: 'rgba(34,197,94,0.75)',
    glow: 'rgba(34,197,94,0.12)',
    label: 'Heuristic: lower concern',
  },
  warn: {
    border: 'rgba(249,115,22,0.85)',
    glow: 'rgba(249,115,22,0.15)',
    label: 'Heuristic: review carefully — content may be misleading',
  },
  danger: {
    border: 'rgba(239,68,68,0.9)',
    glow: 'rgba(239,68,68,0.18)',
    label: 'Heuristic: high concern — possible phishing or unsafe patterns',
  },
}

export function showSafetyBorder(level: SafetyLevel, detail?: string): void {
  hideSafetyBorder()

  const cfg = COLORS[level]
  const el = document.createElement('div')
  el.id = BORDER_ID
  el.setAttribute('role', 'presentation')
  el.style.cssText = `
    position:fixed;inset:0;pointer-events:none;z-index:2147483640;
    border:3px solid ${cfg.border};
    box-shadow:inset 0 0 40px ${cfg.glow};
    border-radius:0;
  `

  const badge = document.createElement('div')
  badge.textContent = cfg.label + (detail ? ` — ${detail.slice(0, 120)}` : '')
  badge.style.cssText = `
    position:fixed;top:4px;right:8px;max-width:min(96vw,420px);pointer-events:none;
    font:11px/1.35 system-ui,sans-serif;padding:6px 10px;border-radius:6px;
    background:rgba(15,15,20,0.88);color:#f3f4f6;z-index:2147483641;
    border:1px solid ${cfg.border};
  `
  badge.id = `${BORDER_ID}-badge`

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    @keyframes __orion-safety-pulse {
      0%,100%{opacity:1} 50%{opacity:0.92}
    }
    #${BORDER_ID} { animation: __orion-safety-pulse 4s ease-in-out infinite; }
  `

  document.head.appendChild(style)
  document.body.appendChild(el)
  document.body.appendChild(badge)
}

export function hideSafetyBorder(): void {
  document.getElementById(BORDER_ID)?.remove()
  document.getElementById(`${BORDER_ID}-badge`)?.remove()
  document.getElementById(STYLE_ID)?.remove()
}

export function applySafetyBorderMessage(msg: Record<string, unknown>): void {
  if (msg.hidden) {
    hideSafetyBorder()
    return
  }
  const level = (msg.level as SafetyLevel) ?? 'safe'
  const detail = msg.detail as string | undefined
  showSafetyBorder(level, detail)
}
