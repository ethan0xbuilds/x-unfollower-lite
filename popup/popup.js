(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  async function load() {
    xulApplyI18n(document);

    const quota = await XULStorage.getQuota();
    const s = quota.settings;

    $("used").textContent = String(quota.used);
    $("remaining").textContent = String(quota.remaining);
    $("limit").textContent = String(quota.limit);
    $("dateHint").textContent = xulT("resetsAt", [quota.daily.date]);

    $("dailyLimit").value = String(s.dailyLimit);
    $("sessionLimit").value = String(s.sessionLimit);
    $("delayMinSec").value = String(Math.round(s.delayMinMs / 1000));
    $("delayMaxSec").value = String(Math.round(s.delayMaxMs / 1000));
    $("whitelist").value = (s.whitelist || []).join("\n");
    $("protectMutual").checked = !!s.protectMutual;
    $("skipUnknownFollowers").checked = !!s.skipUnknownFollowers;

    $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  }

  async function save() {
    const dailyLimit = Number($("dailyLimit").value);
    const sessionLimit = Number($("sessionLimit").value);
    const delayMinMs = Math.round(Number($("delayMinSec").value) * 1000);
    const delayMaxMs = Math.round(Number($("delayMaxSec").value) * 1000);
    const whitelist = $("whitelist").value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const protectMutual = $("protectMutual").checked;
    const skipUnknownFollowers = $("skipUnknownFollowers").checked;

    await XULStorage.saveSettings({
      dailyLimit,
      sessionLimit,
      delayMinMs,
      delayMaxMs,
      whitelist,
      protectMutual,
      skipUnknownFollowers,
    });

    const status = $("status");
    status.hidden = false;
    status.style.color = "#00ba7c";
    status.textContent = xulT("saved");
    setTimeout(() => {
      status.hidden = true;
    }, 1500);
    await load();
  }

  $("save").addEventListener("click", () => {
    save().catch((e) => {
      $("status").hidden = false;
      $("status").textContent = String(e.message || e);
      $("status").style.color = "#f4212e";
    });
  });

  load().catch(console.error);
})();
