/**
 * Thin wrapper around chrome.i18n for content scripts & popup.
 * Always prefer chrome.i18n; fall back to built-in EN/ZH so UI never shows raw keys.
 */
const XUL_I18N_FALLBACKS = {
  en: {
    badgeQueued: "Queued",
    badgeActive: "Working…",
    extName: "X Unfollower Lite",
    panelWarn:
      "Simulates clicks on this page. Aggressive use may risk account limits. Stay conservative.",
    statScanned: "Scanned",
    statMatched: "Matched",
    statTodayLeft: "Today left",
    statThisRun: "This run",
    sectionFilters: "Filters (matched = unfollow queue)",
    protectMutuals: "Protect mutuals (“Follows you”)",
    skipUnknownFollowers: "Skip accounts when follower count cannot be read",
    highlightQueued: "Highlight queued accounts in the list",
    minFollowers: "Followers ≥",
    maxFollowers: "Followers ≤",
    followersRangeHint:
      "Only accounts whose follower count is between min and max enter the queue. Example: 0–500 = small accounts only. Default 0–very large = no follower-size limit.",
    panelHint: "Whitelist & daily limit: open the extension popup (toolbar icon).",
    followerDataHint:
      "Follower counts are not shown in the list UI; they are filled from X’s own page requests as you scroll. Hard-refresh the following page after updating the extension.",
    sectionLog: "Log",
    btnRescan: "Rescan",
    btnPause: "Pause",
    btnResume: "Resume",
    btnUnfollow: "Unfollow",
    btnStop: "Stop",
    contextDead: "X Unfollower Lite was updated. Refresh this page to continue.",
    contextDeadReload: "Refresh",
  },
  zh: {
    badgeQueued: "待取关",
    badgeActive: "取关中…",
    extName: "X Unfollower Lite",
    panelWarn: "通过模拟点击页面按钮工作。过于激进可能触发账号限制，请保持保守。",
    statScanned: "已扫描",
    statMatched: "待取关",
    statTodayLeft: "今日剩余",
    statThisRun: "本次已取关",
    sectionFilters: "筛选（命中的会进待取关）",
    protectMutuals: "保护互关（显示“关注了你”）",
    skipUnknownFollowers: "无法读取粉丝数时跳过该账号",
    highlightQueued: "在列表中高亮待取关账号",
    minFollowers: "粉丝数 ≥",
    maxFollowers: "粉丝数 ≤",
    followersRangeHint:
      "只取关粉丝数落在「≥ 下限 且 ≤ 上限」区间内的账号。例如 0～500 = 只清小号；默认 0～很大 = 不按粉丝数限制。",
    panelHint: "白名单与每日上限：请打开扩展弹窗（工具栏图标）。",
    followerDataHint:
      "关注列表界面本身通常不显示粉丝数；扩展会从页面加载列表时的接口数据中补齐。更新扩展后请强制刷新关注页。",
    sectionLog: "日志",
    btnRescan: "重新扫描",
    btnPause: "暂停",
    btnResume: "继续",
    btnUnfollow: "开始取关",
    btnStop: "停止",
    contextDead: "X Unfollower Lite 已更新。请刷新本页后再继续使用。",
    contextDeadReload: "刷新页面",
  },
};

function xulUiLang() {
  try {
    const lang = (chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || "";
    if (lang.toLowerCase().startsWith("zh")) return "zh";
  } catch {
    /* ignore */
  }
  return "en";
}

function xulT(key, substitutions) {
  try {
    const msg = chrome.i18n.getMessage(key, substitutions);
    // Chrome returns "" when missing; never surface the raw key in UI.
    if (msg) return msg;
  } catch {
    /* ignore */
  }
  const pack = XUL_I18N_FALLBACKS[xulUiLang()] || XUL_I18N_FALLBACKS.en;
  const fb = pack[key] || XUL_I18N_FALLBACKS.en[key];
  if (fb) return fb;
  return key;
}

function xulApplyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    const text = xulT(key);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.hasAttribute("placeholder")) el.placeholder = text;
      else el.value = text;
    } else {
      el.textContent = text;
    }
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.placeholder = xulT(key);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.title = xulT(key);
  });
}
