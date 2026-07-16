(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  async function load() {
    const quota = await XULStorage.getQuota();
    const s = quota.settings;

    $("used").textContent = String(quota.used);
    $("remaining").textContent = String(quota.remaining);
    $("limit").textContent = String(quota.limit);
    $("dateHint").textContent = `Resets at local midnight · ${quota.daily.date}`;

    $("dailyLimit").value = String(s.dailyLimit);
    $("delayMinSec").value = String(Math.round(s.delayMinMs / 1000));
    $("delayMaxSec").value = String(Math.round(s.delayMaxMs / 1000));
    $("whitelist").value = (s.whitelist || []).join("\n");
    $("protectMutual").checked = !!s.protectMutual;

    $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  }

  async function save() {
    const dailyLimit = Number($("dailyLimit").value);
    const delayMinMs = Math.round(Number($("delayMinSec").value) * 1000);
    const delayMaxMs = Math.round(Number($("delayMaxSec").value) * 1000);
    const whitelist = $("whitelist").value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const protectMutual = $("protectMutual").checked;

    await XULStorage.saveSettings({
      dailyLimit,
      delayMinMs,
      delayMaxMs,
      whitelist,
      protectMutual,
    });

    const status = $("status");
    status.hidden = false;
    status.textContent = "Saved";
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
