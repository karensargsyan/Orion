# Auto Version Bump + Build Notification — Implementation Report

**Slug:** auto-version-bump-notify
**Type:** Improvement (build tooling)
**Priority:** P1 (high)
**Status:** IMPLEMENTED
**Date:** 2026-04-13
**Developer:** @developer

---

## Summary

Successfully implemented automatic patch version bumping and build completion notifications in `build.ts`. Every `npm run build` now increments the patch version in both `src/manifest.json` and `package.json`, then displays a console banner with Chrome reload instructions. macOS users also receive a system notification.

---

## Changes Made

### File: `/Users/s/my/PrivateWebAssistent/build.ts`

#### 1. Added Import for System Notifications
```typescript
import { execSync } from 'child_process'
```

#### 2. Added `bumpPatchVersion()` Function
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

**Features:**
- Parses current version from `src/manifest.json`
- Increments patch number (third segment)
- Writes updated version back to `src/manifest.json`
- Syncs version to `package.json`
- Preserves JSON formatting (2 spaces, trailing newline)
- Returns new version string

#### 3. Added `notifyBuildReady()` Function
```typescript
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
  if (process.platform === 'darwin') {
    try {
      execSync(`osascript -e 'display notification "Reload in Chrome to test" with title "Orion v${version} ready"'`)
    } catch {
      // osascript unavailable — ignore
    }
  }
}
```

**Features:**
- Displays bordered console banner with version and Chrome reload instructions
- Fires macOS system notification using `osascript`
- Platform check prevents errors on non-macOS systems
- Silent failure if osascript unavailable

#### 4. Updated `main()` Function
```typescript
async function main(): Promise<void> {
  // Auto-bump version on every build (skip in watch mode to avoid infinite bumps)
  const newVersion = watch ? (() => {
    const m = JSON.parse(fs.readFileSync('src/manifest.json', 'utf8')) as { version: string }
    return m.version
  })() : bumpPatchVersion()

  copyStatic()

  if (watch) {
    const contexts = await Promise.all(buildConfigs.map(b => esbuild.context(b)))
    await Promise.all(contexts.map(ctx => ctx.watch()))
    console.log(`[watch] Orion v${newVersion} — watching for changes…`)
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
    notifyBuildReady(newVersion)
  }
}
```

**Changes:**
- Version bump logic moved inside `main()` to ensure proper watch mode detection
- `bumpPatchVersion()` called ONLY when NOT in watch mode
- `copyStatic()` called AFTER version bump to ensure bumped manifest is copied
- `notifyBuildReady()` called after successful build completion
- Watch mode shows current version without bumping

---

## Testing Results

### AC1: Version Increment
✅ **PASS** — Running `npm run build` incremented version from 1.0.6 → 1.0.7 → 1.0.8 → 1.0.9 → 1.0.10

### AC2: package.json Sync
✅ **PASS** — `package.json` version matches `src/manifest.json` after each build

### AC3: dist/manifest.json Contains New Version
✅ **PASS** — `dist/manifest.json` shows bumped version (not old version)

### AC4: Console Banner
✅ **PASS** — Bordered banner displayed with new version and Chrome reload instructions

### AC5: macOS Notification
✅ **PASS** — System notification fires on macOS with "Orion v{X.Y.Z} ready"

### AC6: Watch Mode Does NOT Bump
✅ **PASS** — `npm run watch` displays current version without incrementing

### AC7: Sequential Increments
✅ **PASS** — Multiple builds yielded 1.0.7, 1.0.8, 1.0.9, 1.0.10 — each run incremented exactly once

### AC8: Double-Digit Patch Numbers
✅ **PASS** — Version 1.0.9 correctly incremented to 1.0.10 (no overflow issues)

---

## Build Output Examples

### Normal Build
```
$ npm run build

> orion@1.0.9 build
> npx tsx build.ts


╔══════════════════════════════════════════════╗
║  ✅  Orion built — v1.0.10                    ║
║                                              ║
║  Load in Chrome:                             ║
║  1. Go to chrome://extensions                ║
║  2. Enable Developer Mode (toggle top-right) ║
║  3. "Load unpacked" → select dist/           ║
║     (or click "Update" if already loaded)    ║
╚══════════════════════════════════════════════╝
```

### Watch Mode
```
$ npm run watch

> orion@1.0.10 watch
> npx tsx build.ts --watch

[watch] Orion v1.0.10 — watching for changes…
```

---

## Version Synchronization Verification

After `npm run build`:

```bash
$ grep '"version"' src/manifest.json package.json dist/manifest.json

src/manifest.json:  "version": "1.0.10",
package.json:  "version": "1.0.10",
dist/manifest.json:  "version": "1.0.10",
```

All three files in perfect sync.

---

## Technical Details

### Version Bump Strategy
- Reads current version from `src/manifest.json`
- Splits version string by '.' and converts to numbers
- Increments third element (patch version)
- Joins back to string format
- Writes to both `src/manifest.json` and `package.json`

### Watch Mode Detection
- Uses existing `watch` flag from `process.argv.includes('--watch')`
- Version bump logic wrapped in conditional inside `main()` function
- Watch mode reads current version without modifying files

### Error Handling
- macOS notification wrapped in try-catch to prevent build failures
- Platform check (`process.platform === 'darwin'`) prevents execution on non-macOS
- Silent failure if `osascript` unavailable

### JSON Formatting
- Uses `JSON.stringify(obj, null, 2)` for consistent 2-space indentation
- Appends `\n` to maintain trailing newline convention

---

## Files Modified

1. **`/Users/s/my/PrivateWebAssistent/build.ts`** — added version bump and notification functions
2. **`/Users/s/my/PrivateWebAssistent/src/manifest.json`** — version auto-updated (now 1.0.10)
3. **`/Users/s/my/PrivateWebAssistent/package.json`** — version auto-updated (now 1.0.10)

---

## Known Limitations

1. **Platform-Specific Notification** — macOS only. Windows and Linux users see console banner but no system notification.
2. **Patch Version Only** — No support for bumping minor or major versions.
3. **Git Status** — Version bumps create git modifications. Developer must commit changes manually.
4. **No CI/CD Integration** — Manual build process only. No automatic version bumping in CI pipelines.

---

## Regression Risk: LOW

- Added code is isolated to build.ts
- No changes to runtime extension code
- Uses existing Node.js built-in modules (fs, path, child_process)
- Watch mode guard prevents infinite version increments
- Error handling prevents build failures from notification issues

---

## TypeScript Compilation

Build.ts compiles successfully with TypeScript. Note: Pre-existing type errors in other files (service-worker.ts, memory-manager.ts) are unrelated to this implementation.

---

## QA Testing Recommendations

### Test Scenarios

#### 1. Normal Build Flow
```bash
npm run build
# Verify: Version increments, banner shown, notification fires
```

#### 2. Sequential Builds
```bash
npm run build
npm run build
npm run build
# Verify: Each build increments by 1 (no skips or double-bumps)
```

#### 3. Watch Mode
```bash
npm run watch
# Verify: Version does NOT increment
# Edit a source file and save
# Verify: Version still does NOT increment
```

#### 4. Version Synchronization
```bash
npm run build
grep '"version"' src/manifest.json package.json dist/manifest.json
# Verify: All three show identical version
```

#### 5. Double-Digit Patch
```bash
# Manually edit src/manifest.json to "version": "1.0.9"
npm run build
grep '"version"' src/manifest.json
# Verify: Shows "1.0.10" (not "1.0.10" or malformed)
```

#### 6. Platform-Specific Notification
```bash
# On macOS: Verify system notification appears
# On Linux/Windows: Verify no error thrown (silent fail)
```

---

## Deployment Notes

- Developer must `git add` and `git commit` the version changes after each build
- Consider adding `src/manifest.json` and `package.json` to a post-build git hook if automatic commits desired
- Chrome extension users will see updated version number in chrome://extensions after reload

---

## Future Enhancements (Out of Scope)

1. Minor/major version bumping flags (e.g., `npm run build:minor`)
2. Automatic git commit + tag creation
3. Cross-platform notification support (Windows Toast, Linux notify-send)
4. CI/CD pipeline integration
5. Changelog auto-generation
6. Version bump dry-run mode

---

## Conclusion

The auto-version-bump-notify feature has been successfully implemented and tested. All acceptance criteria are met. The build process now automatically manages version numbers and provides clear feedback to developers about how to test the new build in Chrome.

**Status:** Ready for QA testing
**Next Step:** @qa-tester to verify all test scenarios and feed results back to @product-owner
