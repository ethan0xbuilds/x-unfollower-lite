/**
 * Shared defaults for X Unfollower Lite.
 * Loaded in content scripts and popup (via importScripts / script tags).
 */
const XUL_DEFAULTS = Object.freeze({
  /** Max unfollows per local calendar day (conservative for store users). */
  dailyLimit: 20,
  /** Random delay range between unfollows (ms). */
  delayMinMs: 3000,
  delayMaxMs: 8000,
  /** Extra long pause every N unfollows (humanization). */
  longPauseEvery: 5,
  longPauseMinMs: 15000,
  longPauseMaxMs: 40000,
  /** Stop after this many consecutive DOM failures. */
  maxConsecutiveFailures: 3,
  /** Confirm dialog wait timeout (ms). */
  confirmTimeoutMs: 8000,
  /** Default filters. */
  protectMutual: true,
  followersMin: 0,
  followersMax: 10000000,
  /** Protected handles without @, lowercased. */
  whitelist: [],
});

const XUL_STORAGE_KEYS = Object.freeze({
  settings: "xul_settings",
  daily: "xul_daily",
});
