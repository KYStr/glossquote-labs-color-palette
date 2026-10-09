# 配色與文字對比工具 / Color Palette and Text Contrast

繁體中文與英文的本機配色工具。手動整理 2 至 8 個不透明 sRGB 色票，以 HEX、RGB 或 HSL 編輯，並檢查前景文字與背景色的 WCAG 對比比值。色票與草稿只保存在目前頁面的記憶體中；重新整理、重設或切換語言會清除它們。剪貼簿只會在你明確選擇複製時寫入，CSS 下載只在你明確選擇下載時建立固定格式的檔案。

The bilingual palette tool lets you arrange 2 to 8 opaque sRGB colors, edit HEX, RGB, or HSL values, and check text-to-background WCAG contrast ratios. Colors and drafts stay in the current page's memory and are cleared by refresh, reset, or a language change. Clipboard writes and CSS downloads happen only after an explicit user action.

## 本機開發 / Local development

需要 Node.js 24 或更新版本。專案使用 Node 內建模組，不需要執行 `npm install`，也沒有執行期或開發依賴。

Requires Node.js 24 or newer. The project uses Node built-ins; no `npm install` is needed and there are no runtime or development dependencies.

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run dev
```

開發伺服器只綁定 `127.0.0.1`，預設使用 4173 埠；`PORT=0` 可要求作業系統分配臨時埠。預覽提供 `/`、`/en`、`/en/` 與明確頁面路徑，未知檔案回傳 404。預覽輸出維持 noindex。

The development server binds only to `127.0.0.1` and uses port 4173 by default; `PORT=0` asks the OS for a temporary port. Preview routes include `/`, `/en`, `/en/`, and the explicit page paths. Unknown files return 404, and preview pages remain noindex.

## 正式候選建置 / Production candidate build

正式 SEO 只會在以下明確參數全部提供時生成。建置會輸出雙語 canonical、互惠 hreflang、Open Graph 與受控 WebApplication JSON-LD，以及 `robots.txt`、雙頁 `sitemap.xml`、安全標頭和首頁路由規則。正式候選網址是 `https://colors.glossquote.com/`。

Production SEO is generated only when all explicit flags below are supplied. The build adds bilingual canonicals and reciprocal hreflang, Open Graph and controlled WebApplication JSON-LD, `robots.txt`, a two-page `sitemap.xml`, security headers, and explicit homepage routes. The production candidate origin is `https://colors.glossquote.com/`.

```powershell
npm.cmd run build -- --production --cloudflare --site-url https://colors.glossquote.com/
npm.cmd run check -- --production --cloudflare --site-url https://colors.glossquote.com/
```

`wrangler.jsonc` 設定僅提供靜態資產的 Cloudflare 站點，部署前會執行正式建置與精確產物檢查。2026-10-09 已正式上線：[繁體中文](https://colors.glossquote.com/index.html) · [English](https://colors.glossquote.com/en/index.html)。36 項正式 HTTPS 檢查通過，13 個公開資產與審查過的建置逐位元組相同；雙語首頁已列出本工具。搜尋引擎是否收錄仍未確認。

`wrangler.jsonc` describes a static-assets-only Cloudflare configuration. Its build command runs both the production build and exact output check. Live hosting was verified on 2026-10-09: 36 HTTPS checks passed and all 13 public assets match the reviewed build. Both languages are listed on the GlossQuote homepage. Search-engine indexing remains unverified.

人工待驗項仍包括實際剪貼簿拒絕提示、全站停用 JavaScript、BFCache 邊界、螢幕閱讀器、真正 200% 瀏覽器縮放、作業系統減少動態效果設定、其他瀏覽器與實體裝置，以及搜尋收錄。這些狀態會保持 NOT_RUN，直到實際驗證。

Manual NOT_RUN items include a real clipboard permission rejection, globally disabled JavaScript, BFCache edge behavior, screen-reader use, true 200% browser zoom, the OS reduced-motion setting, other browsers and physical devices, and search indexing. They remain NOT_RUN until directly verified.
