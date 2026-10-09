# Test results

Updated 2026-10-07. This record separates automated checks and a loopback HTTP smoke from browser and assistive-technology checks.

## T03 implementation checks

| Check | Result |
|---|---|
| `npm.cmd test` | PASS, 53 passed, 0 failed, exit 0. Covers the existing T00–T02 tests, two bilingual message-contract tests, and two CSS download lifecycle tests. |
| `npm.cmd run check` | PASS, exit 0. Checked 11 public assets and 17 JavaScript sources, including syntax and static-resource/security rules. |
| PowerShell `$env:PORT='0'; npm.cmd run dev` HTTP smoke | PASS at `http://127.0.0.1:56110/`. GET `/`, `/en/`, `/styles/app.css`, and `/js/app.mjs` returned 200 with HTML, CSS, and JavaScript MIME types; `X-Content-Type-Options: nosniff` was present. The child-owned preview session was stopped after the smoke. |
| Persistent environment guard before and after the preview | PASS. HKCU/HKLM PATH hashes, registry types and lengths, ephemeral-entry counts, and Environment-key fingerprints matched. The preview port was process-local. |

Environment snapshot values matched before and after:

| Scope | Registry type | PATH length / entries | Ephemeral entries | PATH SHA-256 | Environment-key SHA-256 |
|---|---|---:|---:|---|---|
| HKCU | ExpandString | 834 / 16 | 0 | `3efe0b0eba15a12d5555fb191a204ce0048f87381d73108bac1d6d5d05b67ffb` | `3a36b632b9e0143f2ff2b9e1c5b964e89bf192a4a3aa3ebc93ea8d0314ee7e5a` |
| HKLM | String | 1227 / 30 | 0 | `52d7cb0c3e02b67714f1b0caefc8f92d5d2c365bb2513dc537d42207d8b56eb8` | `a0f49688069fd5a21146e94fd22764caedcd3ffbe25dc60c716a6a398673ac82` |

## Browser cases awaiting primary verification

| Case | Result |
|---|---|
| CP-15 invalid draft hides stale contrast results and blocks CSS actions | NOT_RUN in this implementation task; requires interactive browser validation. |
| CP-16 real clipboard success and denial fallback | NOT_RUN; controller tests use a fake adapter and do not touch the operating system clipboard. |
| CP-18 hostile literal input remains text and makes no request | NOT_RUN in a browser. Parser and static-source checks do not prove the rendered DOM behavior. |
| CP-19 keyboard editing, ordering, selection, and focus | NOT_RUN in a browser. |
| CP-21 delayed clipboard response after reset or state change | NOT_RUN in a browser. The controller's fake-Promise tests verify its epoch behavior, but not the complete UI. |
| CP-20 320px, 200% zoom, forced low-contrast sample | NOT_RUN. |
| CP-22 swap behavior in the rendered interface | NOT_RUN in a browser. |

No browser version, screen-reader result, physical-device result, or manual OS clipboard result is claimed here. The primary agent owns those checks before T03 acceptance.

## Primary acceptance: T03 and T04 (2026-10-07)

The preceding NOT_RUN entries describe the child handoff. This section supersedes them where actual evidence is available. Primary reviewed the implementation and tests directly, independently ran the final 53-test suite and source checker (11 public assets / 17 JS sources), and then built and byte-verified 11 preview assets. All commands exited 0. No production deployment or source publication is claimed by this local acceptance.

The primary corrected one missed English static sentence: loading the page needs a connection; after loading, color calculations run locally. This correction is included in the final checks above. Initial review fixes also covered dirty-copy blocking, updated select labels, endpoint focus, repeated pagehide handling, and narrow-screen sizing.

Browser: real Codex in-app browser, on Windows. The host did not expose a verifiable browser build number. Routes `/index.html` and `/en/index.html` were tested via loopback. Viewports included 1280×900 and 320×740; 320px had 305px usable width due to its scrollbar.

| Case | Primary result and evidence |
|---|---|
| CP-01 | PASS — strict short HEX parsing and uppercase expansion, automated known vector. |
| CP-02 | PASS — alpha, named color, malformed and oversized input rejection. |
| CP-03 | PASS — RGB syntax/range cases; real English `256` reports range error. |
| CP-04 | PASS — 0/360 red vectors and normalization, automated. |
| CP-05 | PASS — green/blue vectors; real UI H=120 yields #00FF00. |
| CP-06 | PASS — grey raw precision and displayed HSL, automated. |
| CP-07 | PASS — black/white raw ratio 21 and four thresholds, automated. |
| CP-08 | PASS — exact same-color ratio 1; real same-white selection shows 1.00:1 and all four failures. |
| CP-09 | PASS — raw known vector; real #777777/#FFFFFF shows 4.48:1, normal AA fails and large AA passes. |
| CP-10 | PASS — #767676/#FFFFFF known raw ratio and thresholds, automated. |
| CP-11 | PASS — raw 4.499999 fails normal AA independently of display rounding. |
| CP-12 | PASS — automated bounds/stable IDs; real eight-color palette disables both add controls, endpoint reordering preserves the selected ID and focuses its swatch. |
| CP-13 | PASS — automated and real deletion of the background color resets the pair to the first two remaining colors. |
| CP-14 | PASS — exact CSS bytes in tests and actual keyboard-triggered browser download: palette.css, 54 bytes, UTF-8 without BOM, LF including final LF. The browser download-event listener timed out, but the newly saved file was independently found and byte-compared; the event timeout is not hidden. |
| CP-15 | PASS — real #zz retains the raw draft and error association, removes ratio/pass nodes, and disables related copy plus all CSS actions. Valid but pending drafts also block outputs. Switching colors preserves the invalid draft. |
| CP-16 | PASS for native success UI and controlled missing-adapter recovery. Native writeText resolved and success appeared; clipboard contents were not read. A separately labelled test-only browser fixture displayed a readonly selected #111410 fallback, and the exact multiline CSS fallback. Real permission-denial prompt remains NOT_RUN. |
| CP-17 | PARTIAL — real refresh restores the two defaults and unchanged URL; source inspection finds no content requests, storage/cookie writes, or URL persistence. Full Network/storage instrumentation remains NOT_RUN. |
| CP-18 | PARTIAL — the full hostile string was kept as input text, rejected, and produced zero img elements in the real app. Full Network proof of no x request remains NOT_RUN; source uses validated colors and textContent, never raw HTML. |
| CP-19 | PASS for real keyboard activation of add, RGB/HSL editing, sorting, removal, comparison swap and CSS download. A 15-step Tab traversal reached swatches, sorting, modes, field, copy, pair selects, swap and CSS with visible focus at every observed stop. Assistive technology remains NOT_RUN. |
| CP-20 | PARTIAL — Chinese and English 320px layouts have clientWidth=scrollWidth=305, including the eight-color palette and HSL fields; no observed interactive target was below 44px height. Same-white sample is intentionally unreadable while the surrounding controls remain readable. 68 observed English surrounding text foreground/background pairs meet their normal/large-text contrast threshold, excluding sample and disabled controls. True 200% browser zoom remains NOT_RUN. |
| CP-21 | PASS — fake-Promise controller tests plus a real DOM fixture with a delayed adapter. Reset occurs before resolution; after its visible completion marker appears, both copy status nodes remain empty and no fallback appears. This fixture performs no OS clipboard write and does not represent a real permission prompt. |
| CP-22 | PASS — real swap exchanges only the pair; palette order stays unchanged. Both languages state 18pt regular / 14pt bold and explicitly avoid whole-page WCAG certification. |

Both language home links were actually followed to the corresponding live GlossQuote homepage. Language switching reset the palette. A test-only module-503 fixture retained readable static instructions/FAQ with disabled actions; globally disabled JavaScript remains NOT_RUN. The normal preview reported no captured warning/error logs during the observed operations.

Source privacy review covers every shipped JS module, static resource, clipboard/download adapter and output path. Only explicit copy writes the clipboard; only explicit download creates a fixed CSS file. Reset and pagehide invalidate asynchronous status and release object URLs. This review and the static checker are not substitutes for a full runtime Network/storage audit.

User-authorized manual exceptions retained: full Network/storage inspection, actual permission rejection, global JS disable, genuine BFCache persisted restoration, screen reader, real 200% zoom, OS reduced-motion setting, other browsers/physical devices, and search indexing. No real-device or accessibility certification is claimed.

Primary evidence is kept outside publication under `.runs/color-palette/`: desktop screenshot, observed text-color pairs and contrast results, fixture server, and environment snapshots. Only task-owned previews were stopped; Ctrl+C exit 1 is intentional shutdown. Environment guard after T04 compared the complete Snapshots to the original baseline: both PATH hashes/types/lengths/ephemeral counts and full Environment-key fingerprints are unchanged, with values in the table above.

T03 and T04 local acceptance PASS with the explicitly permitted manual exceptions. T05 source/SEO release and live hosting are separate pending gates.

## T05 release tooling checks

2026-10-07. Local release preparation for the fixed candidate origin `https://colors.glossquote.com/`. This section records production-build tooling only; it does not claim GitHub publication, Cloudflare deployment, a live domain, or search indexing.

| Check | Result |
|---|---|
| `npm.cmd test` | PASS, 63 passed, 0 failed, exit 0. The original 53 T00–T04 cases remain; 10 release and site-link cases were added. |
| `npm.cmd run check` | PASS, exit 0; exact 11 public assets and 21 JavaScript sources checked. |
| `npm.cmd run build` | PASS; preview dist has 11 allowlisted assets with exact source bytes and no production SEO. |
| `npm.cmd run build -- --production --cloudflare --site-url https://colors.glossquote.com/` | PASS; production candidate dist has exactly 15 files, including two transformed pages, `_headers`, `_redirects`, `robots.txt`, and `sitemap.xml`. |
| `npm.cmd run check -- --production --cloudflare --site-url https://colors.glossquote.com/` | PASS; checks the exact 15-file release inventory and bytes, including controlled bilingual metadata and JSON-LD. |
| Negative release fixtures | PASS; reject wrong or incomplete production arguments, invalid source metadata and duplicate titles, unknown inline scripts, remote assets, missing or unexpected source/output assets, changed output bytes, and unexpected files. A comment containing preview head/metadata lookalikes does not affect transformation of the actual head. |
| Persistent environment guard before and after | PASS; HKCU/HKLM registry types, PATH lengths/hashes, ephemeral counts, and full Environment-key fingerprints match the saved baseline. |

Manual NOT_RUN remains unchanged from the T03/T04 record. This T05 child did not run a browser, Wrangler CLI dry-run, publication, deployment, or live-site check; the primary agent handles the next integration steps.

## Primary T05 release verification — 2026-10-07

The primary independently reviewed the final release transformation, build/check policy, exact asset allowlist, localized head metadata, and negative tests. After fixing incorrect metadata offsets, duplicate-title acceptance and module/JSON-LD classification, the final `npm.cmd test` passed 63/63; `npm.cmd run check` passed with 11 public assets and 21 JavaScript sources; `npm.cmd run build` byte-verified 11 preview assets. An isolated Wrangler 4.147.0 `deploy --dry-run` ran the production build and check, verified 15 exact production files, reported no bindings and exited 0. No credentials or deployment were used. The full persistent-environment snapshots matched the baseline, including both PATH hashes/types/lengths, TEMP/TMP and Environment-key fingerprints. UI source was unchanged, so the actual T03/T04 browser results remain applicable. Existing manual NOT_RUN items remain open. Local release checks are PASS; live hosting and indexing have not been established by this record.

## 2026-10-09 real release verification

The primary deployed the reviewed production assets to colors.glossquote.com under the user's explicit hosting and designated-token-file authorization. Worker version: da95e35c-ad08-4dfa-8181-b0d197df226a. All 36 real HTTPS checks passed: GET/HEAD, exact bytes of 13 public assets, bilingual canonical/hreflang/indexability, robots/sitemap, MIME/security headers, root/language redirects and 404 paths. Only after these passed was the catalog changed from draft to published, followed by verified bilingual homepage deployment.

Primary live IAB checks: the English homepage link opened the English tool; #777777 against #FFFFFF produced 4.48:1, normal-text AA failed and large-text AA passed. An invalid #bad-value draft removed the contrast result and disabled selected-color copy/CSS copy/download. Changing to Chinese reset the palette; adding white gave three colors, and reset restored two default colors. The Chinese home link returned to the verified Chinese catalog. Initial navigation snapshots showed the loading fallback; a reload was used once on the English page, and subsequent Chinese initialization was confirmed directly in the rendered DOM without reloading. No console warnings/errors were captured. These observations are not a controlled cold-cache or full Network audit; previous manual NOT_RUN items remain open. The unchanged functional source retains its prior 63/63 test evidence.
