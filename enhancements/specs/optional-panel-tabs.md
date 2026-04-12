# Optional Panel Tabs — History, Insights, Vault, Learn

**Slug:** optional-panel-tabs
**Type:** Feature + Settings Architecture
**Priority:** P1 (high — privacy, clutter, onboarding)
**Requested:** 2026-04-12
**Status:** SPECCED

## Summary
All 7 sidepanel tabs (Chat, Memory, Insights, Vault, History, Groups, Settings) are always visible with no way to hide them. Features like Insights (usage analytics), Vault (credential storage), Learn (supervised recording), and History are advanced and potentially privacy-sensitive — they should be opt-in, off by default, and controllable from Settings. Each feature needs two independent controls: (1) **Enable** — whether the feature runs/collects data at all, (2) **Show in panel** — whether its tab appears in the sidepanel.

## Desired Settings Architecture

### Two-level control per feature

```
Settings → Panel Tabs

□ History          [Enable]  □ [Show in panel]
□ Insights         [Enable]  □ [Show in panel]
□ Vault            [Enable]  □ [Show in panel]
□ Learn            [Enable]  □ [Show in panel]
□ Tab Groups       [Enable]  □ [Show in panel]
□ Memory           [Enable]  □ [Show in panel]   ← already exists but not tab-level
```

- **Enable** (master toggle): OFF = feature is fully disabled (no data collection, no background activity). Hiding the tab alone does NOT stop data collection.
- **Show in panel** (visibility): Only available when Enable is ON. Controls whether the tab icon appears.
- **Dependency**: If Enable is turned OFF, Show in panel is automatically unchecked and grayed out.

### New defaults (all opt-in)

| Feature | Enable default | Show in panel default | Reasoning |
|---------|---------------|----------------------|-----------|
| Chat | always on, not toggleable | always visible | Core feature |
| Memory | ON | ON | Core to AI quality |
| Settings | always on, not toggleable | always visible | Core feature |
| History | **OFF** | OFF | Privacy — stores all conversations |
| Insights | **OFF** | OFF | Analytics — stores all interactions |
| Vault | **OFF** | OFF | Security feature — opt-in |
| Learn | **OFF** | OFF | Advanced — records browser activity |
| Tab Groups | ON | ON | Useful by default, low risk |

## Technical Analysis

### New Settings fields needed (`src/shared/types.ts`)

Add to `Settings` interface:
```typescript
// Panel tab visibility (opt-in features)
historyEnabled: boolean          // default: false — stores conversation history
historyShowInPanel: boolean      // default: false

insightsEnabled: boolean         // default: false — collects domain stats, habits, actions
insightsShowInPanel: boolean     // default: false

vaultEnabled: boolean            // default: false — credential storage
vaultShowInPanel: boolean        // default: false

learnEnabled: boolean            // default: false — supervised learning recording
learnShowInPanel: boolean        // default: false

tabGroupsEnabled: boolean        // default: true — tab group management
tabGroupsShowInPanel: boolean    // default: true
```

### Default values (`src/shared/constants.ts`)

Add to DEFAULTS:
```typescript
HISTORY_ENABLED: false,
HISTORY_SHOW_IN_PANEL: false,
INSIGHTS_ENABLED: false,
INSIGHTS_SHOW_IN_PANEL: false,
VAULT_ENABLED: false,
VAULT_SHOW_IN_PANEL: false,
LEARN_ENABLED: false,
LEARN_SHOW_IN_PANEL: false,
TAB_GROUPS_ENABLED: true,
TAB_GROUPS_SHOW_IN_PANEL: true,
```

### Tab rendering (`src/sidepanel/sidepanel.ts`)

Current tab definitions (lines 244–270) always render all tabs. Change to conditional:

```typescript
function renderTabs(settings: Settings) {
  const tabs = [
    { id: 'chat', icon: '💬', label: 'Chat', always: true },
    { id: 'memory', icon: '🔍', label: 'Memory', showKey: null, always: true },  // memory has its own enable toggle
    { id: 'history', icon: '🕐', label: 'History', showKey: 'historyShowInPanel', enableKey: 'historyEnabled' },
    { id: 'insights', icon: '📊', label: 'Insights', showKey: 'insightsShowInPanel', enableKey: 'insightsEnabled' },
    { id: 'vault', icon: '🔒', label: 'Vault', showKey: 'vaultShowInPanel', enableKey: 'vaultEnabled' },
    { id: 'active-tabs', icon: '📋', label: 'Groups', showKey: 'tabGroupsShowInPanel', enableKey: 'tabGroupsEnabled' },
    { id: 'settings', icon: '⚙️', label: 'Settings', always: true },
  ]
  return tabs
    .filter(t => t.always || settings[t.showKey as keyof Settings])
    .map(t => `<button class="tab-btn" data-tab="${t.id}" title="${t.label}">${t.icon}</button>`)
    .join('')
}
```

The "Learn" floating button (sidepanel.ts lines 272–275) is shown only if `settings.learnEnabled && settings.learnShowInPanel`.

### Feature gating (disable = no data collection)

When `historyEnabled = false`:
- `service-worker.ts` lines 891–897 and 1179–1185: wrap `appendChatMessage()` calls with `if (s.historyEnabled)`

When `insightsEnabled = false`:
- Skip recording to `session_memory`, `habit_patterns`, `calendar_events`, `domain_skills` stores
- Gate in `behavior-learner.ts` and wherever `recordSessionMemory()` / `recordCalendarEvent()` is called

When `learnEnabled = false`:
- `startSupervisedMode()` should early-return
- Learning snapshot captures should not run

When `vaultEnabled = false`:
- Auto-collection (`autoCollectEnabled` already gated separately) should not run
- Vault tab click shows "Enable Vault in Settings" prompt instead of PIN screen

### Settings UI — Panel Tabs section (`src/sidepanel/settings-ui.ts`)

Add a new "Panel" tab (or section within existing UI) with the two-level control:

```html
<section class="settings-section">
  <h3>Panel Tabs</h3>
  <p class="settings-note">Control which features are active and visible in the panel.</p>

  <div class="tab-control-row">
    <label class="feature-name">History</label>
    <label class="toggle-label">Enable <input type="checkbox" data-setting="historyEnabled"></label>
    <label class="toggle-label" data-depends="historyEnabled">Show in panel <input type="checkbox" data-setting="historyShowInPanel"></label>
  </div>
  <!-- repeat for Insights, Vault, Learn, Tab Groups -->
</section>
```

JS: When "Enable" is unchecked, automatically uncheck "Show in panel" and disable it:
```typescript
document.querySelectorAll('input[data-setting$="Enabled"]').forEach(el => {
  el.addEventListener('change', () => {
    const feature = el.dataset.setting!.replace('Enabled', '')
    const showToggle = document.querySelector(`input[data-setting="${feature}ShowInPanel"]`) as HTMLInputElement
    if (showToggle) {
      if (!el.checked) { showToggle.checked = false; showToggle.disabled = true }
      else { showToggle.disabled = false }
      saveSettings()
    }
  })
})
```

### First-run / upgrade migration

Existing users who already use Vault/History should not lose access on upgrade. On first load after update:
```typescript
// In service-worker.ts initialization
if (isFirstRunAfterUpdate) {
  const hasVaultData = await vaultHasEntries()
  const hasHistory = await getSessionCount() > 0
  if (hasVaultData) await updateSettings({ vaultEnabled: true, vaultShowInPanel: true })
  if (hasHistory) await updateSettings({ historyEnabled: true, historyShowInPanel: true })
}
```

## Acceptance Criteria
- [ ] AC1: Fresh install — History, Insights, Vault, Learn tabs are NOT visible in the sidepanel
- [ ] AC2: Settings → Panel shows Enable + Show in panel toggles for each optional tab
- [ ] AC3: Enabling a feature AND checking "Show in panel" makes the tab appear immediately (no reload)
- [ ] AC4: Disabling a feature automatically unchecks "Show in panel" and stops data collection
- [ ] AC5: When `historyEnabled = false`, `appendChatMessage()` is never called — no conversations stored
- [ ] AC6: When `insightsEnabled = false`, no entries written to `session_memory`, `habit_patterns`, `calendar_events`
- [ ] AC7: Existing users who have Vault data or History on upgrade automatically get those tabs re-enabled
- [ ] AC8: Chat, Memory, and Settings tabs always remain visible regardless of settings

## Files to Modify
- `src/shared/types.ts` — add 10 new settings fields to `Settings` interface
- `src/shared/constants.ts` — add DEFAULTS for new fields
- `src/sidepanel/sidepanel.ts` — make tab rendering conditional on `settings.*ShowInPanel`
- `src/sidepanel/settings-ui.ts` — add Panel Tabs section with two-level controls
- `src/background/service-worker.ts` — gate `appendChatMessage()`, `recordSessionMemory()`, `startSupervisedMode()`
- `src/background/behavior-learner.ts` — gate on `insightsEnabled`

## Regression Risk
- **Breaking**: Existing users on fresh profile will lose History/Vault/Insights tabs after upgrade. Mitigation: migration check in AC7.
- **Settings sync**: `chrome.storage.sync` has a 100KB limit and 512 item limit — adding 10 booleans is safe.
- **Tab order**: Conditional rendering must preserve consistent tab order regardless of which tabs are enabled.

## Out of Scope
- Per-feature data deletion UI (e.g., "Delete all insights data")
- Rearranging tab order by user drag
- Improving Insights content (separate spec)
