# Page Monitoring Feature Fix

## Problem Summary
User reported: "Page Monitoring not working at all, it should take the screenshot regularly and create memories."

## Root Cause Analysis

### What Was Broken
1. **Screenshot loop not restarted on settings changes**
   - When user changed `screenshotIntervalSec` or `monitoringEnabled` in Settings, the screenshot loop was NOT restarted
   - The loop was only started once during extension initialization (`onboardingComplete`)
   - Result: Changes to monitoring settings had no effect until extension reload

2. **Missing `monitoringEnabled` check on startup**
   - The screenshot loop started on `onboardingComplete` without checking if `monitoringEnabled` was true
   - If user disabled monitoring, it would still run until next reload

### What Page Monitoring Actually Does
1. **Screenshot Capture Loop** (`screenshot-loop.ts`):
   - Runs at interval defined by `screenshotIntervalSec` (default: 10 seconds)
   - Only captures tabs that are in Orion's tab group (`isOrionTab()`)
   - Captures visible tab as JPEG at 50% quality
   - Stores screenshot in `tabState`

2. **Memory Creation** (`visual-sitemap.ts`):
   - Screenshots are fed to `recordPageVisit(domain, url, snapshot, dataUrl)`
   - Creates `SitemapPageEntry` with:
     - Page metadata (title, headings, navigation links)
     - Screenshot data URL
     - Visit count and timestamp
   - Stores in IndexedDB as "visual sitemap" (domain-based navigation memory)
   - NOT traditional "memory entries" but sitemap entries with screenshots

3. **Storage Location**:
   - Visual sitemap stored in IndexedDB: `orion-visual-sitemap-v1`
   - Max 20 domains, 50 pages per domain
   - Older entries evicted automatically

## Files Modified

### `/Users/s/my/PrivateWebAssistent/src/background/service-worker.ts`

#### Change 1: Initialization Check
```typescript
// BEFORE (line 251-253):
if (settings!.onboardingComplete) {
  startScreenshotLoop(settings!.screenshotIntervalSec)
}

// AFTER:
if (settings!.onboardingComplete && settings!.monitoringEnabled) {
  startScreenshotLoop(settings!.screenshotIntervalSec)
}
```

**Why**: Only start the loop if monitoring is actually enabled, not just when onboarding is complete.

#### Change 2: Settings Update Handler
```typescript
// BEFORE (line 1784-1791):
case MSG.SETTINGS_SET: {
  const partial = msg.partial as Partial<Settings>
  await setSettings(partial)
  settings = null
  // Reset background AI failure counter when settings change (e.g., new model, new endpoint)
  resetBgCallFailures()
  return { ok: true }
}

// AFTER:
case MSG.SETTINGS_SET: {
  const partial = msg.partial as Partial<Settings>
  await setSettings(partial)
  settings = null
  // Reset background AI failure counter when settings change (e.g., new model, new endpoint)
  resetBgCallFailures()

  // Restart screenshot loop if monitoring settings changed
  const s = await getSettings()
  if (partial.monitoringEnabled !== undefined || partial.screenshotIntervalSec !== undefined) {
    if (s.monitoringEnabled && s.screenshotIntervalSec > 0) {
      startScreenshotLoop(s.screenshotIntervalSec)
    } else {
      stopScreenshotLoop()
    }
  }

  return { ok: true }
}
```

**Why**:
- When user changes monitoring settings, immediately restart/stop the loop
- If `monitoringEnabled` is checked → start loop
- If `monitoringEnabled` is unchecked → stop loop
- If `screenshotIntervalSec` changes → restart loop with new interval

## How to Test the Feature

### Prerequisites
1. Load the extension in Chrome (`chrome://extensions` → Load unpacked → `dist/`)
2. Complete onboarding (set up an AI model)
3. Have at least one tab in an Orion group (use the sidebar panel)

### Test 1: Enable Monitoring from Settings
1. Open Settings (gear icon in sidepanel)
2. Go to **Automation** tab
3. Find **Page Monitoring** section
4. Enable **"Background monitoring"** checkbox
5. Set **Screenshot interval** to `5` seconds (for faster testing)
6. Click **Save Settings**
7. **Expected**: Screenshot loop starts immediately (no reload needed)

### Test 2: Verify Screenshots Are Captured
1. Enable monitoring (Test 1)
2. Open a web page in an Orion tab group (e.g., wikipedia.org)
3. Wait 5-10 seconds
4. Open DevTools → Console
5. Run: `chrome.storage.local.get('orion-visual-sitemap-v1')`
6. **Expected**: You should see sitemap entries with `screenshotDataUrl` fields containing base64 JPEG data

### Test 3: Change Screenshot Interval
1. With monitoring enabled, change interval from 5 to 15 seconds
2. Click **Save Settings**
3. **Expected**: Loop restarts with new 15-second interval (verify in console logs)

### Test 4: Disable Monitoring
1. Uncheck **"Background monitoring"**
2. Click **Save Settings**
3. **Expected**: Screenshot loop stops immediately
4. **Verify**: No new screenshots added to sitemap (check in DevTools)

### Test 5: Extension Restart with Monitoring Enabled
1. Enable monitoring, save settings
2. Reload the extension (`chrome://extensions` → reload icon)
3. Open a tab in Orion group
4. **Expected**: Screenshot loop starts automatically on extension load

### Test 6: Extension Restart with Monitoring Disabled
1. Disable monitoring, save settings
2. Reload the extension
3. **Expected**: Screenshot loop does NOT start

### Test 7: Non-Orion Tabs Are Ignored
1. Enable monitoring
2. Open a tab but DON'T add it to Orion group
3. Wait through several screenshot intervals
4. **Expected**: No screenshots captured for non-grouped tabs
5. **Verify**: Only grouped tabs appear in visual sitemap

## Configuration Details

### Settings
- **`monitoringEnabled`**: Boolean, default `true`
  - Master toggle for screenshot loop
  - Located in Settings → Automation → Page Monitoring

- **`screenshotIntervalSec`**: Number, default `10` seconds
  - Minimum: 5 seconds
  - Maximum: 120 seconds
  - Located in Settings → Automation → Screenshot interval

- **`visionEnabled`**: Boolean, default `false`
  - Separate feature: sends screenshots to AI for visual understanding
  - Requires vision-capable model (Gemini 2.5, GPT-4o, etc.)
  - Shows/hides the screenshot interval setting in UI

### Storage
- **IndexedDB store**: `orion-visual-sitemap-v1`
- **Structure**: `{ [domain]: { domain, pages: { [path]: SitemapPageEntry }, lastUpdated } }`
- **Limits**:
  - Max 20 domains globally
  - Max 50 pages per domain
  - Automatic eviction of oldest/least-visited pages

### Screenshot Format
- **Format**: JPEG
- **Quality**: 50% (balance between quality and storage)
- **API**: `chrome.tabs.captureVisibleTab()`
- **Storage**: Base64 data URL embedded in sitemap entry

## Performance Impact

### Resource Usage
- **Interval**: Every 5-120 seconds (default 10s)
- **Screenshot size**: ~50-150KB JPEG per capture
- **CPU**: Minimal (JPEG encoding done by Chrome)
- **Memory**: Screenshots stored in IndexedDB (not RAM)
- **Network**: Zero (all local)

### Optimization
- Only captures **visible tab** in **current window**
- Only captures tabs in **Orion's tab group**
- Automatic **eviction** of old pages (50/domain max)
- **Silent failure** if no capturable tab exists

## Common Issues

### Issue 1: "Screenshots not appearing"
**Cause**: Tab not in Orion group
**Solution**: Group the tab first (click panel icon → "Group Active Tab")

### Issue 2: "Monitoring doesn't start"
**Cause**: Extension not fully initialized
**Solution**: Ensure onboarding is complete (AI model configured)

### Issue 3: "Settings change has no effect"
**Cause**: (Fixed in this update)
**Solution**: Update to v1.0.19+

### Issue 4: "Too many screenshots filling storage"
**Cause**: Low interval + many tabs
**Solution**:
- Increase interval to 30-60 seconds
- Visual sitemap auto-evicts old entries (max 50 pages/domain)

## Architecture

### Call Flow
```
startScreenshotLoop(intervalSec)
  ↓
setInterval(captureActiveTab, intervalSec * 1000)
  ↓
captureActiveTab()
  ↓ query active tab
  ↓ check isOrionTab()
  ↓
captureScreenshot(tabId)
  ↓ chrome.tabs.captureVisibleTab()
  ↓ tabState.setScreenshot()
  ↓
recordPageVisit(domain, url, snapshot, dataUrl)
  ↓
Store in visual sitemap (IndexedDB)
```

### Files Involved
- **`src/background/screenshot-loop.ts`**: Screenshot capture loop
- **`src/background/visual-sitemap.ts`**: Sitemap storage and retrieval
- **`src/background/service-worker.ts`**: Extension lifecycle and settings
- **`src/background/tab-state.ts`**: Tab-level state management
- **`src/sidepanel/settings-ui.ts`**: Settings UI rendering
- **`src/shared/types.ts`**: Type definitions
- **`src/shared/constants.ts`**: Default values

## Related Features

### Vision Mode
- **Independent feature** (separate from monitoring)
- When enabled, sends screenshots to AI for visual analysis
- Requires vision-capable model
- Uses same `screenshotIntervalSec` setting

### Visual Sitemap
- **Consumer** of screenshot data
- Creates domain-based page memory
- Tracks navigation structure
- Used by AI for navigation context

### Tab Groups (Web Researcher)
- **Prerequisite** for monitoring
- Only grouped tabs are monitored
- Group created via sidepanel → "Group Active Tab"

## Version History
- **v1.0.18**: Page Monitoring not working (settings changes ignored)
- **v1.0.19**: Fixed - monitoring restarts on settings change ✅

## Future Enhancements (Not Implemented)
- [ ] Per-tab monitoring control
- [ ] Screenshot quality setting
- [ ] Manual screenshot trigger
- [ ] Export sitemap with screenshots
- [ ] Visual diff detection (highlight page changes)
- [ ] OCR text extraction from screenshots
