# Chrome Web Store Listing Kit

Use this when submitting **X Unfollower Lite** to the Chrome Web Store.

## Single purpose

Help users manage who they follow on X (Twitter) by filtering the on-page following list and assisting with deliberate, rate-limited unfollows via the site’s own UI.

## Short description (≤ 132 characters)

**EN:** Safely clean your X following list with mutual protection, filters, and local rate limits. Data stays on your device.

**ZH:** 安全清理 X 关注列表：互关保护、粉丝筛选、本地限速。数据仅存本机。

## Detailed description

### English

X Unfollower Lite helps you tidy your X (Twitter) following list **without sending your data to our servers**.

**What it does**
- Works on your following page (`x.com/you/following`)
- Scans accounts already visible in the page as you scroll
- Protect mutual follows (“Follows you”)
- Filter by follower count range
- Optional whitelist of handles you never want to unfollow
- Assists unfollow by simulating the same button clicks you would make
- Built-in daily limit, per-run session limit, and random delays

**What it does not do**
- Does not use the official X API
- Does not require your password
- Does not upload your following list
- Does not run a remote backend

**How to use**
1. Install the extension
2. Open your following list on X
3. Use the floating **XU** panel to filter and start a limited run
4. Adjust daily limit / whitelist in the toolbar popup

**Important**
This tool simulates normal UI interactions. Aggressive automation can conflict with X’s rules and may lead to temporary limits. Keep the default conservative limits (20/day, 3–8s delays) unless you understand the risk. Not affiliated with X Corp.

Privacy policy: see PRIVACY.md in the project repository (host a public URL for the store form).

### 中文

X Unfollower Lite 帮助你清理 X（Twitter）关注列表，**数据只保存在你的浏览器本地**。

**功能**
- 在关注列表页工作
- 随滚动持续扫描可见账号
- 互关保护（“关注了你”）
- 按粉丝数区间筛选
- 白名单永不取关
- 通过模拟点击官方按钮协助取关
- 每日上限、单次上限、随机间隔

**不做的事**
- 不调用官方 API
- 不索要密码
- 不上传关注列表
- 无自建后端

**注意**
过于激进的自动操作可能触发平台限制。请优先使用默认保守设置。本扩展与 X Corp. 无关。

## Permission justifications

| Permission | Justification |
|------------|----------------|
| `storage` | Save user settings (limits, delays, whitelist, filters) and the daily counter on the device. |
| Host `https://x.com/*` | Inject the panel and read/interact with the following list UI the user already opened. |
| Host `https://twitter.com/*` | Same functionality on the legacy domain redirect. |

## Category

Productivity (or Social)

## Screenshots checklist (create manually)

Recommended set (1280×800 or 640×400):

1. Following page with the **XU** panel open (filters visible)
2. Popup settings (daily limit + whitelist)
3. Confirm dialog / log showing a successful rate-limited run
4. (Optional) Mutual protection toggle highlighted

## Privacy policy URL

Host `PRIVACY.md` publicly, for example:

- GitHub: `https://github.com/ethan0xbuilds/x-unfollower-lite/blob/main/PRIVACY.md`
- Or a dedicated page on your site (preferred for store reviews)

## Package command

```bash
./scripts/package.sh
# → dist/x-unfollower-lite-1.1.0.zip
```

Upload the zip in the Developer Dashboard. Do not include `.git`.
