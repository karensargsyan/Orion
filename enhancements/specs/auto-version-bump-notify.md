# Auto Version Bump + Build Notification

**Slug:** auto-version-bump-notify
**Type:** Improvement (build tooling)
**Priority:** P1 (high — every build must increase version; developer needs to know when to test)
**Requested:** 2026-04-12
**Status:** SPECCED

## Summary
Every `npm run build` must automatically increment the patch version in `src/manifest.json` (and `package.json`) before bundling. After a successful build, the developer must be visibly notified of the new version number and reminded how to reload the extension in Chrome developer mode. Currently `build.ts` copies `src/manifest.json` as-is with no version bump.

## Current Behavior
- `build.ts` line 26: `copyFile('src/manifest.json', 'dist/manifest.json')` — copies manifest with no modification
- Version stays at `1.0.1` across all builds unless manually edited
- No post-build notification
- Developer must manually check `src/manifest.json` to know current version

## Desired Behavior
Every build:
1. Reads current version from `src/manifest.json`
2. Increments patch: `1.0.1` → `1.0.2`
3. Writes new version back to `src/manifest.json`
4. Also updates `package.json` version to match
5. Copies bumped manifest to `dist/manifest.json`
6. After successful build, prints a prominent console banner:
   ```
   ╔══════════════════════════════════════════════╗
   ║  ✅  Orion built — v1.0.2                    ║
   ║                                              ║
   ║  Load in Chrome:                             ║
   ║  1. Go to chrome://extensions                ║
   ║  2. Enable Developer Mode                    ║
   ║  3. Click "Load unpacked" → select /dist     ║
   ║     (or click "Update" if already loaded)    ║
   ╚══════════════════════════════════════════════╝
   ```
7. Fires a macOS system notification (osascript) so developer knows even if terminal is in background:
   ```
   Orion v1.0.2 ready — reload in Chrome
   ```

## Exact Implementation

### Changes to `build.ts`

**Add version bump function (before `copyStatic`):**
```typescript
function bumpPatchVersion(): string {
  // Bump src/manifest.json
  const manifestPath = path.join(__dirname, 'src/manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version: string }
  const parts = manifest.version.split('.').map(Number)
  parts[2] = (parts[2] ?? 0) + 1
  const newVersion = parts.join('.')
  manifest.version = newVersion
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  // Keep package.json in sync
  const pkgPath = path.join(__dirname, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }
  pkg.version = newVersion
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  return newVersion
}
```

**Add post-build notification function:**
```typescript
import { execSync } from 'child_process'

function notifyBuildReady(version: string): void {
  const box = [
    '╔══════════════════════════════════════════════╗',
    `║  ✅  Orion built — v${version.padEnd(26)}║`,
    '║                                              ║',
    '║  Load in Chrome:                             ║',
    '║  1. Go to chrome://extensions                ║',
    '║  2. Enable Developer Mode (toggle top-right) ║',
    '║  3. "Load unpacked" → select dist/           ║',
    '║     (or click "Update" if already loaded)    ║',
    '╚══════════════════════════════════════════════╝',
  ]
  console.log('\n' + box.join('\n') + '\n')

  // macOS system notification (silent fail on other platforms)
  try {
    execSync(`osascript -e 'display notification "Reload in Chrome to test" with title "Orion v${version} ready"'`)
  } catch {
    // Not macOS or osascript unavailable — ignore
  }
}
```

**Update main build flow in `build.ts`:**

Before `copyStatic()`:
```typescript
// Auto-bump version on every build (skip in watch mode to avoid infinite bumps)
const newVersion = watch ? (() => {
  const m = JSON.parse(fs.readFileSync('src/manifest.json', 'utf8')) as { version: string }
  return m.version
})() : bumpPatchVersion()
```

After all builds complete successfully:
```typescript
if (!watch) {
  notifyBuildReady(newVersion)
} else {
  console.log(`[watch] Orion v${newVersion} — watching for changes…`)
}
```

**Watch mode:** Version is NOT bumped during `npm run watch` (would create infinite increments on file save). Only `npm run build` bumps the version.

## Acceptance Criteria
- [ ] AC1: Running `npm run build` increments patch version in `src/manifest.json` (e.g., 1.0.1 → 1.0.2)
- [ ] AC2: `package.json` version matches `src/manifest.json` version after build
- [ ] AC3: `dist/manifest.json` contains the new bumped version (not the old one)
- [ ] AC4: Console shows the bordered banner with new version and Chrome reload instructions
- [ ] AC5: macOS notification fires with "Orion v{X.Y.Z} ready"
- [ ] AC6: Running `npm run watch` does NOT bump the version
- [ ] AC7: Running build twice yields 1.0.2 then 1.0.3 — each run increments exactly once
- [ ] AC8: If `src/manifest.json` has version `1.0.9`, next build produces `1.0.10` (not `1.0.10` overflow)

## Test Scenarios
```bash
# Before: src/manifest.json version = "1.0.1"
npm run build
# After: src/manifest.json version = "1.0.2", dist/manifest.json version = "1.0.2"
# Console shows banner with v1.0.2
# macOS notification fires

npm run build
# After: version = "1.0.3"

npm run watch
# Version stays at "1.0.3" — watch does not bump
```

## Files to Modify
- `build.ts` — add `bumpPatchVersion()`, `notifyBuildReady()`, call both in main build flow
- No other files

## Regression Risk
- `build.ts` already imports `fs` and `path` — no new imports except `child_process` (built-in Node.js)
- `bumpPatchVersion()` modifies `src/manifest.json` in-place — will appear in `git diff` after each build. This is intentional and expected.
- Watch mode guard prevents version spam — verify `watch` flag detection is correct

## Out of Scope
- Minor/major version bumping
- Auto-commit or git tag on build
- Windows notification (only macOS `osascript` implemented)
- CI/CD pipeline integration
