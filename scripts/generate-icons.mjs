/**
 * Generate Orion extension icons as PNG files from an SVG template.
 * Uses sharp for high-quality rasterization.
 *
 * Usage: node scripts/generate-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIZES = [16, 32, 48, 128]
const OUT_DIR = join(__dirname, '..', 'icons')

// Orion constellation-inspired icon:
// A stylized "O" with a star/constellation motif — deep purple accent (#6c5ce7)
// Works at all sizes including 16px
function generateSVG(size) {
  const s = size
  const cx = s / 2
  const cy = s / 2
  const r = s * 0.38  // main circle radius
  const starR = s * 0.08  // center star radius
  const dotR = s * 0.04   // constellation dot radius

  // Three constellation dots forming Orion's belt
  const beltY = cy - r * 0.1
  const beltSpacing = r * 0.35
  const belt = [
    { x: cx - beltSpacing, y: beltY },
    { x: cx, y: beltY - s * 0.02 },
    { x: cx + beltSpacing, y: beltY },
  ]

  // Star points for center star
  const starPoints = []
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI * 2) / 8 - Math.PI / 2
    const pr = i % 2 === 0 ? starR : starR * 0.45
    starPoints.push(`${cx + Math.cos(angle) * pr},${cy + Math.sin(angle) * pr + r * 0.15}`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2d1b69"/>
      <stop offset="100%" stop-color="#1a1035"/>
    </linearGradient>
    <linearGradient id="ring" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#a29bfe"/>
      <stop offset="50%" stop-color="#6c5ce7"/>
      <stop offset="100%" stop-color="#a29bfe"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#6c5ce7" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#6c5ce7" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Background circle -->
  <circle cx="${cx}" cy="${cy}" r="${cx}" fill="url(#bg)"/>

  <!-- Subtle glow -->
  <circle cx="${cx}" cy="${cy}" r="${r * 1.1}" fill="url(#glow)"/>

  <!-- Main ring -->
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#ring)" stroke-width="${Math.max(s * 0.055, 1)}"/>

  <!-- Orion's belt — three dots -->
  ${belt.map(d => `<circle cx="${d.x}" cy="${d.y}" r="${dotR}" fill="#a29bfe"/>`).join('\n  ')}

  <!-- Connecting lines (subtle) -->
  <line x1="${belt[0].x}" y1="${belt[0].y}" x2="${belt[1].x}" y2="${belt[1].y}" stroke="#a29bfe" stroke-opacity="0.4" stroke-width="${Math.max(s * 0.02, 0.5)}"/>
  <line x1="${belt[1].x}" y1="${belt[1].y}" x2="${belt[2].x}" y2="${belt[2].y}" stroke="#a29bfe" stroke-opacity="0.4" stroke-width="${Math.max(s * 0.02, 0.5)}"/>

  <!-- Center star -->
  <polygon points="${starPoints.join(' ')}" fill="#ffffff" opacity="0.9"/>

  <!-- Top accent star (small) -->
  <circle cx="${cx}" cy="${cy - r * 0.65}" r="${dotR * 0.7}" fill="#ffffff" opacity="0.7"/>

  <!-- Bottom accent dots -->
  <circle cx="${cx - r * 0.3}" cy="${cy + r * 0.6}" r="${dotR * 0.6}" fill="#a29bfe" opacity="0.5"/>
  <circle cx="${cx + r * 0.3}" cy="${cy + r * 0.6}" r="${dotR * 0.6}" fill="#a29bfe" opacity="0.5"/>
</svg>`
}

mkdirSync(OUT_DIR, { recursive: true })

// Write SVGs, then convert to PNG using sips (macOS built-in)
for (const size of SIZES) {
  const svg = generateSVG(size)
  const svgPath = join(OUT_DIR, `icon-${size}.svg`)
  const pngPath = join(OUT_DIR, `icon-${size}.png`)

  writeFileSync(svgPath, svg)
  console.log(`Generated SVG: ${svgPath}`)
}

// Generate a high-res SVG (512px) for conversion to all PNG sizes
const hiResSvg = generateSVG(512)
const hiResSvgPath = join(OUT_DIR, 'icon-source.svg')
writeFileSync(hiResSvgPath, hiResSvg)

console.log('\nSVG icons generated in icons/')
console.log('Converting to PNG using sips...\n')

// Use sips to convert SVG → PNG at each size (macOS)
// sips doesn't handle SVG well, so we'll try qlmanage or a mini HTML approach
// Actually, let's use a node-based approach with a simple HTTP trick

// Alternative: write a small HTML file and use screencapture? No — let's just try sips
// sips can resize PNGs. Let's render the SVG via a different method.

// Best cross-platform approach: use rsvg-convert if available, else try Python
try {
  // Try rsvg-convert first
  execSync('which rsvg-convert', { stdio: 'ignore' })
  for (const size of SIZES) {
    execSync(`rsvg-convert -w ${size} -h ${size} "${hiResSvgPath}" -o "${join(OUT_DIR, `icon-${size}.png`)}"`)
    console.log(`  PNG: icon-${size}.png`)
  }
} catch {
  // Try Python with cairosvg
  try {
    for (const size of SIZES) {
      execSync(`python3 -c "
import cairosvg
cairosvg.svg2png(url='${hiResSvgPath}', write_to='${join(OUT_DIR, `icon-${size}.png`)}', output_width=${size}, output_height=${size})
"`, { stdio: 'inherit' })
      console.log(`  PNG: icon-${size}.png`)
    }
  } catch {
    // Last resort: use sips with a temporary approach
    // Create PNGs from the per-size SVGs using qlmanage (macOS Quick Look)
    console.log('No rsvg-convert or cairosvg. Trying qlmanage...')
    try {
      // qlmanage can render SVGs to thumbnails
      for (const size of SIZES) {
        const svgPath = join(OUT_DIR, `icon-${size}.svg`)
        execSync(`qlmanage -t -s ${size} -o "${OUT_DIR}" "${svgPath}" 2>/dev/null || true`)
        // qlmanage outputs as icon-SIZE.svg.png
        const qlOutput = join(OUT_DIR, `icon-${size}.svg.png`)
        const target = join(OUT_DIR, `icon-${size}.png`)
        try {
          execSync(`mv "${qlOutput}" "${target}" 2>/dev/null`)
          console.log(`  PNG: icon-${size}.png`)
        } catch {
          console.log(`  Failed for ${size}px — will need manual conversion`)
        }
      }
    } catch {
      console.log('\nCould not auto-convert SVGs to PNG.')
      console.log('SVG files are ready in icons/ — convert manually or install librsvg:')
      console.log('  brew install librsvg')
      console.log('  Then re-run this script.')
    }
  }
}

console.log('\nDone!')
