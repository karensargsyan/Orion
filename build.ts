import * as esbuild from 'esbuild'
import * as fs from 'fs'
import * as path from 'path'

const watch = process.argv.includes('--watch')

// Ensure dist directories exist
const dirs = ['dist', 'dist/background', 'dist/content', 'dist/sidepanel', 'dist/offscreen', 'dist/permissions', 'dist/icons']
for (const d of dirs) fs.mkdirSync(d, { recursive: true })

// Copy static files
function copyFile(src: string, dest: string): void {
  if (fs.existsSync(src)) fs.copyFileSync(src, dest)
  else console.warn(`Warning: ${src} not found, skipping`)
}

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) {
    console.warn(`Warning: ${src} not found, skipping`)
    return
  }
  fs.cpSync(src, dest, { recursive: true })
}

function copyStatic(): void {
  copyFile('src/manifest.json', 'dist/manifest.json')
  copyFile('src/sidepanel/sidepanel.html', 'dist/sidepanel/sidepanel.html')
  copyFile('src/offscreen/offscreen.html', 'dist/offscreen/offscreen.html')
  copyFile('src/permissions/microphone-permission.html', 'dist/permissions/microphone-permission.html')
  copyFile('docs/privacy-policy.html', 'dist/privacy-policy.html')
  if (fs.existsSync('icons')) copyDir('icons', 'dist/icons')
  // _dev is NOT copied to dist — Chrome rejects filenames starting with "_"
}

const sharedOptions: esbuild.BuildOptions = {
  bundle: true,
  sourcemap: true,
  target: ['chrome114'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
}

const buildConfigs: esbuild.BuildOptions[] = [
  // Service Worker (ESM — MV3 supports type:module)
  {
    ...sharedOptions,
    entryPoints: ['src/background/service-worker.ts'],
    outfile: 'dist/background/service-worker.js',
    format: 'esm',
    platform: 'browser',
  },
  // Content Script (IIFE — bundled, injected into pages)
  {
    ...sharedOptions,
    entryPoints: ['src/content/content-main.ts'],
    outfile: 'dist/content/content-main.js',
    format: 'iife',
    platform: 'browser',
  },
  // Side Panel (ESM — loaded as a regular HTML page)
  {
    ...sharedOptions,
    entryPoints: ['src/sidepanel/sidepanel.ts'],
    outfile: 'dist/sidepanel/sidepanel.js',
    format: 'esm',
    platform: 'browser',
  },
  // Offscreen Document (ESM — used for Web Speech API / mic access)
  {
    ...sharedOptions,
    entryPoints: ['src/offscreen/offscreen.ts'],
    outfile: 'dist/offscreen/offscreen.js',
    format: 'esm',
    platform: 'browser',
  },
  // Permission page (ESM — visible extension page for mic permission)
  {
    ...sharedOptions,
    entryPoints: ['src/permissions/microphone-permission.ts'],
    outfile: 'dist/permissions/microphone-permission.js',
    format: 'esm',
    platform: 'browser',
  },
]

copyStatic()

async function main(): Promise<void> {
  if (watch) {
    const contexts = await Promise.all(buildConfigs.map(b => esbuild.context(b)))
    await Promise.all(contexts.map(ctx => ctx.watch()))
    console.log('[LocalAI] Watching for changes… (Ctrl+C to stop)')
    // Keep process alive
    await new Promise(() => {})
  } else {
    const results = await Promise.all(buildConfigs.map(b => esbuild.build(b)))
    const errors = results.flatMap(r => r.errors)
    const warnings = results.flatMap(r => r.warnings)
    if (warnings.length) console.warn(`[LocalAI] ${warnings.length} warning(s)`)
    if (errors.length) {
      console.error(`[LocalAI] Build failed with ${errors.length} error(s)`)
      process.exit(1)
    }
    console.log('[LocalAI] Build complete → dist/')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
