/**
 * Service worker — keep lightweight. Primary state lives in chrome.storage.local.
 */

chrome.runtime.onInstalled.addListener(() => {
  // No-op: settings merge happens on first read with defaults.
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "xul:ping") return;
  sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
  return false;
});
