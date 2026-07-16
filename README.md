# X Unfollower Lite

Chrome extension (Manifest V3) that helps you clean your **X (Twitter) following list** by simulating normal UI clicks on the following page. No official API, no backend, no remote analytics — all settings and daily counters stay in `chrome.storage.local`.

> **Not affiliated with X Corp.** Use at your own risk. Automated actions may conflict with X’s Terms of Service and can lead to temporary limits. Prefer conservative settings.

## Product decisions (MVP)

| Topic | Choice |
|--------|--------|
| Data source | DOM for UI actions; passive GraphQL/API sniff for follower counts |
| Inactive detection | Deferred (not in v1) |
| Main UI | In-page panel on `/username/following` |
| Settings UI | Extension popup (daily limit, delays, whitelist) |
| Daily limit | Configurable (default **20**/day, local midnight reset) |
| Session limit | Configurable (default **20**/run) |
| Whitelist | Yes (v1) |
| Locales | English + 简体中文 (`chrome.i18n`) |

## Features

- Scan visible accounts on the following page (keeps scanning as you scroll)
- **Protect mutuals** (“Follows you”)
- Filter by follower count range
- Optional skip when follower count cannot be parsed
- Serial unfollow with confirm-dialog click
- Random delay between actions (default 3–8s) + periodic longer pauses
- Daily quota + per-run session cap with local persistence
- Whitelist handles that are never unfollowed
- Pause / stop, tab-hidden wait, consecutive failure circuit breaker
- EN / zh-CN UI via `_locales`

## Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this repository folder
4. Open `https://x.com/<you>/following` and use the **XU** floating button

## Chrome Web Store notes

Full copy, permission justifications, and screenshot checklist: **[STORE_LISTING.md](./STORE_LISTING.md)**.

- **Single purpose:** help users manage who they follow on X via on-page filters and assisted unfollow.
- **Permissions:** `storage` (settings + daily counter); host access to `x.com` / `twitter.com` only (content script).
- **Privacy:** see [PRIVACY.md](./PRIVACY.md) — no remote servers, no account credentials collected by the extension.

```bash
./scripts/package.sh
# → dist/x-unfollower-lite-<version>.zip
```

## Project layout

```
manifest.json
background.js
lib/constants.js
lib/storage.js
content/content.js
content/content.css
popup/popup.html
popup/popup.js
popup/popup.css
icons/
PRIVACY.md
```

## Safety defaults

- Daily limit: 20
- Session (per-run) limit: 20
- Delay: 3–8 seconds (randomized)
- Extra pause every 5 successful unfollows
- Stops after 3 consecutive DOM failures
- Requires explicit confirmation before a run

Raise limits only if you accept higher risk.

## Repo

https://github.com/ethan0xbuilds/x-unfollower-lite

## Roadmap (not v1)

- Optional inactivity filter (latest post age)
- Optional GraphQL capture for richer profiles
- Better multi-language DOM labels
- Per-session caps independent of daily limit

## License

MIT — see [LICENSE](./LICENSE).
