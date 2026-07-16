/**
 * chrome.storage.local helpers — daily counters + user settings.
 * Uses local calendar date (user timezone) for daily reset.
 */
const XULStorage = (() => {
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

  async function getSettings() {
    const data = await chrome.storage.local.get(XUL_STORAGE_KEYS.settings);
    return mergeSettings(data[XUL_STORAGE_KEYS.settings]);
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    const next = mergeSettings({ ...current, ...partial });
    // Ensure min <= max for delays
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
    await chrome.storage.local.set({ [XUL_STORAGE_KEYS.settings]: next });
    return next;
  }

  async function getDaily() {
    const data = await chrome.storage.local.get(XUL_STORAGE_KEYS.daily);
    const raw = data[XUL_STORAGE_KEYS.daily] || {};
    const today = todayKey();
    if (raw.date !== today) {
      const fresh = { date: today, count: 0 };
      await chrome.storage.local.set({ [XUL_STORAGE_KEYS.daily]: fresh });
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
    await chrome.storage.local.set({ [XUL_STORAGE_KEYS.daily]: daily });
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
  };
})();
