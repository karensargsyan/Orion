# Test Plan: Page Monitoring Fix

## Quick Verification Steps

### 1. Fresh Install Test
```
1. Remove extension from Chrome
2. Load updated extension (v1.0.19)
3. Complete onboarding (set up AI model)
4. Expected: Screenshot loop starts automatically
5. Verify: Open a grouped tab, wait 10s, check sitemap in DevTools
```

### 2. Settings Toggle Test
```
1. Settings → Automation → Page Monitoring
2. Uncheck "Background monitoring"
3. Save Settings
4. Expected: Loop stops immediately (no extension reload needed)
5. Re-check "Background monitoring"
6. Save Settings
7. Expected: Loop starts immediately
```

### 3. Interval Change Test
```
1. Enable monitoring with 10s interval
2. Wait for 1-2 screenshots to capture
3. Change interval to 30s
4. Save Settings
5. Expected: Loop restarts with 30s interval
6. Verify: Next screenshot appears after 30s (not 10s)
```

## DevTools Verification

### Check Screenshot Loop Status
Open background service worker console:
```javascript
// In service worker console (chrome://extensions → inspect views)
// Check if interval is running (look for interval ID logs)
```

### Check Visual Sitemap
```javascript
// Get sitemap data
chrome.storage.local.get('orion-visual-sitemap-v1', (data) => {
  console.log(JSON.stringify(data, null, 2))
})

// Expected structure:
{
  "orion-visual-sitemap-v1": {
    "example.com": {
      "domain": "example.com",
      "pages": {
        "/": {
          "path": "/",
          "url": "https://example.com/",
          "title": "Example Domain",
          "screenshotDataUrl": "data:image/jpeg;base64,...",
          "lastSeen": 1234567890,
          "visitCount": 3
        }
      },
      "lastUpdated": 1234567890
    }
  }
}
```

### Check Settings
```javascript
// Get current settings
chrome.storage.local.get('orion-settings', (data) => {
  const s = data['orion-settings']
  console.log('Monitoring enabled:', s.monitoringEnabled)
  console.log('Screenshot interval:', s.screenshotIntervalSec)
})
```

## Manual Testing Checklist

- [ ] Build completes without errors
- [ ] Extension loads in Chrome
- [ ] Settings UI shows "Background monitoring" toggle
- [ ] Settings UI shows "Screenshot interval" input
- [ ] Enabling monitoring starts loop immediately
- [ ] Disabling monitoring stops loop immediately
- [ ] Changing interval restarts loop with new value
- [ ] Screenshots appear in visual sitemap
- [ ] Only grouped tabs are captured
- [ ] Non-grouped tabs are ignored
- [ ] Extension restart preserves monitoring state
- [ ] Default interval is 10 seconds
- [ ] Monitoring enabled by default after onboarding

## Regression Testing

Ensure these features still work:
- [ ] Vision mode (separate from monitoring)
- [ ] Manual screenshot capture (if implemented)
- [ ] Tab grouping
- [ ] Visual sitemap display (if accessible)
- [ ] Settings persistence
- [ ] Extension reload behavior

## Edge Cases

- [ ] What happens if user sets interval to 0? (Should stop loop)
- [ ] What happens if user sets negative interval? (Should stop loop)
- [ ] What happens if no tabs are grouped? (Loop runs but captures nothing)
- [ ] What happens if Chrome is idle for hours? (Loop continues)
- [ ] What happens if user has 100+ tabs grouped? (Only active tab captured)

## Performance Monitoring

During testing, monitor:
- CPU usage (should be <1% idle)
- Memory usage (screenshots in IndexedDB, not RAM)
- Storage size (IndexedDB should auto-evict old entries)
- Extension responsiveness (no freezing)

## Known Limitations

These are NOT bugs (by design):
- Only captures tabs in Orion's group
- Only captures visible/active tab
- Only captures 1 tab per interval (not all grouped tabs)
- Screenshots stored in IndexedDB (not accessible via UI yet)
- Max 20 domains, 50 pages per domain (auto-eviction)

## Success Criteria

Fix is successful if:
1. ✅ Screenshot loop starts when `monitoringEnabled` is toggled ON
2. ✅ Screenshot loop stops when `monitoringEnabled` is toggled OFF
3. ✅ Screenshot loop restarts when interval changes
4. ✅ No extension reload required for changes to take effect
5. ✅ Screenshots appear in visual sitemap storage
6. ✅ Extension build succeeds with no TypeScript errors
