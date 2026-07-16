/**
 * X Unfollower Lite — content script
 * DOM sniffing + serial simulated unfollow on /following pages.
 * MVP: no GraphQL intercept, no inactive-day detection.
 */
(() => {
  "use strict";

  const ROOT_ID = "xul-root";
  const STATE = {
    panelOpen: true,
    users: new Map(), // handle -> UserRecord
    running: false,
    paused: false,
    abort: false,
    sessionDone: 0,
    consecutiveFailures: 0,
    settings: null,
    quota: null,
    observer: null,
    routeTimer: null,
    lastPath: "",
  };

  /** @typedef {{ handle: string, name: string, followers: number|null, followsYou: boolean, cell: Element|null }} UserRecord */

  // ---------------------------------------------------------------------------
  // Route helpers
  // ---------------------------------------------------------------------------

  function isFollowingPage() {
    try {
      const path = location.pathname.replace(/\/+$/, "");
      // /{user}/following  (not /i/... special routes)
      return /^\/[^/]+\/following$/i.test(path) && !path.startsWith("/i/");
    } catch {
      return false;
    }
  }

  function randomBetween(min, max) {
    const a = Math.min(min, max);
    const b = Math.max(min, max);
    return Math.floor(a + Math.random() * (b - a + 1));
  }

  function sleep(ms, shouldAbort) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (shouldAbort && shouldAbort()) {
          resolve(false);
          return;
        }
        if (Date.now() - start >= ms) {
          resolve(true);
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function normalizeHandle(h) {
    return String(h || "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // DOM parsing (prefer data-testid + visible text; avoid hashed classes)
  // ---------------------------------------------------------------------------

  function parseFollowerCount(text) {
    if (!text) return null;
    const cleaned = text.replace(/,/g, "").trim();
    // e.g. "1,234 Followers" | "12.3K Followers" | "1.2M"
    const m = cleaned.match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const unit = (m[2] || "").toUpperCase();
    if (unit === "K") n *= 1e3;
    else if (unit === "M") n *= 1e6;
    else if (unit === "B") n *= 1e9;
    return Math.round(n);
  }

  function extractFollowersFromCell(cell) {
    // Prefer profile stats links/text near the bio area
    const walkerTexts = [];
    const nodes = cell.querySelectorAll("span, a");
    for (const el of nodes) {
      const t = (el.textContent || "").trim();
      if (!t) continue;
      if (/followers?/i.test(t) || /[\d.]+\s*[KMB]/s*$/i.test(t)) {
        walkerTexts.push(t);
      }
    }
    for (const t of walkerTexts) {
      const n = parseFollowerCount(t);
      if (n !== null) return n;
    }
    // Fallback: any compact metric that looks like a count next to "Followers"
    const html = cell.textContent || "";
    const m = html.match(/([\d,.]+\s*[KMB]?)\s*Followers?/i);
    if (m) return parseFollowerCount(m[1]);
    return null;
  }

  function cellFollowsYou(cell) {
    const text = cell.textContent || "";
    // EN + common locales
    if (/follows\s*you/i.test(text)) return true;
    if (/关注了你|フォローされています|님을\s*팔로우합니다/i.test(text)) return true;
    return false;
  }

  function findFollowingButton(cell) {
    const buttons = cell.querySelectorAll('[role="button"], button');
    for (const btn of buttons) {
      const label = (
        btn.getAttribute("aria-label") ||
        btn.textContent ||
        ""
      ).trim();
      // "Following @user" or visible "Following"
      if (/^following\b/i.test(label) || /^正在关注|^フォロー中|^팔로잉/i.test(label)) {
        // Exclude "Follow" (not Following)
        if (/^follow\b/i.test(label) && !/^following\b/i.test(label)) continue;
        return btn;
      }
      const inner = (btn.textContent || "").trim();
      if (/^Following$/i.test(inner) || inner === "正在关注" || inner === "フォロー中") {
        return btn;
      }
    }
    return null;
  }

  function parseUserCell(cell) {
    // User cells typically have data-testid="UserCell"
    const links = cell.querySelectorAll('a[href^="/"]');
    let handle = null;
    let name = "";
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      // /handle or /handle/… but not /handle/status/...
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\?|$)/);
      if (!m) continue;
      const h = m[1];
      if (
        /^(home|explore|search|settings|i|messages|notifications|compose|login|signup|tos|privacy)$/i.test(
          h
        )
      ) {
        continue;
      }
      handle = normalizeHandle(h);
      // Display name often in first bold span inside the same cell
      break;
    }
    if (!handle) return null;

    const nameEl =
      cell.querySelector('[data-testid="User-Name"] span span') ||
      cell.querySelector("a span span");
    name = (nameEl && nameEl.textContent) || handle;

    return {
      handle,
      name: String(name).trim(),
      followers: extractFollowersFromCell(cell),
      followsYou: cellFollowsYou(cell),
      cell,
    };
  }

  function collectVisibleUsers() {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    let added = 0;
    cells.forEach((cell) => {
      const user = parseUserCell(cell);
      if (!user) return;
      const prev = STATE.users.get(user.handle);
      if (prev) {
        // Refresh live cell ref + fields
        prev.cell = user.cell;
        prev.followsYou = user.followsYou;
        if (user.followers !== null) prev.followers = user.followers;
        if (user.name) prev.name = user.name;
      } else {
        STATE.users.set(user.handle, user);
        added += 1;
      }
    });
    return added;
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  function getFilteredUsers() {
    const s = STATE.settings || XUL_DEFAULTS;
    const whitelist = new Set((s.whitelist || []).map(normalizeHandle));
    const out = [];
    for (const user of STATE.users.values()) {
      if (whitelist.has(user.handle)) continue;
      if (s.protectMutual && user.followsYou) continue;
      if (user.followers !== null) {
        if (user.followers < s.followersMin) continue;
        if (user.followers > s.followersMax) continue;
      }
      // If followers unknown, include only when range is "open" default-ish
      // Still include unknowns so partial DOM still works; user can tighten later.
      out.push(user);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Unfollow engine (serial, abortable)
  // ---------------------------------------------------------------------------

  function findConfirmUnfollowButton() {
    // Confirmation sheet / modal
    const candidates = document.querySelectorAll(
      '[data-testid="confirmationSheetConfirm"], [role="button"], button'
    );
    for (const btn of candidates) {
      const testId = btn.getAttribute("data-testid") || "";
      if (testId === "confirmationSheetConfirm") return btn;
      const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
      if (/^unfollow$/i.test(label) || label === "取消关注" || label === "フォロー解除") {
        // Prefer red/destructive in modal — avoid toolbar items
        if (btn.closest('[data-testid="confirmationSheetDialog"], [role="dialog"], [data-testid="sheetDialog"]')) {
          return btn;
        }
      }
    }
    // Broader: last visible Unfollow button in a dialog
    const dialogs = document.querySelectorAll('[role="dialog"], [data-testid="confirmationSheetDialog"]');
    for (const d of dialogs) {
      const btns = d.querySelectorAll('[role="button"], button');
      for (const btn of btns) {
        const t = (btn.textContent || "").trim();
        if (/^Unfollow$/i.test(t) || t === "取消关注" || t === "フォロー解除") return btn;
      }
    }
    return null;
  }

  async function waitForConfirmButton(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (STATE.abort) return null;
      const btn = findConfirmUnfollowButton();
      if (btn) return btn;
      await sleep(150, () => STATE.abort);
    }
    return null;
  }

  function dismissStrayDialogs() {
    const cancel = document.querySelector(
      '[data-testid="confirmationSheetCancel"], [data-testid="app-bar-close"]'
    );
    if (cancel) {
      try {
        cancel.click();
      } catch {
        /* ignore */
      }
    }
  }

  async function unfollowOne(user, settings) {
    // Re-find cell if stale
    if (!user.cell || !document.contains(user.cell)) {
      collectVisibleUsers();
      const refreshed = STATE.users.get(user.handle);
      if (refreshed) user.cell = refreshed.cell;
    }
    if (!user.cell || !document.contains(user.cell)) {
      // Scroll into view by searching again after a short wait
      user.cell?.scrollIntoView?.({ block: "center" });
      collectVisibleUsers();
      const refreshed = STATE.users.get(user.handle);
      if (refreshed?.cell) user.cell = refreshed.cell;
    }

    if (!user.cell || !document.contains(user.cell)) {
      throw new Error(`User cell not in DOM for @${user.handle} — scroll the list and retry`);
    }

    user.cell.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(400, () => STATE.abort);

    const followBtn = findFollowingButton(user.cell);
    if (!followBtn) {
      throw new Error(`Following button not found for @${user.handle}`);
    }

    followBtn.click();
    const confirm = await waitForConfirmButton(settings.confirmTimeoutMs);
    if (!confirm) {
      dismissStrayDialogs();
      throw new Error(`Confirm dialog timeout for @${user.handle}`);
    }

    confirm.click();
    await sleep(500, () => STATE.abort);
    return true;
  }

  async function runQueue(targets) {
    STATE.running = true;
    STATE.paused = false;
    STATE.abort = false;
    STATE.sessionDone = 0;
    STATE.consecutiveFailures = 0;
    updateUI();
    log(`Starting queue: ${targets.length} account(s)`, "info");

    const settings = STATE.settings;
    let index = 0;

    while (index < targets.length) {
      if (STATE.abort) {
        log("Stopped by user", "info");
        break;
      }

      while (STATE.paused && !STATE.abort) {
        await sleep(200, () => STATE.abort);
      }
      if (STATE.abort) break;

      // Tab visibility
      if (document.hidden) {
        log("Tab hidden — paused until visible", "info");
        await new Promise((resolve) => {
          const onVis = () => {
            if (!document.hidden) {
              document.removeEventListener("visibilitychange", onVis);
              resolve();
            }
          };
          document.addEventListener("visibilitychange", onVis);
        });
        if (STATE.abort) break;
      }

      // Refresh quota before each action
      STATE.quota = await XULStorage.getQuota();
      STATE.settings = STATE.quota.settings;
      if (STATE.quota.remaining <= 0) {
        log(`Daily limit reached (${STATE.quota.limit}). Stopped.`, "err");
        alert(
          `X Unfollower Lite: daily limit reached (${STATE.quota.limit}). Try again tomorrow or raise the limit in the extension popup (use carefully).`
        );
        break;
      }

      const user = targets[index];
      log(`Unfollowing @${user.handle}…`, "info");

      try {
        await unfollowOne(user, STATE.settings);
        await XULStorage.incrementDaily(1);
        STATE.sessionDone += 1;
        STATE.consecutiveFailures = 0;
        STATE.users.delete(user.handle);
        STATE.quota = await XULStorage.getQuota();
        log(`Unfollowed @${user.handle}`, "ok");
      } catch (err) {
        STATE.consecutiveFailures += 1;
        log(String(err.message || err), "err");
        if (STATE.consecutiveFailures >= STATE.settings.maxConsecutiveFailures) {
          log("Too many consecutive failures — stopping for safety", "err");
          break;
        }
      }

      updateUI();
      index += 1;
      if (index >= targets.length || STATE.abort) break;

      // Random delay + periodic long pause
      let delay = randomBetween(STATE.settings.delayMinMs, STATE.settings.delayMaxMs);
      if (
        STATE.settings.longPauseEvery > 0 &&
        STATE.sessionDone > 0 &&
        STATE.sessionDone % STATE.settings.longPauseEvery === 0
      ) {
        delay += randomBetween(STATE.settings.longPauseMinMs, STATE.settings.longPauseMaxMs);
        log(`Humanization pause ~${Math.round(delay / 1000)}s`, "info");
      } else {
        log(`Cooldown ${Math.round(delay / 1000)}s`, "info");
      }
      const ok = await sleep(delay, () => STATE.abort || STATE.paused);
      // If paused mid-delay, hold
      while (STATE.paused && !STATE.abort) {
        await sleep(200, () => STATE.abort);
      }
      if (!ok && STATE.abort) break;
    }

    STATE.running = false;
    STATE.paused = false;
    updateUI();
    log("Queue finished", "info");
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function ensureUI() {
    if (document.getElementById(ROOT_ID)) return;

    const root = document.createElement("div");
    root.id = ROOT_ID;

    const toggle = document.createElement("button");
    toggle.id = "xul-toggle";
    toggle.type = "button";
    toggle.title = "X Unfollower Lite";
    toggle.textContent = "XU";
    toggle.addEventListener("click", () => {
      STATE.panelOpen = !STATE.panelOpen;
      const panel = document.getElementById("xul-panel");
      if (panel) panel.hidden = !STATE.panelOpen;
    });

    const panel = document.createElement("div");
    panel.id = "xul-panel";
    panel.hidden = !STATE.panelOpen;
    panel.innerHTML = `
      <div class="xul-header">
        <h1 class="xul-title">X Unfollower Lite</h1>
        <button type="button" class="xul-close" aria-label="Close" data-xul="close">×</button>
      </div>
      <div class="xul-body">
        <p class="xul-warn">Simulates clicks on this page. Aggressive use may risk account limits. Stay conservative.</p>
        <div class="xul-stats">
          <div class="xul-stat"><div class="n" data-xul="scanned">0</div><div class="k">Scanned</div></div>
          <div class="xul-stat"><div class="n" data-xul="matched">0</div><div class="k">Matched</div></div>
          <div class="xul-stat"><div class="n" data-xul="remaining">0</div><div class="k">Today left</div></div>
          <div class="xul-stat"><div class="n" data-xul="session">0</div><div class="k">This run</div></div>
        </div>
        <div class="xul-section">
          <p class="xul-section-title">Filters</p>
          <label class="xul-check"><input type="checkbox" data-xul="protectMutual" /> Protect mutuals (Follows you)</label>
          <div class="xul-range-grid" style="margin-top:10px">
            <div class="xul-field">
              <label>Min followers</label>
              <input type="number" min="0" data-xul="followersMin" />
            </div>
            <div class="xul-field">
              <label>Max followers</label>
              <input type="number" min="0" data-xul="followersMax" />
            </div>
          </div>
          <p class="xul-hint">Whitelist & daily limit: open the extension popup (toolbar icon).</p>
        </div>
        <div class="xul-section">
          <p class="xul-section-title">Log</p>
          <div class="xul-log" data-xul="log"></div>
        </div>
      </div>
      <div class="xul-actions">
        <button type="button" class="xul-btn xul-btn-secondary" data-xul="scan">Rescan</button>
        <button type="button" class="xul-btn xul-btn-secondary" data-xul="pause" disabled>Pause</button>
        <button type="button" class="xul-btn xul-btn-primary" data-xul="start">Unfollow</button>
      </div>
    `;

    root.appendChild(panel);
    document.documentElement.appendChild(root);
    document.documentElement.appendChild(toggle);

    panel.querySelector('[data-xul="close"]').addEventListener("click", () => {
      STATE.panelOpen = false;
      panel.hidden = true;
    });

    panel.querySelector('[data-xul="scan"]').addEventListener("click", async () => {
      collectVisibleUsers();
      await refreshSettings();
      updateUI();
      log(`Rescan complete — ${STATE.users.size} loaded`, "info");
    });

    panel.querySelector('[data-xul="pause"]').addEventListener("click", () => {
      if (!STATE.running) return;
      STATE.paused = !STATE.paused;
      log(STATE.paused ? "Paused" : "Resumed", "info");
      updateUI();
    });

    panel.querySelector('[data-xul="start"]').addEventListener("click", async () => {
      if (STATE.running) {
        STATE.abort = true;
        STATE.paused = false;
        log("Stopping…", "info");
        updateUI();
        return;
      }

      await refreshSettings();
      collectVisibleUsers();
      const matched = getFilteredUsers();
      if (matched.length === 0) {
        log("No accounts match filters. Scroll to load more, then Rescan.", "err");
        updateUI();
        return;
      }

      STATE.quota = await XULStorage.getQuota();
      const cap = Math.min(matched.length, STATE.quota.remaining);
      if (cap <= 0) {
        log("No remaining daily quota.", "err");
        updateUI();
        return;
      }

      const targets = matched.slice(0, cap);
      const ok = confirm(
        `Unfollow ${targets.length} account(s)?\n\n` +
          `Daily remaining: ${STATE.quota.remaining}/${STATE.quota.limit}\n` +
          `Delay: ${STATE.settings.delayMinMs / 1000}–${STATE.settings.delayMaxMs / 1000}s\n\n` +
          `Only continue if you understand rate-limit risks.`
      );
      if (!ok) return;
      runQueue(targets);
    });

    const protect = panel.querySelector('[data-xul="protectMutual"]');
    const minF = panel.querySelector('[data-xul="followersMin"]');
    const maxF = panel.querySelector('[data-xul="followersMax"]');

    const persistFilters = async () => {
      STATE.settings = await XULStorage.saveSettings({
        protectMutual: protect.checked,
        followersMin: Number(minF.value) || 0,
        followersMax: Number(maxF.value) || XUL_DEFAULTS.followersMax,
      });
      updateUI();
    };

    protect.addEventListener("change", persistFilters);
    minF.addEventListener("change", persistFilters);
    maxF.addEventListener("change", persistFilters);
  }

  function log(msg, level = "info") {
    const el = document.querySelector("#xul-panel [data-xul='log']");
    if (!el) return;
    const line = document.createElement("div");
    line.className = level;
    const t = new Date().toLocaleTimeString();
    line.textContent = `[${t}] ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 80) el.removeChild(el.firstChild);
  }

  function updateUI() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    const onPage = isFollowingPage();
    root.classList.toggle("xul-hidden-route", !onPage);

    const panel = document.getElementById("xul-panel");
    if (!panel || !onPage) return;

    const matched = getFilteredUsers();
    const setText = (key, val) => {
      const n = panel.querySelector(`[data-xul="${key}"]`);
      if (n) n.textContent = String(val);
    };

    setText("scanned", STATE.users.size);
    setText("matched", matched.length);
    setText("remaining", STATE.quota ? STATE.quota.remaining : "–");
    setText("session", STATE.sessionDone);

    const protect = panel.querySelector('[data-xul="protectMutual"]');
    const minF = panel.querySelector('[data-xul="followersMin"]');
    const maxF = panel.querySelector('[data-xul="followersMax"]');
    if (STATE.settings && protect && document.activeElement !== protect) {
      protect.checked = !!STATE.settings.protectMutual;
    }
    if (STATE.settings && minF && document.activeElement !== minF) {
      minF.value = String(STATE.settings.followersMin);
    }
    if (STATE.settings && maxF && document.activeElement !== maxF) {
      maxF.value = String(STATE.settings.followersMax);
    }

    const startBtn = panel.querySelector('[data-xul="start"]');
    const pauseBtn = panel.querySelector('[data-xul="pause"]');
    if (startBtn) {
      startBtn.textContent = STATE.running ? "Stop" : "Unfollow";
      startBtn.disabled = false;
    }
    if (pauseBtn) {
      pauseBtn.disabled = !STATE.running;
      pauseBtn.textContent = STATE.paused ? "Resume" : "Pause";
    }
  }

  async function refreshSettings() {
    STATE.quota = await XULStorage.getQuota();
    STATE.settings = STATE.quota.settings;
  }

  // ---------------------------------------------------------------------------
  // Observers & boot
  // ---------------------------------------------------------------------------

  function startObserver() {
    if (STATE.observer) STATE.observer.disconnect();
    STATE.observer = new MutationObserver(() => {
      if (!isFollowingPage()) return;
      // Throttle lightly
      if (STATE._scanScheduled) return;
      STATE._scanScheduled = true;
      requestAnimationFrame(() => {
        STATE._scanScheduled = false;
        collectVisibleUsers();
        updateUI();
      });
    });
    STATE.observer.observe(document.body, { childList: true, subtree: true });
  }

  function watchRoute() {
    const check = async () => {
      const path = location.pathname;
      if (path !== STATE.lastPath) {
        STATE.lastPath = path;
        if (isFollowingPage()) {
          ensureUI();
          await refreshSettings();
          collectVisibleUsers();
          startObserver();
          updateUI();
          log("Following page detected", "info");
        } else {
          if (STATE.running) {
            STATE.abort = true;
            log("Left following page — queue aborted", "info");
          }
          updateUI();
        }
      }
    };
    setInterval(check, 800);
    // History hooks
    const wrap = (type) => {
      const orig = history[type];
      history[type] = function (...args) {
        const ret = orig.apply(this, args);
        window.dispatchEvent(new Event("xul:nav"));
        return ret;
      };
    };
    try {
      wrap("pushState");
      wrap("replaceState");
    } catch {
      /* ignore */
    }
    window.addEventListener("popstate", () => window.dispatchEvent(new Event("xul:nav")));
    window.addEventListener("xul:nav", check);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[XUL_STORAGE_KEYS.settings] || changes[XUL_STORAGE_KEYS.daily]) {
      refreshSettings().then(updateUI);
    }
  });

  async function boot() {
    ensureUI();
    await refreshSettings();
    watchRoute();
    if (isFollowingPage()) {
      collectVisibleUsers();
      startObserver();
      updateUI();
    } else {
      updateUI();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
