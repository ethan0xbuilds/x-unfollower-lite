/**
 * X Unfollower Lite — content script
 * DOM sniffing + serial simulated unfollow on /following pages.
 * Follower counts come mainly from page GraphQL (see inject.js) because
 * UserCell DOM on /following usually does NOT render follower numbers.
 */
(() => {
  "use strict";

  const ROOT_ID = "xul-root";
  const STATE = {
    panelOpen: true,
    users: new Map(),
    /** @type {Map<string, number>} handle -> followers_count from network */
    followerCache: new Map(),
    /** @type {Map<string, boolean>} handle -> followed_by from network */
    followedByCache: new Map(),
    networkHits: 0,
    activeHandle: null,
    running: false,
    paused: false,
    abort: false,
    sessionDone: 0,
    consecutiveFailures: 0,
    settings: null,
    quota: null,
    observer: null,
    lastPath: "",
    _scanScheduled: false,
  };

  function t(key, subs) {
    return xulT(key, subs);
  }

  // ---------------------------------------------------------------------------
  // Route helpers
  // ---------------------------------------------------------------------------

  function isFollowingPage() {
    try {
      const path = location.pathname.replace(/\/+$/, "");
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
  // DOM parsing
  // ---------------------------------------------------------------------------

  function parseFollowerCount(text) {
    if (!text) return null;
    const cleaned = text.replace(/,/g, "").replace(/\s/g, " ").trim();
    // 万 / 亿 (Chinese compact)
    const cn = cleaned.match(/([\d.]+)\s*([万亿])/);
    if (cn) {
      let n = parseFloat(cn[1]);
      if (!Number.isFinite(n)) return null;
      if (cn[2] === "万") n *= 1e4;
      if (cn[2] === "亿") n *= 1e8;
      return Math.round(n);
    }
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
    const nodes = cell.querySelectorAll("span, a");
    for (const el of nodes) {
      const t = (el.textContent || "").trim();
      if (!t) continue;
      if (/followers?|粉丝|フォロワー|팔로워/i.test(t)) {
        const n = parseFollowerCount(t);
        if (n !== null) return n;
      }
    }
    const html = cell.textContent || "";
    const m = html.match(
      /([\d,.]+\s*[KMB万亿]?)\s*(Followers?|粉丝|フォロワー|팔로워)/i
    );
    if (m) return parseFollowerCount(m[1]);
    return null;
  }

  function cellFollowsYou(cell) {
    const text = cell.textContent || "";
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
      if (/^following\b/i.test(label) || /^正在关注|^フォロー中|^팔로잉/i.test(label)) {
        if (/^follow\b/i.test(label) && !/^following\b/i.test(label)) continue;
        return btn;
      }
      const inner = (btn.textContent || "").trim();
      if (
        /^Following$/i.test(inner) ||
        inner === "正在关注" ||
        inner === "フォロー中" ||
        inner === "팔로잉"
      ) {
        return btn;
      }
    }
    return null;
  }

  /**
   * "Who to follow" / 推荐关注 uses the same UserCell test id.
   * Only treat a cell as unfollow-eligible when:
   * 1) it lives in the primary column (not right rail / aside), and
   * 2) it has a real "Following" button (not plain "Follow").
   */
  function getPrimaryColumn() {
    return document.querySelector('[data-testid="primaryColumn"]');
  }

  function isInSuggestedBlock(cell) {
    // Walk up a bit for section headings near the cell
    let el = cell;
    for (let i = 0; i < 8 && el; i++) {
      const text = (el.innerText || el.textContent || "").slice(0, 400);
      if (
        /who to follow|you might like|recommended|推荐关注|值得关注|おすすめユーザー|팔로우 추천/i.test(
          text
        )
      ) {
        // Heading-only match is weak if the whole column contains it; require
        // that this subtree looks like a suggestion module (has Follow, no Following).
        if (!findFollowingButton(cell)) return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function isEligibleFollowingCell(cell) {
    if (!cell || !cell.isConnected) return false;

    // Right rail / aside recommendations
    if (cell.closest('aside, [role="complementary"], [data-testid="sidebarColumn"]')) {
      return false;
    }

    const primary = getPrimaryColumn();
    if (primary && !primary.contains(cell)) return false;

    // Must already be following — sidebar suggestions only have "Follow"
    if (!findFollowingButton(cell)) return false;

    if (isInSuggestedBlock(cell)) return false;

    return true;
  }

  function applyNetworkHints(user) {
    if (STATE.followerCache.has(user.handle)) {
      user.followers = STATE.followerCache.get(user.handle);
    }
    if (STATE.followedByCache.has(user.handle)) {
      // Prefer network mutual flag when present; keep DOM true if already true
      user.followsYou = user.followsYou || !!STATE.followedByCache.get(user.handle);
    }
    return user;
  }

  function parseUserCell(cell) {
    const links = cell.querySelectorAll('a[href^="/"]');
    let handle = null;
    let name = "";
    for (const a of links) {
      const href = a.getAttribute("href") || "";
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
      break;
    }
    if (!handle) return null;

    const nameEl =
      cell.querySelector('[data-testid="User-Name"] span span') ||
      cell.querySelector("a span span");
    name = (nameEl && nameEl.textContent) || handle;

    // DOM rarely has followers on /following; network cache is primary source.
    let followers = extractFollowersFromCell(cell);
    if (followers == null && STATE.followerCache.has(handle)) {
      followers = STATE.followerCache.get(handle);
    }

    const user = {
      handle,
      name: String(name).trim(),
      followers,
      followsYou: cellFollowsYou(cell),
      cell,
    };
    return applyNetworkHints(user);
  }

  function stripCellHighlight(cell) {
    if (!cell) return;
    cell.classList.remove("xul-highlight-match", "xul-highlight-active");
    cell.removeAttribute("data-xul-badge");
  }

  function collectVisibleUsers() {
    const root = getPrimaryColumn() || document;
    const cells = root.querySelectorAll('[data-testid="UserCell"]');
    let added = 0;
    const seenEligible = new Set();

    cells.forEach((cell) => {
      if (!isEligibleFollowingCell(cell)) {
        // Never leave a highlight on sidebar / suggestion cards
        stripCellHighlight(cell);
        return;
      }
      const user = parseUserCell(cell);
      if (!user) return;
      seenEligible.add(user.handle);
      const prev = STATE.users.get(user.handle);
      if (prev) {
        prev.cell = user.cell;
        prev.followsYou = user.followsYou || prev.followsYou;
        if (user.followers !== null && user.followers !== undefined) {
          prev.followers = user.followers;
        } else if (STATE.followerCache.has(user.handle)) {
          prev.followers = STATE.followerCache.get(user.handle);
        }
        if (user.name) prev.name = user.name;
      } else {
        STATE.users.set(user.handle, user);
        added += 1;
      }
    });

    // Drop wrongly ingested suggestion accounts (cell is sidebar / Follow-only)
    for (const [handle, user] of [...STATE.users.entries()]) {
      if (user.cell && document.contains(user.cell) && !isEligibleFollowingCell(user.cell)) {
        stripCellHighlight(user.cell);
        STATE.users.delete(handle);
        continue;
      }
      // Keep scrolled-away following accounts (cell may be virtualized away),
      // but drop entries that never had an eligible cell.
      if (!seenEligible.has(handle) && user.cell && !document.contains(user.cell)) {
        // ok — virtualized; keep metrics for filters until rescan
        continue;
      }
    }

    // Also scrub any stray highlights outside the primary list
    document.querySelectorAll('[data-testid="UserCell"].xul-highlight-match').forEach((cell) => {
      if (!isEligibleFollowingCell(cell)) stripCellHighlight(cell);
    });

    return added;
  }

  function countWithFollowers() {
    let n = 0;
    for (const u of STATE.users.values()) {
      if (u.followers != null) n += 1;
    }
    return n;
  }

  function mergeNetworkUsers(list) {
    if (!Array.isArray(list) || !list.length) return 0;
    let updated = 0;
    for (const raw of list) {
      const handle = normalizeHandle(raw && raw.handle);
      if (!handle) continue;
      if (typeof raw.followers === "number" && Number.isFinite(raw.followers)) {
        const prev = STATE.followerCache.get(handle);
        if (prev !== raw.followers) {
          STATE.followerCache.set(handle, raw.followers);
          updated += 1;
        } else if (!STATE.followerCache.has(handle)) {
          STATE.followerCache.set(handle, raw.followers);
          updated += 1;
        }
      }
      if (typeof raw.followedBy === "boolean") {
        STATE.followedByCache.set(handle, raw.followedBy);
      }
      const existing = STATE.users.get(handle);
      if (existing) {
        if (STATE.followerCache.has(handle)) {
          existing.followers = STATE.followerCache.get(handle);
        }
        if (STATE.followedByCache.has(handle)) {
          existing.followsYou =
            existing.followsYou || !!STATE.followedByCache.get(handle);
        }
        if (raw.name && !existing.name) existing.name = String(raw.name);
      }
    }
    if (updated) STATE.networkHits += updated;
    return updated;
  }

  function onNetworkMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "xul-net" || data.type !== "users") return;
    const n = mergeNetworkUsers(data.users);
    if (n > 0) {
      collectVisibleUsers();
      updateUI();
    }
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
      if (user.followers === null) {
        if (s.skipUnknownFollowers) continue;
      } else {
        if (user.followers < s.followersMin) continue;
        if (user.followers > s.followersMax) continue;
      }
      out.push(user);
    }
    return out;
  }

  /**
   * Highlight UserCells that match the current unfollow filters.
   * Follower min/max = only accounts IN that range are queued (and highlighted).
   */
  function clearHighlights() {
    document
      .querySelectorAll(
        '[data-testid="UserCell"].xul-highlight-match, [data-testid="UserCell"].xul-highlight-active'
      )
      .forEach((el) => {
        el.classList.remove("xul-highlight-match", "xul-highlight-active");
        el.removeAttribute("data-xul-badge");
      });
  }

  function applyHighlights(activeHandle) {
    clearHighlights();
    if (!isFollowingPage()) return;

    const s = STATE.settings || XUL_DEFAULTS;
    if (!s.highlightQueued) return;

    const matched = new Set(getFilteredUsers().map((u) => u.handle));
    const badge = t("badgeQueued");

    for (const user of STATE.users.values()) {
      if (!user.cell || !document.contains(user.cell)) continue;
      if (!isEligibleFollowingCell(user.cell)) continue;
      if (!matched.has(user.handle)) continue;
      user.cell.classList.add("xul-highlight-match");
      user.cell.setAttribute("data-xul-badge", badge);
      if (activeHandle && user.handle === activeHandle) {
        user.cell.classList.add("xul-highlight-active");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Unfollow engine
  // ---------------------------------------------------------------------------

  function findConfirmUnfollowButton() {
    const byTestId = document.querySelector(
      '[data-testid="confirmationSheetConfirm"]'
    );
    if (byTestId) return byTestId;

    const dialogs = document.querySelectorAll(
      '[role="dialog"], [data-testid="confirmationSheetDialog"], [data-testid="sheetDialog"]'
    );
    for (const d of dialogs) {
      const btns = d.querySelectorAll('[role="button"], button');
      for (const btn of btns) {
        const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
        if (
          /^unfollow$/i.test(label) ||
          label === "取消关注" ||
          label === "フォロー解除" ||
          label === "언팔로우"
        ) {
          return btn;
        }
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
    if (!user.cell || !document.contains(user.cell)) {
      collectVisibleUsers();
      const refreshed = STATE.users.get(user.handle);
      if (refreshed) user.cell = refreshed.cell;
    }

    if (!user.cell || !document.contains(user.cell)) {
      throw new Error(t("errNoCell", [user.handle]));
    }

    user.cell.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(400, () => STATE.abort);

    const followBtn = findFollowingButton(user.cell);
    if (!followBtn) {
      throw new Error(t("errNoButton", [user.handle]));
    }

    followBtn.click();
    const confirmBtn = await waitForConfirmButton(settings.confirmTimeoutMs);
    if (!confirmBtn) {
      dismissStrayDialogs();
      throw new Error(t("errConfirmTimeout", [user.handle]));
    }

    confirmBtn.click();
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
    log(t("logStartQueue", [String(targets.length)]), "info");

    let index = 0;

    while (index < targets.length) {
      if (STATE.abort) {
        log(t("logStopped"), "info");
        break;
      }

      while (STATE.paused && !STATE.abort) {
        await sleep(200, () => STATE.abort);
      }
      if (STATE.abort) break;

      if (document.hidden) {
        log(t("logTabHidden"), "info");
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

      STATE.quota = await XULStorage.getQuota();
      STATE.settings = STATE.quota.settings;

      if (STATE.quota.remaining <= 0) {
        log(t("logDailyLimit", [String(STATE.quota.limit)]), "err");
        alert(t("alertDailyLimit", [String(STATE.quota.limit)]));
        break;
      }

      if (STATE.sessionDone >= STATE.settings.sessionLimit) {
        log(t("logSessionLimit", [String(STATE.settings.sessionLimit)]), "err");
        break;
      }

      const user = targets[index];
      STATE.activeHandle = user.handle;
      applyHighlights(user.handle);
      log(t("logUnfollowing", [user.handle]), "info");

      try {
        await unfollowOne(user, STATE.settings);
        await XULStorage.incrementDaily(1);
        STATE.sessionDone += 1;
        STATE.consecutiveFailures = 0;
        if (user.cell) {
          user.cell.classList.remove("xul-highlight-match", "xul-highlight-active");
          user.cell.removeAttribute("data-xul-badge");
        }
        STATE.users.delete(user.handle);
        STATE.quota = await XULStorage.getQuota();
        log(t("logUnfollowed", [user.handle]), "ok");
      } catch (err) {
        STATE.consecutiveFailures += 1;
        log(String(err.message || err), "err");
        if (STATE.consecutiveFailures >= STATE.settings.maxConsecutiveFailures) {
          log(t("logFailures"), "err");
          break;
        }
      }

      STATE.activeHandle = null;
      updateUI();
      index += 1;
      if (index >= targets.length || STATE.abort) break;
      if (STATE.sessionDone >= STATE.settings.sessionLimit) {
        log(t("logSessionLimit", [String(STATE.settings.sessionLimit)]), "info");
        break;
      }

      let delay = randomBetween(STATE.settings.delayMinMs, STATE.settings.delayMaxMs);
      if (
        STATE.settings.longPauseEvery > 0 &&
        STATE.sessionDone > 0 &&
        STATE.sessionDone % STATE.settings.longPauseEvery === 0
      ) {
        delay += randomBetween(
          STATE.settings.longPauseMinMs,
          STATE.settings.longPauseMaxMs
        );
        log(t("logLongPause", [String(Math.round(delay / 1000))]), "info");
      } else {
        log(t("logCooldownN", [String(Math.round(delay / 1000))]), "info");
      }

      const ok = await sleep(delay, () => STATE.abort || STATE.paused);
      while (STATE.paused && !STATE.abort) {
        await sleep(200, () => STATE.abort);
      }
      if (!ok && STATE.abort) break;
    }

    STATE.running = false;
    STATE.paused = false;
    STATE.activeHandle = null;
    updateUI();
    log(t("logFinished"), "info");
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
    toggle.title = t("extName");
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
        <h1 class="xul-title">${t("extName")}</h1>
        <button type="button" class="xul-close" aria-label="Close" data-xul="close">×</button>
      </div>
      <div class="xul-body">
        <p class="xul-warn">${t("panelWarn")}</p>
        <div class="xul-stats">
          <div class="xul-stat"><div class="n" data-xul="scanned">0</div><div class="k">${t("statScanned")}</div></div>
          <div class="xul-stat"><div class="n" data-xul="matched">0</div><div class="k">${t("statMatched")}</div></div>
          <div class="xul-stat"><div class="n" data-xul="remaining">0</div><div class="k">${t("statTodayLeft")}</div></div>
          <div class="xul-stat"><div class="n" data-xul="session">0</div><div class="k">${t("statThisRun")}</div></div>
        </div>
        <p class="xul-hint" data-xul="followerCoverage" style="margin-top:-4px"></p>
        <div class="xul-section">
          <p class="xul-section-title">${t("sectionFilters")}</p>
          <label class="xul-check"><input type="checkbox" data-xul="protectMutual" /> ${t("protectMutuals")}</label>
          <label class="xul-check" style="margin-top:8px"><input type="checkbox" data-xul="skipUnknown" /> ${t("skipUnknownFollowers")}</label>
          <label class="xul-check" style="margin-top:8px"><input type="checkbox" data-xul="highlightQueued" /> ${t("highlightQueued")}</label>
          <div class="xul-range-grid" style="margin-top:10px">
            <div class="xul-field">
              <label>${t("minFollowers")}</label>
              <input type="number" min="0" data-xul="followersMin" />
            </div>
            <div class="xul-field">
              <label>${t("maxFollowers")}</label>
              <input type="number" min="0" data-xul="followersMax" />
            </div>
          </div>
          <p class="xul-hint">${t("followersRangeHint")}</p>
          <p class="xul-hint">${t("panelHint")}</p>
          <p class="xul-hint">${t("followerDataHint")}</p>
        </div>
        <div class="xul-section">
          <p class="xul-section-title">${t("sectionLog")}</p>
          <div class="xul-log" data-xul="log"></div>
        </div>
      </div>
      <div class="xul-actions">
        <button type="button" class="xul-btn xul-btn-secondary" data-xul="scan">${t("btnRescan")}</button>
        <button type="button" class="xul-btn xul-btn-secondary" data-xul="pause" disabled>${t("btnPause")}</button>
        <button type="button" class="xul-btn xul-btn-primary" data-xul="start">${t("btnUnfollow")}</button>
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
      log(t("logRescan", [String(STATE.users.size)]), "info");
    });

    panel.querySelector('[data-xul="pause"]').addEventListener("click", () => {
      if (!STATE.running) return;
      STATE.paused = !STATE.paused;
      log(STATE.paused ? t("logPaused") : t("logResumed"), "info");
      updateUI();
    });

    panel.querySelector('[data-xul="start"]').addEventListener("click", async () => {
      if (STATE.running) {
        STATE.abort = true;
        STATE.paused = false;
        log(t("logStopping"), "info");
        updateUI();
        return;
      }

      await refreshSettings();
      collectVisibleUsers();
      const matched = getFilteredUsers();
      if (matched.length === 0) {
        const withF = countWithFollowers();
        if (
          STATE.settings?.skipUnknownFollowers &&
          STATE.users.size > 0 &&
          withF === 0
        ) {
          log(t("logNoFollowerData"), "err");
        } else {
          log(t("logNoMatch"), "err");
        }
        updateUI();
        return;
      }

      STATE.quota = await XULStorage.getQuota();
      const sessionCap = STATE.settings.sessionLimit || XUL_DEFAULTS.sessionLimit;
      const cap = Math.min(matched.length, STATE.quota.remaining, sessionCap);
      if (cap <= 0) {
        log(t("logNoQuota"), "err");
        updateUI();
        return;
      }

      const targets = matched.slice(0, cap);
      const ok = confirm(
        t("confirmRun", [
          String(targets.length),
          String(STATE.quota.remaining),
          String(STATE.quota.limit),
          String(sessionCap),
          String(STATE.settings.delayMinMs / 1000),
          String(STATE.settings.delayMaxMs / 1000),
        ])
      );
      if (!ok) return;
      runQueue(targets);
    });

    const protect = panel.querySelector('[data-xul="protectMutual"]');
    const skipUnknown = panel.querySelector('[data-xul="skipUnknown"]');
    const highlightQueued = panel.querySelector('[data-xul="highlightQueued"]');
    const minF = panel.querySelector('[data-xul="followersMin"]');
    const maxF = panel.querySelector('[data-xul="followersMax"]');

    const persistFilters = async () => {
      STATE.settings = await XULStorage.saveSettings({
        protectMutual: protect.checked,
        skipUnknownFollowers: skipUnknown.checked,
        highlightQueued: highlightQueued.checked,
        followersMin: Number(minF.value) || 0,
        followersMax: Number(maxF.value) || XUL_DEFAULTS.followersMax,
      });
      updateUI();
    };

    protect.addEventListener("change", persistFilters);
    skipUnknown.addEventListener("change", persistFilters);
    highlightQueued.addEventListener("change", persistFilters);
    minF.addEventListener("change", persistFilters);
    maxF.addEventListener("change", persistFilters);
  }

  function log(msg, level = "info") {
    const el = document.querySelector("#xul-panel [data-xul='log']");
    if (!el) return;
    const line = document.createElement("div");
    line.className = level;
    const time = new Date().toLocaleTimeString();
    line.textContent = `[${time}] ${msg}`;
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

    const cov = panel.querySelector('[data-xul="followerCoverage"]');
    if (cov) {
      const withF = countWithFollowers();
      const total = STATE.users.size;
      cov.textContent = t("followerCoverage", [
        String(withF),
        String(total),
        String(STATE.followerCache.size),
      ]);
    }

    const protect = panel.querySelector('[data-xul="protectMutual"]');
    const skipUnknown = panel.querySelector('[data-xul="skipUnknown"]');
    const highlightQueued = panel.querySelector('[data-xul="highlightQueued"]');
    const minF = panel.querySelector('[data-xul="followersMin"]');
    const maxF = panel.querySelector('[data-xul="followersMax"]');
    if (STATE.settings && protect && document.activeElement !== protect) {
      protect.checked = !!STATE.settings.protectMutual;
    }
    if (STATE.settings && skipUnknown && document.activeElement !== skipUnknown) {
      skipUnknown.checked = !!STATE.settings.skipUnknownFollowers;
    }
    if (STATE.settings && highlightQueued && document.activeElement !== highlightQueued) {
      highlightQueued.checked = STATE.settings.highlightQueued !== false;
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
      startBtn.textContent = STATE.running ? t("btnStop") : t("btnUnfollow");
      startBtn.disabled = false;
    }
    if (pauseBtn) {
      pauseBtn.disabled = !STATE.running;
      pauseBtn.textContent = STATE.paused ? t("btnResume") : t("btnPause");
    }

    applyHighlights(STATE.activeHandle);
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
      if (STATE._scanScheduled) return;
      STATE._scanScheduled = true;
      requestAnimationFrame(() => {
        STATE._scanScheduled = false;
        collectVisibleUsers();
        updateUI();
      });
    });
    if (document.body) {
      STATE.observer.observe(document.body, { childList: true, subtree: true });
    }
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
          log(t("logFollowingDetected"), "info");
        } else {
          if (STATE.running) {
            STATE.abort = true;
            log(t("logLeftPage"), "info");
          }
          clearHighlights();
          updateUI();
        }
      }
    };
    setInterval(check, 800);
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

  window.addEventListener("message", onNetworkMessage);

  async function boot() {
    ensureUI();
    await refreshSettings();
    watchRoute();
    if (isFollowingPage()) {
      STATE.lastPath = location.pathname;
      collectVisibleUsers();
      startObserver();
      updateUI();
      log(t("logFollowingDetected"), "info");
      if (STATE.followerCache.size === 0) {
        log(t("logWaitingFollowerData"), "info");
      }
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
