/**
 * Generate Orion extension icons — high-quality PNG via sharp SVG rendering.
 *
 * Orion icon: deep purple circle background with a stylized constellation
 * (Orion's belt — three bright dots) and a central glowing star.
 *
 * Usage: node scripts/generate-icons.mjs
 */
import sharp from 'sharp'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'icons')
const SIZES = [16, 32, 48, 128]

// Render at 512px then downscale for best quality at all sizes
const SOURCE_SIZE = 512

function generateSVG() {
  const s = SOURCE_SIZE
  const cx = s / 2
  const cy = s / 2
  const outerR = s * 0.47 // background circle
  const ringR = s * 0.38  // accent ring

  // Orion's belt — three stars in a slight diagonal
  const beltCy = cy - s * 0.02
  const beltGap = s * 0.12
  const belt = [
    { x: cx - beltGap * 1.15, y: beltCy + s * 0.015 },
    { x: cx,                   y: beltCy - s * 0.01 },
    { x: cx + beltGap * 1.15, y: beltCy + s * 0.015 },
  ]
  const beltR = s * 0.022 // belt dot radius

  // Shoulder stars (Betelgeuse top-left, Bellatrix top-right)
  const shoulderY = cy - s * 0.18
  const shoulderX = s * 0.14
  const shoulders = [
    { x: cx - shoulderX, y: shoulderY - s * 0.02 },
    { x: cx + shoulderX, y: shoulderY + s * 0.01 },
  ]

  // Foot stars (Rigel bottom-right, Saiph bottom-left)
  const footY = cy + s * 0.2
  const footX = s * 0.13
  const feet = [
    { x: cx - footX - s * 0.01, y: footY + s * 0.01 },
    { x: cx + footX + s * 0.02, y: footY - s * 0.005 },
  ]

  // Central star (big, glowing)
  const starCx = cx
  const starCy = cy + s * 0.09

  // 4-pointed star polygon
  function fourPointStar(scx, scy, outerSize, innerSize) {
    const pts = []
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI * 2) / 8 - Math.PI / 2
      const r = i % 2 === 0 ? outerSize : innerSize
      pts.push(`${scx + Math.cos(angle) * r},${scy + Math.sin(angle) * r}`)
    }
    return pts.join(' ')
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <!-- Background gradient -->
    <radialGradient id="bg" cx="40%" cy="35%" r="65%">
      <stop offset="0%" stop-color="#2a1f5e"/>
      <stop offset="60%" stop-color="#1a1040"/>
      <stop offset="100%" stop-color="#110b28"/>
    </radialGradient>

    <!-- Ring gradient -->
    <linearGradient id="ring" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#b8b0ff"/>
      <stop offset="50%" stop-color="#6c5ce7"/>
      <stop offset="100%" stop-color="#b8b0ff"/>
    </linearGradient>

    <!-- Glow for center star -->
    <radialGradient id="starGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.7"/>
      <stop offset="40%" stop-color="#a29bfe" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#6c5ce7" stop-opacity="0"/>
    </radialGradient>

    <!-- Belt dot glow -->
    <radialGradient id="dotGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="60%" stop-color="#a29bfe" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#6c5ce7" stop-opacity="0"/>
    </radialGradient>

    <!-- Outer ambient glow -->
    <radialGradient id="ambientGlow" cx="50%" cy="45%" r="55%">
      <stop offset="0%" stop-color="#6c5ce7" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#6c5ce7" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Background circle -->
  <circle cx="${cx}" cy="${cy}" r="${outerR}" fill="url(#bg)"/>

  <!-- Ambient glow -->
  <circle cx="${cx}" cy="${cy}" r="${ringR * 1.1}" fill="url(#ambientGlow)"/>

  <!-- Accent ring -->
  <circle cx="${cx}" cy="${cy}" r="${ringR}" fill="none" stroke="url(#ring)" stroke-width="${s * 0.018}" stroke-opacity="0.7"/>

  <!-- Constellation lines (subtle) -->
  <!-- Shoulders to belt -->
  <line x1="${shoulders[0].x}" y1="${shoulders[0].y}" x2="${belt[0].x}" y2="${belt[0].y}" stroke="#a29bfe" stroke-opacity="0.25" stroke-width="${s * 0.006}"/>
  <line x1="${shoulders[1].x}" y1="${shoulders[1].y}" x2="${belt[2].x}" y2="${belt[2].y}" stroke="#a29bfe" stroke-opacity="0.25" stroke-width="${s * 0.006}"/>
  <!-- Belt connections -->
  <line x1="${belt[0].x}" y1="${belt[0].y}" x2="${belt[1].x}" y2="${belt[1].y}" stroke="#a29bfe" stroke-opacity="0.3" stroke-width="${s * 0.007}"/>
  <line x1="${belt[1].x}" y1="${belt[1].y}" x2="${belt[2].x}" y2="${belt[2].y}" stroke="#a29bfe" stroke-opacity="0.3" stroke-width="${s * 0.007}"/>
  <!-- Belt to feet -->
  <line x1="${belt[0].x}" y1="${belt[0].y}" x2="${feet[0].x}" y2="${feet[0].y}" stroke="#a29bfe" stroke-opacity="0.2" stroke-width="${s * 0.005}"/>
  <line x1="${belt[2].x}" y1="${belt[2].y}" x2="${feet[1].x}" y2="${feet[1].y}" stroke="#a29bfe" stroke-opacity="0.2" stroke-width="${s * 0.005}"/>

  <!-- Center star glow -->
  <circle cx="${starCx}" cy="${starCy}" r="${s * 0.08}" fill="url(#starGlow)"/>

  <!-- Center star (4-pointed) -->
  <polygon points="${fourPointStar(starCx, starCy, s * 0.045, s * 0.015)}" fill="#ffffff" opacity="0.95"/>

  <!-- Shoulder stars -->
  <circle cx="${shoulders[0].x}" cy="${shoulders[0].y}" r="${beltR * 0.85}" fill="#e8c8ff" opacity="0.8"/>
  <circle cx="${shoulders[1].x}" cy="${shoulders[1].y}" r="${beltR * 0.75}" fill="#c8d8ff" opacity="0.75"/>

  <!-- Belt stars (brightest) -->
  ${belt.map((d, i) => `
  <circle cx="${d.x}" cy="${d.y}" r="${beltR * 1.8}" fill="url(#dotGlow)"/>
  <circle cx="${d.x}" cy="${d.y}" r="${beltR}" fill="#ffffff" opacity="0.95"/>
  `).join('')}

  <!-- Foot stars -->
  <circle cx="${feet[0].x}" cy="${feet[0].y}" r="${beltR * 0.7}" fill="#a8c8ff" opacity="0.65"/>
  <circle cx="${feet[1].x}" cy="${feet[1].y}" r="${beltR * 0.8}" fill="#c8e0ff" opacity="0.7"/>

  <!-- Tiny background stars for depth -->
  <circle cx="${cx + s * 0.25}" cy="${cy - s * 0.28}" r="${s * 0.005}" fill="#ffffff" opacity="0.3"/>
  <circle cx="${cx - s * 0.3}" cy="${cy + s * 0.15}" r="${s * 0.004}" fill="#ffffff" opacity="0.25"/>
  <circle cx="${cx + s * 0.15}" cy="${cy + s * 0.3}" r="${s * 0.004}" fill="#ffffff" opacity="0.2"/>
  <circle cx="${cx - s * 0.22}" cy="${cy - s * 0.32}" r="${s * 0.003}" fill="#ffffff" opacity="0.2"/>
  <circle cx="${cx + s * 0.33}" cy="${cy + s * 0.08}" r="${s * 0.003}" fill="#ffffff" opacity="0.15"/>
</svg>`
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  const svg = Buffer.from(generateSVG())

  // Render at source size then resize for each target
  for (const size of SIZES) {
    const pngPath = join(OUT_DIR, `icon-${size}.png`)
    await sharp(svg, { density: 300 })
      .resize(size, size, { kernel: 'lanczos3' })
      .png()
      .toFile(pngPath)
    console.log(`  icon-${size}.png`)
  }

  // Also save the source SVG
  const { writeFileSync } = await import('fs')
  writeFileSync(join(OUT_DIR, 'icon-source.svg'), generateSVG())

  console.log('\nAll icons generated in icons/')
}

main().catch(err => { console.error(err); process.exit(1) })
