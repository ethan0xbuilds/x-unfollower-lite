/**
 * chrome.storage.local helpers — daily counters + user settings.
 *
 * CRITICAL: After extension reload/update, old content scripts lose their
 * extension context. Public APIs here must NEVER reject with
 * "Extension context invalidated" — always soft-fail to defaults / no-ops.
 */
const XULStorage = (() => {
  function isContextValid() {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  }

  function isInvalidatedError(err) {
    const msg = String((err && (err.message || err)) || err || "");
    return /extension context invalidated|context invalidated/i.test(msg);
  }

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function mergeSettings(raw) {
    const base = { ...XUL_DEFAULTS };
    if (!raw || typeof raw !== "object") return base;
    return {
      dailyLimit: clampInt(raw.dailyLimit, 1, 100, base.dailyLimit),
      sessionLimit: clampInt(raw.sessionLimit, 1, 100, base.sessionLimit),
      delayMinMs: clampInt(raw.delayMinMs, 2000, 60000, base.delayMinMs),
      delayMaxMs: clampInt(raw.delayMaxMs, 3000, 120000, base.delayMaxMs),
      longPauseEvery: clampInt(raw.longPauseEvery, 0, 50, base.longPauseEvery),
      longPauseMinMs: clampInt(raw.longPauseMinMs, 5000, 120000, base.longPauseMinMs),
      longPauseMaxMs: clampInt(raw.longPauseMaxMs, 5000, 180000, base.longPauseMaxMs),
      maxConsecutiveFailures: clampInt(
        raw.maxConsecutiveFailures,
        1,
        10,
        base.maxConsecutiveFailures
      ),
      confirmTimeoutMs: clampInt(raw.confirmTimeoutMs, 3000, 30000, base.confirmTimeoutMs),
      protectMutual: raw.protectMutual !== false,
      skipUnknownFollowers: !!raw.skipUnknownFollowers,
      highlightQueued: raw.highlightQueued !== false,
      followersMin: clampInt(raw.followersMin, 0, 1e9, base.followersMin),
      followersMax: clampInt(raw.followersMax, 0, 1e9, base.followersMax),
      whitelist: normalizeWhitelist(raw.whitelist),
    };
  }

  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function normalizeWhitelist(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const h = String(item || "")
        .trim()
        .replace(/^@/, "")
        .toLowerCase();
      if (!h || seen.has(h)) continue;
      seen.add(h);
      out.push(h);
    }
    return out;
  }

  /** @returns {Promise<Record<string, any>>} never rejects for context death */
  async function storageGet(keys) {
    if (!isContextValid()) return {};
    try {
      return await chrome.storage.local.get(keys);
    } catch (err) {
      if (isInvalidatedError(err)) return {};
      // Other errors: still soft-fail so UI keeps working
      return {};
    }
  }

  /** @returns {Promise<boolean>} true if written */
  async function storageSet(obj) {
    if (!isContextValid()) return false;
    try {
      await chrome.storage.local.set(obj);
      return true;
    } catch (err) {
      if (isInvalidatedError(err)) return false;
      return false;
    }
  }

  async function getSettings() {
    const data = await storageGet(XUL_STORAGE_KEYS.settings);
    return mergeSettings(data[XUL_STORAGE_KEYS.settings]);
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    const next = mergeSettings({ ...current, ...partial });
    if (next.delayMinMs > next.delayMaxMs) {
      const t = next.delayMinMs;
      next.delayMinMs = next.delayMaxMs;
      next.delayMaxMs = t;
    }
    if (next.longPauseMinMs > next.longPauseMaxMs) {
      const t = next.longPauseMinMs;
      next.longPauseMinMs = next.longPauseMaxMs;
      next.longPauseMaxMs = t;
    }
    if (next.followersMin > next.followersMax) {
      const t = next.followersMin;
      next.followersMin = next.followersMax;
      next.followersMax = t;
    }
    await storageSet({ [XUL_STORAGE_KEYS.settings]: next });
    // Return desired settings even if write failed (context dead)
    return next;
  }

  async function getDaily() {
    const data = await storageGet(XUL_STORAGE_KEYS.daily);
    const raw = data[XUL_STORAGE_KEYS.daily] || {};
    const today = todayKey();
    if (raw.date !== today) {
      const fresh = { date: today, count: 0 };
      await storageSet({ [XUL_STORAGE_KEYS.daily]: fresh });
      return fresh;
    }
    return {
      date: today,
      count: clampInt(raw.count, 0, 1e6, 0),
    };
  }

  async function incrementDaily(by = 1) {
    const daily = await getDaily();
    daily.count += by;
    await storageSet({ [XUL_STORAGE_KEYS.daily]: daily });
    return daily;
  }

  async function getQuota() {
    const [settings, daily] = await Promise.all([getSettings(), getDaily()]);
    const remaining = Math.max(0, settings.dailyLimit - daily.count);
    return {
      settings,
      daily,
      remaining,
      used: daily.count,
      limit: settings.dailyLimit,
      contextValid: isContextValid(),
    };
  }

  return {
    todayKey,
    getSettings,
    saveSettings,
    getDaily,
    incrementDaily,
    getQuota,
    mergeSettings,
    normalizeWhitelist,
    isContextValid,
    isInvalidatedError,
  };
})();
