/**
 * MAIN-world hook: capture X GraphQL/API payloads for follower counts.
 * Posts compact user metrics to the content script via window.postMessage.
 * Does not send data off-device.
 */
(() => {
  "use strict";

  if (window.__xulNetHooked) return;
  window.__xulNetHooked = true;

  const SOURCE = "xul-net";
  const MAX_BODY = 8_000_000;

  function emit(users) {
    if (!users || !users.length) return;
    try {
      window.postMessage({ source: SOURCE, type: "users", users }, "*");
    } catch {
      /* ignore */
    }
  }

  function asHandle(v) {
    if (v == null) return null;
    const h = String(v).trim().replace(/^@/, "").toLowerCase();
    if (!h || h.length > 15) return null;
    if (!/^[a-z0-9_]+$/.test(h)) return null;
    return h;
  }

  function pushUser(bucket, handle, followers, name, followedBy) {
    if (!handle) return;
    const prev = bucket.get(handle) || {};
    const next = {
      handle,
      followers:
        typeof followers === "number" && Number.isFinite(followers)
          ? followers
          : prev.followers ?? null,
      name: name || prev.name || null,
      followedBy:
        typeof followedBy === "boolean" ? followedBy : prev.followedBy ?? null,
    };
    // Only keep if we learned something useful
    if (next.followers == null && next.followedBy == null && !next.name) return;
    bucket.set(handle, next);
  }

  /**
   * Walk GraphQL JSON and collect user-like objects.
   * X shapes vary: legacy.screen_name + followers_count, or core.screen_name.
   */
  function harvest(root) {
    const bucket = new Map();
    const stack = [root];
    let steps = 0;
    const LIMIT = 250000;

    while (stack.length && steps < LIMIT) {
      steps += 1;
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;

      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) stack.push(node[i]);
        continue;
      }

      const legacy = node.legacy && typeof node.legacy === "object" ? node.legacy : null;
      const core = node.core && typeof node.core === "object" ? node.core : null;
      const rel =
        node.relationship_perspectives && typeof node.relationship_perspectives === "object"
          ? node.relationship_perspectives
          : null;

      const handle =
        asHandle(legacy && legacy.screen_name) ||
        asHandle(core && core.screen_name) ||
        asHandle(node.screen_name) ||
        asHandle(node.username);

      let followers = null;
      if (legacy && typeof legacy.followers_count === "number") {
        followers = legacy.followers_count;
      } else if (typeof node.followers_count === "number") {
        followers = node.followers_count;
      } else if (
        node.public_metrics &&
        typeof node.public_metrics.followers_count === "number"
      ) {
        followers = node.public_metrics.followers_count;
      }

      let name = null;
      if (legacy && legacy.name) name = String(legacy.name);
      else if (core && core.name) name = String(core.name);
      else if (node.name) name = String(node.name);

      let followedBy = null;
      if (rel && typeof rel.followed_by === "boolean") followedBy = rel.followed_by;
      else if (legacy && typeof legacy.followed_by === "boolean") {
        followedBy = legacy.followed_by;
      }

      const looksLikeUser =
        handle &&
        (followers != null ||
          node.__typename === "User" ||
          (legacy && ("followers_count" in legacy || "friends_count" in legacy)) ||
          (core && core.screen_name));

      if (looksLikeUser) {
        pushUser(bucket, handle, followers, name, followedBy);
      }

      for (const key of Object.keys(node)) {
        // Skip bulky / low-value branches
        if (
          key === "entities" ||
          key === "ext_media_color" ||
          key === "profile_banner_extensions" ||
          key === "profile_image_extensions"
        ) {
          continue;
        }
        const child = node[key];
        if (child && typeof child === "object") stack.push(child);
      }
    }

    return Array.from(bucket.values()).filter(
      (u) => u.followers != null || u.followedBy != null
    );
  }

  function handleBody(text, url) {
    if (!text || typeof text !== "string") return;
    if (text.length < 20 || text.length > MAX_BODY) return;
    const u = String(url || "");
    // Only care about X API / GraphQL traffic
    if (!/\/i\/api\/|graphql|api\.x\.com|api\.twitter\.com/i.test(u)) {
      // Some builds use relative /i/api/graphql/...
      if (!/graphql/i.test(text.slice(0, 200)) && text[0] !== "{" && text[0] !== "[") {
        return;
      }
      // Still try if body looks like JSON API payload with user fields
      if (!/"followers_count"|screen_name|__typename":"User"/.test(text.slice(0, 50000))) {
        return;
      }
    }
    if (text[0] !== "{" && text[0] !== "[") return;

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }

    const users = harvest(data);
    if (users.length) emit(users);
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function xulFetch(input, init) {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input.url === "string"
            ? input.url
            : "";
      return origFetch.apply(this, arguments).then((res) => {
        try {
          if (res && typeof res.clone === "function") {
            const interesting =
              /\/i\/api\/|graphql|api\.x\.com|api\.twitter\.com/i.test(url) ||
              /graphql/i.test(url);
            if (interesting) {
              res
                .clone()
                .text()
                .then((t) => handleBody(t, url))
                .catch(() => {});
            }
          }
        } catch {
          /* ignore */
        }
        return res;
      });
    };
  }

  // ---- XHR ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__xulUrl = url;
    } catch {
      /* ignore */
    }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      this.addEventListener("load", function () {
        try {
          handleBody(this.responseText, this.__xulUrl || "");
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    return origSend.apply(this, arguments);
  };
})();
