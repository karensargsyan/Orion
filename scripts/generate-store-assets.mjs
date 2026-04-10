/**
 * Generate Chrome Web Store promotional assets for Orion.
 *
 * Generates:
 * - 5 screenshots (1280x800, 24-bit PNG no alpha)
 * - Small promo tile (440x280)
 * - Marquee promo tile (1400x560)
 */
import sharp from 'sharp'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'store-assets')
mkdirSync(OUT_DIR, { recursive: true })

// Orion color palette
const COLORS = {
  bg: '#0f0a1e',
  bgLight: '#1a1040',
  accent: '#6c5ce7',
  accentLight: '#a29bfe',
  accentGlow: '#b8b0ff',
  text: '#ffffff',
  textMuted: '#8b8b9e',
  cardBg: '#1e1445',
  cardBorder: '#2d2060',
  green: '#00d2a0',
  blue: '#4da6ff',
  chatBg: '#151030',
  userBubble: '#6c5ce7',
  aiBubble: '#1e1445',
}

function starField(w, h, count = 40) {
  let stars = ''
  for (let i = 0; i < count; i++) {
    const x = Math.random() * w
    const y = Math.random() * h
    const r = Math.random() * 1.5 + 0.3
    const opacity = Math.random() * 0.4 + 0.1
    stars += `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${opacity}"/>`
  }
  return stars
}

function orionLogo(cx, cy, size) {
  const s = size
  const beltGap = s * 0.12
  const beltCy = cy - s * 0.02
  const beltR = s * 0.022

  return `
    <circle cx="${cx}" cy="${cy}" r="${s * 0.47}" fill="url(#logoBg)"/>
    <circle cx="${cx}" cy="${cy}" r="${s * 0.38}" fill="none" stroke="url(#logoRing)" stroke-width="${s * 0.018}" stroke-opacity="0.7"/>
    <!-- Belt -->
    <circle cx="${cx - beltGap * 1.15}" cy="${beltCy + s * 0.015}" r="${beltR}" fill="#fff" opacity="0.95"/>
    <circle cx="${cx}" cy="${beltCy - s * 0.01}" r="${beltR}" fill="#fff" opacity="0.95"/>
    <circle cx="${cx + beltGap * 1.15}" cy="${beltCy + s * 0.015}" r="${beltR}" fill="#fff" opacity="0.95"/>
    <!-- Shoulders -->
    <circle cx="${cx - s * 0.14}" cy="${cy - s * 0.2}" r="${beltR * 0.85}" fill="#e8c8ff" opacity="0.8"/>
    <circle cx="${cx + s * 0.14}" cy="${cy - s * 0.17}" r="${beltR * 0.75}" fill="#c8d8ff" opacity="0.75"/>
    <!-- Feet -->
    <circle cx="${cx - s * 0.14}" cy="${cy + s * 0.21}" r="${beltR * 0.7}" fill="#a8c8ff" opacity="0.65"/>
    <circle cx="${cx + s * 0.15}" cy="${cy + s * 0.195}" r="${beltR * 0.8}" fill="#c8e0ff" opacity="0.7"/>
  `
}

function logoDefs() {
  return `
    <radialGradient id="logoBg" cx="40%" cy="35%" r="65%">
      <stop offset="0%" stop-color="#2a1f5e"/>
      <stop offset="60%" stop-color="#1a1040"/>
      <stop offset="100%" stop-color="#110b28"/>
    </radialGradient>
    <linearGradient id="logoRing" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#b8b0ff"/>
      <stop offset="50%" stop-color="#6c5ce7"/>
      <stop offset="100%" stop-color="#b8b0ff"/>
    </linearGradient>
  `
}

// --- Screenshot 1: Hero / Chat Interface ------------------------------------
function screenshot1() {
  const w = 1280, h = 800
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    ${logoDefs()}
    <linearGradient id="heroBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f0a1e"/>
      <stop offset="50%" stop-color="#1a1040"/>
      <stop offset="100%" stop-color="#0f0a1e"/>
    </linearGradient>
    <radialGradient id="glow1" cx="70%" cy="40%" r="50%">
      <stop offset="0%" stop-color="${COLORS.accent}" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="${COLORS.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${w}" height="${h}" fill="url(#heroBg)"/>
  <rect width="${w}" height="${h}" fill="url(#glow1)"/>
  ${starField(w, h, 60)}

  <!-- Left side: text -->
  <text x="80" y="280" font-family="system-ui, -apple-system, sans-serif" font-size="52" font-weight="700" fill="${COLORS.text}">Meet Orion</text>
  <text x="80" y="340" font-family="system-ui, -apple-system, sans-serif" font-size="28" fill="${COLORS.accentLight}">Your AI Browser Assistant</text>

  <text x="80" y="410" font-family="system-ui, -apple-system, sans-serif" font-size="18" fill="${COLORS.textMuted}">Ask anything. Orion reads pages, fills forms,</text>
  <text x="80" y="438" font-family="system-ui, -apple-system, sans-serif" font-size="18" fill="${COLORS.textMuted}">researches the web, and acts autonomously.</text>

  <!-- Feature pills -->
  <rect x="80" y="480" width="140" height="36" rx="18" fill="${COLORS.accent}" opacity="0.2"/>
  <text x="150" y="503" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.accentLight}" text-anchor="middle">Private</text>

  <rect x="235" y="480" width="110" height="36" rx="18" fill="${COLORS.accent}" opacity="0.2"/>
  <text x="290" y="503" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.accentLight}" text-anchor="middle">Fast</text>

  <rect x="360" y="480" width="160" height="36" rx="18" fill="${COLORS.accent}" opacity="0.2"/>
  <text x="440" y="503" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.accentLight}" text-anchor="middle">Autonomous</text>

  <!-- Right side: chat mockup -->
  <rect x="680" y="100" width="520" height="600" rx="16" fill="${COLORS.chatBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>

  <!-- Chat header -->
  <rect x="680" y="100" width="520" height="56" rx="16" fill="${COLORS.cardBg}"/>
  <rect x="680" y="140" width="520" height="16" fill="${COLORS.cardBg}"/>
  ${orionLogo(715, 128, 40)}
  <text x="745" y="134" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="${COLORS.text}">Orion</text>
  <text x="815" y="134" font-family="system-ui, sans-serif" font-size="11" fill="${COLORS.green}">* Online</text>
  <text x="1135" y="134" font-family="system-ui, sans-serif" font-size="11" fill="${COLORS.textMuted}">Gemini 2.5</text>

  <!-- User message -->
  <rect x="860" y="185" width="310" height="50" rx="12" fill="${COLORS.userBubble}"/>
  <text x="880" y="215" font-family="system-ui, sans-serif" font-size="14" fill="#fff">Check my unread emails and</text>
  <text x="880" y="232" font-family="system-ui, sans-serif" font-size="14" fill="#fff">summarize what's important</text>

  <!-- AI message -->
  <rect x="710" y="255" width="420" height="180" rx="12" fill="${COLORS.aiBubble}" stroke="${COLORS.cardBorder}" stroke-width="0.5"/>
  <text x="730" y="283" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.text}">I found 3 unread emails:</text>
  <text x="730" y="313" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.green}">Priority: Invoice due tomorrow</text>
  <text x="750" y="335" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.textMuted}">From: accounting@company.com</text>
  <text x="730" y="365" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.blue}">Meeting rescheduled to 3pm</text>
  <text x="750" y="387" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.textMuted}">From: sarah@team.com</text>
  <text x="730" y="417" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}">Newsletter (low priority)</text>

  <!-- Action indicator -->
  <rect x="710" y="455" width="280" height="36" rx="8" fill="${COLORS.accent}" opacity="0.15"/>
  <text x="730" y="478" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.accentLight}">+ Opened 3 emails | Read content | Summarized</text>

  <!-- User message 2 -->
  <rect x="920" y="510" width="250" height="40" rx="12" fill="${COLORS.userBubble}"/>
  <text x="940" y="535" font-family="system-ui, sans-serif" font-size="14" fill="#fff">Reply to the invoice email</text>

  <!-- AI typing -->
  <rect x="710" y="570" width="180" height="36" rx="12" fill="${COLORS.aiBubble}" stroke="${COLORS.cardBorder}" stroke-width="0.5"/>
  <text x="730" y="593" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.accentLight}">Drafting reply...</text>
  <circle cx="870" cy="588" r="3" fill="${COLORS.accentLight}" opacity="0.5"/>
  <circle cx="880" cy="588" r="3" fill="${COLORS.accentLight}" opacity="0.7"/>
  <circle cx="890" cy="588" r="3" fill="${COLORS.accentLight}" opacity="0.9"/>

  <!-- Input bar -->
  <rect x="695" y="640" width="490" height="44" rx="22" fill="${COLORS.bgLight}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <text x="725" y="667" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}">Ask Orion anything...</text>
</svg>`
}

// --- Screenshot 2: Multi-Provider Support -----------------------------------
function screenshot2() {
  const w = 1280, h = 800
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f0a1e"/>
      <stop offset="100%" stop-color="#1a1040"/>
    </linearGradient>
  </defs>

  <rect width="${w}" height="${h}" fill="url(#bg2)"/>
  ${starField(w, h, 50)}

  <text x="640" y="100" font-family="system-ui, sans-serif" font-size="42" font-weight="700" fill="${COLORS.text}" text-anchor="middle">Choose Your AI Provider</text>
  <text x="640" y="145" font-family="system-ui, sans-serif" font-size="20" fill="${COLORS.textMuted}" text-anchor="middle">Use your own API key. No subscription. No middleman.</text>

  <!-- Provider cards -->
  <!-- Local / LM Studio -->
  <rect x="60" y="200" width="270" height="340" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <rect x="60" y="200" width="270" height="6" rx="3" fill="${COLORS.green}"/>
  <text x="195" y="265" font-family="system-ui, sans-serif" font-size="36" text-anchor="middle">~</text>
  <text x="195" y="305" font-family="system-ui, sans-serif" font-size="22" font-weight="600" fill="${COLORS.text}" text-anchor="middle">Local AI</text>
  <text x="195" y="330" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.green}" text-anchor="middle">LM Studio | Ollama</text>
  <text x="195" y="370" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">100% private</text>
  <text x="195" y="392" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Zero data leaves your PC</text>
  <text x="195" y="414" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Free forever</text>
  <rect x="120" y="460" width="150" height="40" rx="20" fill="${COLORS.green}" opacity="0.2"/>
  <text x="195" y="485" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="${COLORS.green}" text-anchor="middle">Free</text>

  <!-- Gemini -->
  <rect x="360" y="200" width="270" height="340" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <rect x="360" y="200" width="270" height="6" rx="3" fill="#4285f4"/>
  <circle cx="495" cy="252" r="22" fill="#4285f4" opacity="0.3"/>
  <text x="495" y="260" font-family="system-ui, sans-serif" font-size="24" font-weight="700" fill="#4285f4" text-anchor="middle">G</text>
  <text x="495" y="305" font-family="system-ui, sans-serif" font-size="22" font-weight="600" fill="${COLORS.text}" text-anchor="middle">Google Gemini</text>
  <text x="495" y="330" font-family="system-ui, sans-serif" font-size="14" fill="#4285f4" text-anchor="middle">Gemini 2.5 Pro / Flash</text>
  <text x="495" y="370" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Fast cloud AI</text>
  <text x="495" y="392" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Large context window</text>
  <text x="495" y="414" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Free tier available</text>
  <rect x="420" y="460" width="150" height="40" rx="20" fill="#4285f4" opacity="0.2"/>
  <text x="495" y="485" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#4285f4" text-anchor="middle">Free Tier</text>

  <!-- OpenAI -->
  <rect x="660" y="200" width="270" height="340" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <rect x="660" y="200" width="270" height="6" rx="3" fill="#10a37f"/>
  <circle cx="795" cy="252" r="22" fill="#10a37f" opacity="0.3"/>
  <text x="795" y="260" font-family="system-ui, sans-serif" font-size="24" font-weight="700" fill="#10a37f" text-anchor="middle">O</text>
  <text x="795" y="305" font-family="system-ui, sans-serif" font-size="22" font-weight="600" fill="${COLORS.text}" text-anchor="middle">OpenAI</text>
  <text x="795" y="330" font-family="system-ui, sans-serif" font-size="14" fill="#10a37f" text-anchor="middle">GPT-4o | GPT-4o Mini</text>
  <text x="795" y="370" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Industry standard</text>
  <text x="795" y="392" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Vision support</text>
  <text x="795" y="414" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Reliable and fast</text>
  <rect x="720" y="460" width="150" height="40" rx="20" fill="#10a37f" opacity="0.2"/>
  <text x="795" y="485" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#10a37f" text-anchor="middle">Pay-per-use</text>

  <!-- Anthropic -->
  <rect x="960" y="200" width="270" height="340" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <rect x="960" y="200" width="270" height="6" rx="3" fill="#d4a574"/>
  <circle cx="1095" cy="252" r="22" fill="#d4a574" opacity="0.3"/>
  <text x="1095" y="260" font-family="system-ui, sans-serif" font-size="24" font-weight="700" fill="#d4a574" text-anchor="middle">A</text>
  <text x="1095" y="305" font-family="system-ui, sans-serif" font-size="22" font-weight="600" fill="${COLORS.text}" text-anchor="middle">Anthropic</text>
  <text x="1095" y="330" font-family="system-ui, sans-serif" font-size="14" fill="#d4a574" text-anchor="middle">Claude Sonnet / Opus</text>
  <text x="1095" y="370" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Advanced reasoning</text>
  <text x="1095" y="392" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Best for complex tasks</text>
  <text x="1095" y="414" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}" text-anchor="middle">Nuanced understanding</text>
  <rect x="1020" y="460" width="150" height="40" rx="20" fill="#d4a574" opacity="0.2"/>
  <text x="1095" y="485" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#d4a574" text-anchor="middle">Pay-per-use</text>

  <!-- Bottom note -->
  <text x="640" y="620" font-family="system-ui, sans-serif" font-size="16" fill="${COLORS.textMuted}" text-anchor="middle">Bring your own API key - your data goes directly to your chosen provider</text>

  <rect x="440" y="660" width="400" height="50" rx="25" fill="${COLORS.accent}" opacity="0.15"/>
  <text x="640" y="690" font-family="system-ui, sans-serif" font-size="16" fill="${COLORS.accentLight}" text-anchor="middle">Zero telemetry | Zero tracking | Zero middleman</text>
</svg>`
}

// --- Screenshot 3: Web Research ---------------------------------------------
function screenshot3() {
  const w = 1280, h = 800
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f0a1e"/>
      <stop offset="100%" stop-color="#1a1040"/>
    </linearGradient>
  </defs>

  <rect width="${w}" height="${h}" fill="url(#bg3)"/>
  ${starField(w, h, 45)}

  <text x="640" y="90" font-family="system-ui, sans-serif" font-size="42" font-weight="700" fill="${COLORS.text}" text-anchor="middle">Autonomous Web Research</text>
  <text x="640" y="130" font-family="system-ui, sans-serif" font-size="20" fill="${COLORS.textMuted}" text-anchor="middle">Orion searches, opens tabs, reads content, and synthesizes findings</text>

  <!-- Research flow visualization -->
  <!-- Step 1: User asks -->
  <rect x="80" y="190" width="340" height="120" rx="12" fill="${COLORS.cardBg}" stroke="${COLORS.userBubble}" stroke-width="2"/>
  <text x="100" y="225" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.accentLight}">YOU ASK:</text>
  <text x="100" y="255" font-family="system-ui, sans-serif" font-size="16" fill="${COLORS.text}">"Compare the top 3 project</text>
  <text x="100" y="278" font-family="system-ui, sans-serif" font-size="16" fill="${COLORS.text}">management tools for startups"</text>

  <!-- Arrow -->
  <text x="450" y="260" font-family="system-ui, sans-serif" font-size="28" fill="${COLORS.accent}">-></text>

  <!-- Step 2: Orion searches -->
  <rect x="490" y="190" width="340" height="120" rx="12" fill="${COLORS.cardBg}" stroke="${COLORS.green}" stroke-width="2"/>
  <text x="510" y="225" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.green}">ORION SEARCHES:</text>
  <text x="510" y="255" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}">"best project management tools 2025"</text>
  <text x="510" y="278" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}">"startup PM tool comparison"</text>
  <text x="510" y="298" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.green}">+ 2 searches completed</text>

  <!-- Arrow -->
  <text x="860" y="260" font-family="system-ui, sans-serif" font-size="28" fill="${COLORS.accent}">-></text>

  <!-- Step 3: Opens & reads -->
  <rect x="900" y="190" width="340" height="120" rx="12" fill="${COLORS.cardBg}" stroke="${COLORS.blue}" stroke-width="2"/>
  <text x="920" y="225" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.blue}">OPENS &amp; READS:</text>
  <text x="920" y="255" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}">G2 Comparison Review</text>
  <text x="920" y="278" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}">TechCrunch Analysis</text>
  <text x="920" y="298" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.blue}">+ 5 pages analyzed</text>

  <!-- Result card -->
  <rect x="160" y="370" width="960" height="350" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.accent}" stroke-width="2"/>
  <text x="200" y="415" font-family="system-ui, sans-serif" font-size="18" font-weight="600" fill="${COLORS.accentLight}">Orion's Synthesized Report</text>

  <!-- Comparison table header -->
  <rect x="200" y="440" width="880" height="35" rx="6" fill="${COLORS.accent}" opacity="0.15"/>
  <text x="220" y="463" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="${COLORS.text}">Tool</text>
  <text x="440" y="463" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="${COLORS.text}">Best For</text>
  <text x="700" y="463" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="${COLORS.text}">Price</text>
  <text x="880" y="463" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="${COLORS.text}">Rating</text>

  <!-- Row 1 -->
  <text x="220" y="505" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.text}">Linear</text>
  <text x="440" y="505" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}">Engineering teams</text>
  <text x="700" y="505" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.green}">$8/user/mo</text>
  <text x="880" y="505" font-family="system-ui, sans-serif" font-size="14" fill="#ffd700">*****</text>

  <!-- Row 2 -->
  <line x1="200" y1="520" x2="1080" y2="520" stroke="${COLORS.cardBorder}" stroke-width="0.5"/>
  <text x="220" y="548" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.text}">Notion</text>
  <text x="440" y="548" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}">All-in-one workspace</text>
  <text x="700" y="548" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.green}">Free / $10/mo</text>
  <text x="880" y="548" font-family="system-ui, sans-serif" font-size="14" fill="#ffd700">****.</text>

  <!-- Row 3 -->
  <line x1="200" y1="563" x2="1080" y2="563" stroke="${COLORS.cardBorder}" stroke-width="0.5"/>
  <text x="220" y="591" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.text}">Asana</text>
  <text x="440" y="591" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}">Cross-functional teams</text>
  <text x="700" y="591" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.green}">Free / $11/mo</text>
  <text x="880" y="591" font-family="system-ui, sans-serif" font-size="14" fill="#ffd700">****.</text>

  <text x="220" y="650" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}">Recommendation: Linear for dev-heavy startups, Notion for</text>
  <text x="220" y="672" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}">versatility. Both offer free tiers to get started.</text>

  <text x="860" y="695" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.green}">+ 5 sources | 3 tools compared | 2 min total</text>
</svg>`
}

// --- Screenshot 4: Privacy & Security ---------------------------------------
function screenshot4() {
  const w = 1280, h = 800
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg4" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f0a1e"/>
      <stop offset="100%" stop-color="#1a1040"/>
    </linearGradient>
    <radialGradient id="shield" cx="50%" cy="40%" r="50%">
      <stop offset="0%" stop-color="${COLORS.accent}" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="${COLORS.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${w}" height="${h}" fill="url(#bg4)"/>
  ${starField(w, h, 50)}

  <text x="640" y="90" font-family="system-ui, sans-serif" font-size="42" font-weight="700" fill="${COLORS.text}" text-anchor="middle">Privacy First Design</text>
  <text x="640" y="130" font-family="system-ui, sans-serif" font-size="20" fill="${COLORS.textMuted}" text-anchor="middle">Your data stays yours. Always.</text>

  <!-- Shield icon -->
  <circle cx="640" cy="300" r="120" fill="url(#shield)"/>
  <circle cx="640" cy="300" r="50" fill="${COLORS.accent}" opacity="0.25"/>
  <polygon points="640,260 670,280 660,315 620,315 610,280" fill="${COLORS.accentLight}" opacity="0.8"/>
  <text x="640" y="305" font-family="system-ui, sans-serif" font-size="20" font-weight="700" fill="${COLORS.bg}" text-anchor="middle">OK</text>

  <!-- Privacy features grid -->
  <rect x="80" y="460" width="350" height="80" rx="12" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="112" cy="495" r="12" fill="${COLORS.green}" opacity="0.2"/>
  <text x="112" y="500" font-family="system-ui, sans-serif" font-size="14" font-weight="700" fill="${COLORS.green}" text-anchor="middle">L</text>
  <text x="135" y="497" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="${COLORS.text}">100% Local Mode</text>
  <text x="135" y="520" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}">Nothing leaves your computer. Ever.</text>

  <rect x="465" y="460" width="350" height="80" rx="12" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="497" cy="495" r="12" fill="${COLORS.accent}" opacity="0.2"/>
  <text x="497" y="500" font-family="system-ui, sans-serif" font-size="14" font-weight="700" fill="${COLORS.accentLight}" text-anchor="middle">0</text>
  <text x="520" y="497" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="${COLORS.text}">Zero Telemetry</text>
  <text x="520" y="520" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}">No analytics. No tracking. No logs.</text>

  <rect x="850" y="460" width="350" height="80" rx="12" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="882" cy="495" r="12" fill="${COLORS.blue}" opacity="0.2"/>
  <text x="882" y="500" font-family="system-ui, sans-serif" font-size="14" font-weight="700" fill="${COLORS.blue}" text-anchor="middle">T</text>
  <text x="905" y="497" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="${COLORS.text}">Tab Isolation</text>
  <text x="905" y="520" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}">Only reads tabs in its own group.</text>

  <rect x="80" y="560" width="350" height="80" rx="12" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="112" cy="595" r="12" fill="#4da6ff" opacity="0.2"/>
  <text x="112" y="600" font-family="system-ui, sans-serif" font-size="14" font-weight="700" fill="#4da6ff" text-anchor="middle">D</text>
  <text x="135" y="597" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="${COLORS.text}">Direct API Only</text>
  <text x="135" y="620" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}">Cloud data goes only to your provider.</text>

  <rect x="465" y="560" width="350" height="80" rx="12" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="497" cy="595" r="12" fill="#d4a574" opacity="0.2"/>
  <text x="497" y="600" font-family="system-ui, sans-serif" font-size="14" font-weight="700" fill="#d4a574" text-anchor="middle">K</text>
  <text x="520" y="597" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="${COLORS.text}">Your Keys, Your Control</text>
  <text x="520" y="620" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}">No middleman. No subscription fees.</text>

  <rect x="850" y="560" width="350" height="80" rx="12" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="882" cy="595" r="12" fill="${COLORS.green}" opacity="0.2"/>
  <text x="882" y="600" font-family="system-ui, sans-serif" font-size="14" font-weight="700" fill="${COLORS.green}" text-anchor="middle">P</text>
  <text x="905" y="597" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="${COLORS.text}">Phishing Detection</text>
  <text x="905" y="620" font-family="system-ui, sans-serif" font-size="13" fill="${COLORS.textMuted}">AI-powered page safety analysis.</text>

  <rect x="390" y="690" width="500" height="50" rx="25" fill="${COLORS.accent}" opacity="0.1"/>
  <text x="640" y="720" font-family="system-ui, sans-serif" font-size="16" fill="${COLORS.accentLight}" text-anchor="middle">Open source - audit the code yourself</text>
</svg>`
}

// --- Screenshot 5: Form Filling + Actions -----------------------------------
function screenshot5() {
  const w = 1280, h = 800
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg5" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f0a1e"/>
      <stop offset="100%" stop-color="#1a1040"/>
    </linearGradient>
  </defs>

  <rect width="${w}" height="${h}" fill="url(#bg5)"/>
  ${starField(w, h, 40)}

  <text x="640" y="90" font-family="system-ui, sans-serif" font-size="42" font-weight="700" fill="${COLORS.text}" text-anchor="middle">Smart Browser Automation</text>
  <text x="640" y="130" font-family="system-ui, sans-serif" font-size="20" fill="${COLORS.textMuted}" text-anchor="middle">Up to 25 autonomous actions per request</text>

  <!-- Capability cards -->
  <!-- Row 1 -->
  <rect x="80" y="180" width="370" height="250" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="265" cy="222" r="22" fill="${COLORS.accent}" opacity="0.25"/>
  <text x="265" y="230" font-family="system-ui, sans-serif" font-size="22" font-weight="700" fill="${COLORS.accentLight}" text-anchor="middle">F</text>
  <text x="265" y="270" font-family="system-ui, sans-serif" font-size="20" font-weight="600" fill="${COLORS.text}" text-anchor="middle">Intelligent Form Filling</text>
  <text x="265" y="305" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}" text-anchor="middle">Visa applications, registrations,</text>
  <text x="265" y="325" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}" text-anchor="middle">checkouts - handles complex forms</text>
  <rect x="140" y="355" width="250" height="36" rx="8" fill="${COLORS.accent}" opacity="0.1"/>
  <text x="155" y="378" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.green}">+ Click | Type | Select | Submit</text>

  <rect x="480" y="180" width="370" height="250" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="665" cy="222" r="22" fill="${COLORS.blue}" opacity="0.25"/>
  <text x="665" y="230" font-family="system-ui, sans-serif" font-size="22" font-weight="700" fill="${COLORS.blue}" text-anchor="middle">@</text>
  <text x="665" y="270" font-family="system-ui, sans-serif" font-size="20" font-weight="600" fill="${COLORS.text}" text-anchor="middle">Email Management</text>
  <text x="665" y="305" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}" text-anchor="middle">Read, summarize, draft replies,</text>
  <text x="665" y="325" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}" text-anchor="middle">and manage your inbox</text>
  <rect x="540" y="355" width="250" height="36" rx="8" fill="${COLORS.accent}" opacity="0.1"/>
  <text x="555" y="378" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.green}">+ Works with Gmail | Outlook | Any</text>

  <rect x="880" y="180" width="370" height="250" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="1065" cy="222" r="22" fill="${COLORS.green}" opacity="0.25"/>
  <text x="1065" y="230" font-family="system-ui, sans-serif" font-size="22" font-weight="700" fill="${COLORS.green}" text-anchor="middle">?</text>
  <text x="1065" y="270" font-family="system-ui, sans-serif" font-size="20" font-weight="600" fill="${COLORS.text}" text-anchor="middle">Web Research</text>
  <text x="1065" y="305" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}" text-anchor="middle">Search, open tabs, read content,</text>
  <text x="1065" y="325" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}" text-anchor="middle">and synthesize findings</text>
  <rect x="940" y="355" width="250" height="36" rx="8" fill="${COLORS.accent}" opacity="0.1"/>
  <text x="955" y="378" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.green}">+ Multi-tab | Parallel reading</text>

  <!-- Row 2 -->
  <rect x="180" y="470" width="370" height="250" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="365" cy="512" r="22" fill="#d4a574" opacity="0.25"/>
  <text x="365" y="520" font-family="system-ui, sans-serif" font-size="22" font-weight="700" fill="#d4a574" text-anchor="middle">M</text>
  <text x="365" y="560" font-family="system-ui, sans-serif" font-size="20" font-weight="600" fill="${COLORS.text}" text-anchor="middle">Context Memory</text>
  <text x="365" y="595" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}" text-anchor="middle">Remembers your preferences,</text>
  <text x="365" y="615" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}" text-anchor="middle">past sessions, and domain knowledge</text>
  <rect x="240" y="645" width="250" height="36" rx="8" fill="${COLORS.accent}" opacity="0.1"/>
  <text x="255" y="668" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.green}">+ Cross-session | Per-domain</text>

  <rect x="680" y="470" width="370" height="250" rx="16" fill="${COLORS.cardBg}" stroke="${COLORS.cardBorder}" stroke-width="1"/>
  <circle cx="865" cy="512" r="22" fill="${COLORS.accent}" opacity="0.25"/>
  <text x="865" y="520" font-family="system-ui, sans-serif" font-size="22" font-weight="700" fill="${COLORS.accentLight}" text-anchor="middle">V</text>
  <text x="865" y="560" font-family="system-ui, sans-serif" font-size="20" font-weight="600" fill="${COLORS.text}" text-anchor="middle">Page Understanding</text>
  <text x="865" y="595" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}" text-anchor="middle">Reads any webpage with vision</text>
  <text x="865" y="615" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.textMuted}" text-anchor="middle">and accessibility tree analysis</text>
  <rect x="740" y="645" width="250" height="36" rx="8" fill="${COLORS.accent}" opacity="0.1"/>
  <text x="755" y="668" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.green}">+ Screenshots | DOM | A11y tree</text>
</svg>`
}

// --- Small Promo Tile (440x280) ---------------------------------------------
function smallPromo() {
  const w = 440, h = 280
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    ${logoDefs()}
    <linearGradient id="promoBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1a1040"/>
      <stop offset="100%" stop-color="#0f0a1e"/>
    </linearGradient>
    <radialGradient id="promoGlow" cx="35%" cy="50%" r="60%">
      <stop offset="0%" stop-color="${COLORS.accent}" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="${COLORS.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${w}" height="${h}" fill="url(#promoBg)"/>
  <rect width="${w}" height="${h}" fill="url(#promoGlow)"/>
  ${starField(w, h, 25)}

  ${orionLogo(90, 140, 100)}

  <text x="170" y="115" font-family="system-ui, sans-serif" font-size="32" font-weight="700" fill="${COLORS.text}">Orion</text>
  <text x="170" y="148" font-family="system-ui, sans-serif" font-size="15" fill="${COLORS.accentLight}">AI Browser Assistant</text>
  <text x="170" y="185" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.textMuted}">Reads pages | Fills forms | Researches</text>
  <text x="170" y="205" font-family="system-ui, sans-serif" font-size="12" fill="${COLORS.textMuted}">Private | Fast | Autonomous</text>
</svg>`
}

// --- Marquee Promo Tile (1400x560) ------------------------------------------
function marqueePromo() {
  const w = 1400, h = 560
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    ${logoDefs()}
    <linearGradient id="marqBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1a1040"/>
      <stop offset="40%" stop-color="#0f0a1e"/>
      <stop offset="100%" stop-color="#1a1040"/>
    </linearGradient>
    <radialGradient id="marqGlow" cx="30%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${COLORS.accent}" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="${COLORS.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${w}" height="${h}" fill="url(#marqBg)"/>
  <rect width="${w}" height="${h}" fill="url(#marqGlow)"/>
  ${starField(w, h, 80)}

  <!-- Logo -->
  ${orionLogo(200, 280, 200)}

  <!-- Text -->
  <text x="380" y="220" font-family="system-ui, sans-serif" font-size="64" font-weight="700" fill="${COLORS.text}">Orion</text>
  <text x="380" y="280" font-family="system-ui, sans-serif" font-size="26" fill="${COLORS.accentLight}">Your AI Browser Assistant</text>

  <text x="380" y="340" font-family="system-ui, sans-serif" font-size="18" fill="${COLORS.textMuted}">Reads pages | Fills forms | Researches the web</text>
  <text x="380" y="370" font-family="system-ui, sans-serif" font-size="18" fill="${COLORS.textMuted}">Runs locally or via Gemini, OpenAI, Anthropic</text>

  <!-- Feature pills -->
  <rect x="380" y="410" width="130" height="36" rx="18" fill="${COLORS.accent}" opacity="0.2"/>
  <text x="445" y="433" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.accentLight}" text-anchor="middle">Private</text>

  <rect x="525" y="410" width="100" height="36" rx="18" fill="${COLORS.accent}" opacity="0.2"/>
  <text x="575" y="433" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.accentLight}" text-anchor="middle">Fast</text>

  <rect x="640" y="410" width="160" height="36" rx="18" fill="${COLORS.accent}" opacity="0.2"/>
  <text x="720" y="433" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.accentLight}" text-anchor="middle">Autonomous</text>

  <rect x="815" y="410" width="140" height="36" rx="18" fill="${COLORS.accent}" opacity="0.2"/>
  <text x="885" y="433" font-family="system-ui, sans-serif" font-size="14" fill="${COLORS.accentLight}" text-anchor="middle">Open Source</text>

  <!-- Right side decorative elements -->
  <circle cx="1200" cy="150" r="3" fill="${COLORS.accentLight}" opacity="0.4"/>
  <circle cx="1250" cy="200" r="2" fill="${COLORS.accentLight}" opacity="0.3"/>
  <circle cx="1180" cy="250" r="2.5" fill="${COLORS.accentLight}" opacity="0.35"/>
  <circle cx="1300" cy="180" r="1.5" fill="${COLORS.accentLight}" opacity="0.25"/>
  <line x1="1200" y1="150" x2="1250" y2="200" stroke="${COLORS.accentLight}" stroke-opacity="0.15" stroke-width="1"/>
  <line x1="1250" y1="200" x2="1180" y2="250" stroke="${COLORS.accentLight}" stroke-opacity="0.15" stroke-width="1"/>
</svg>`
}

// --- Render all assets ------------------------------------------------------
async function render(name, svgFn, width, height) {
  const svg = Buffer.from(svgFn())
  const path = join(OUT_DIR, `${name}.png`)
  await sharp(svg, { density: 150 })
    .resize(width, height, { fit: 'fill' })
    .flatten({ background: { r: 15, g: 10, b: 30 } }) // remove alpha -> 24-bit PNG
    .png()
    .toFile(path)
  console.log(`  + ${name}.png (${width}x${height})`)
}

async function main() {
  console.log('Generating Chrome Web Store assets...\n')

  // Screenshots (1280x800)
  await render('screenshot-1-hero', screenshot1, 1280, 800)
  await render('screenshot-2-providers', screenshot2, 1280, 800)
  await render('screenshot-3-research', screenshot3, 1280, 800)
  await render('screenshot-4-privacy', screenshot4, 1280, 800)
  await render('screenshot-5-features', screenshot5, 1280, 800)

  // Promo tiles
  await render('promo-small-440x280', smallPromo, 440, 280)
  await render('promo-marquee-1400x560', marqueePromo, 1400, 560)

  console.log(`\nAll assets saved to store-assets/`)
}

main().catch(err => { console.error(err); process.exit(1) })
