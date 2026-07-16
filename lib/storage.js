/**
 * chrome.storage.local helpers — daily counters + user settings.
 * Uses local calendar date (user timezone) for daily reset.
 *
 * After the extension is reloaded/updated, old content scripts lose their
 * extension context. All storage APIs must fail soft instead of throwing
 * uncaught "Extension context invalidated" errors.
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

  async function storageGet(keys) {
    if (!isContextValid()) {
      const err = new Error("Extension context invalidated");
      err.xulInvalidated = true;
      throw err;
    }
    try {
      return await chrome.storage.local.get(keys);
    } catch (err) {
      if (isInvalidatedError(err)) {
        err.xulInvalidated = true;
      }
      throw err;
    }
  }

  async function storageSet(obj) {
    if (!isContextValid()) {
      const err = new Error("Extension context invalidated");
      err.xulInvalidated = true;
      throw err;
    }
    try {
      await chrome.storage.local.set(obj);
    } catch (err) {
      if (isInvalidatedError(err)) {
        err.xulInvalidated = true;
      }
      throw err;
    }
  }

  async function getSettings() {
    try {
      const data = await storageGet(XUL_STORAGE_KEYS.settings);
      return mergeSettings(data[XUL_STORAGE_KEYS.settings]);
    } catch (err) {
      if (err && (err.xulInvalidated || isInvalidatedError(err))) {
        return mergeSettings(null);
      }
      throw err;
    }
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    if (!isContextValid()) {
      const err = new Error("Extension context invalidated");
      err.xulInvalidated = true;
      throw err;
    }
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
    return next;
  }

  async function getDaily() {
    try {
      const data = await storageGet(XUL_STORAGE_KEYS.daily);
      const raw = data[XUL_STORAGE_KEYS.daily] || {};
      const today = todayKey();
      if (raw.date !== today) {
        const fresh = { date: today, count: 0 };
        try {
          await storageSet({ [XUL_STORAGE_KEYS.daily]: fresh });
        } catch (err) {
          if (err && (err.xulInvalidated || isInvalidatedError(err))) {
            return fresh;
          }
          throw err;
        }
        return fresh;
      }
      return {
        date: today,
        count: clampInt(raw.count, 0, 1e6, 0),
      };
    } catch (err) {
      if (err && (err.xulInvalidated || isInvalidatedError(err))) {
        return { date: todayKey(), count: 0 };
      }
      throw err;
    }
  }

  async function incrementDaily(by = 1) {
    const daily = await getDaily();
    if (!isContextValid()) {
      const err = new Error("Extension context invalidated");
      err.xulInvalidated = true;
      throw err;
    }
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
