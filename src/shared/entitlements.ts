/**
 * Entitlements & Tier Definitions (v1.0 — Design Only)
 *
 * This module defines the tier structure and feature gating architecture
 * for future monetization. Currently all users get 'free' tier with no
 * restrictions (all limits set to maximum).
 *
 * Gating insertion points:
 * - Cross-tab compare: chat.ts → addTabBtn click handler
 * - Saved workflows: workflow-engine.ts → createWorkflow()
 * - Watch sessions: watch-manager.ts → startWatch()
 * - Custom instructions: instruction-manager.ts → saveUserInstruction()
 * - Cloud sync: (future) cloud-sync.ts
 */

export type Tier = 'free' | 'pro' | 'enterprise'

export interface Entitlements {
  tier: Tier
  maxCrossTabCompare: number
  maxSavedWorkflows: number
  maxConcurrentWatch: number
  maxCustomInstructions: number
  cloudSyncEnabled: boolean
  priorityRouting: boolean
  teamPlaybooks: boolean
}

export const TIER_LIMITS: Record<Tier, Entitlements> = {
  free: {
    tier: 'free',
    maxCrossTabCompare: 1,
    maxSavedWorkflows: 3,
    maxConcurrentWatch: 1,
    maxCustomInstructions: 3,
    cloudSyncEnabled: false,
    priorityRouting: false,
    teamPlaybooks: false,
  },
  pro: {
    tier: 'pro',
    maxCrossTabCompare: 3,
    maxSavedWorkflows: Infinity,
    maxConcurrentWatch: 5,
    maxCustomInstructions: Infinity,
    cloudSyncEnabled: true,
    priorityRouting: true,
    teamPlaybooks: false,
  },
  enterprise: {
    tier: 'enterprise',
    maxCrossTabCompare: Infinity,
    maxSavedWorkflows: Infinity,
    maxConcurrentWatch: Infinity,
    maxCustomInstructions: Infinity,
    cloudSyncEnabled: true,
    priorityRouting: true,
    teamPlaybooks: true,
  },
}

/**
 * Get current user tier. Currently always returns 'free' with no restrictions.
 * Future: will check chrome.storage.local for cached license token.
 */
export function getCurrentTier(): Tier {
  // TODO: Implement license validation
  // 1. Check chrome.storage.local for cached license token
  // 2. If expired/missing, call license server with device fingerprint
  // 3. Cache response for 24h
  // 4. Degrade gracefully to 'free' on network failure
  return 'free'
}

/**
 * Get entitlements for the current tier.
 * Currently returns free tier with no enforcement (all limits are uncapped for v1.0).
 */
export function getEntitlements(): Entitlements {
  // For v1.0 launch: return uncapped limits regardless of tier
  // This allows all features to work without restrictions.
  // When monetization is activated, change this to:
  //   return TIER_LIMITS[getCurrentTier()]
  return {
    tier: 'free',
    maxCrossTabCompare: Infinity,
    maxSavedWorkflows: Infinity,
    maxConcurrentWatch: Infinity,
    maxCustomInstructions: Infinity,
    cloudSyncEnabled: false,
    priorityRouting: false,
    teamPlaybooks: false,
  }
}

/**
 * Check if a specific feature is available at the current tier.
 * For v1.0: always returns true (no gating).
 */
export function checkEntitlement(feature: keyof Entitlements): boolean {
  const ent = getEntitlements()
  const val = ent[feature]
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val > 0
  return true
}

/**
 * Check if a numeric limit has been reached.
 * For v1.0: always returns false (no limits enforced).
 */
export function isLimitReached(feature: keyof Entitlements, currentCount: number): boolean {
  const ent = getEntitlements()
  const limit = ent[feature]
  if (typeof limit !== 'number') return false
  return currentCount >= limit
}
