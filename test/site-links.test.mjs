import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertHtmlResources, collectPublicAssets } from "../scripts/check.mjs";
import { assertPreviewHtml } from "../scripts/release.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("bilingual preview pages declare only their exact local language alternates", async () => {
  const assets = await collectPublicAssets(ROOT);
  const expected = new Map([
    ["index.html", [
      '<link rel="alternate" hreflang="en" href="./en/index.html">',
      '<link rel="alternate" hreflang="zh-Hant" href="./index.html">',
    ]],
    ["en/index.html", [
      '<link rel="alternate" hreflang="zh-Hant" href="../index.html">',
      '<link rel="alternate" hreflang="en" href="./index.html">',
    ]],
  ]);
  for (const [page, tags] of expected) {
    const html = await readFile(resolve(ROOT, "public", page), "utf8");
    assertPreviewHtml(html, page);
    for (const tag of tags) assert.equal(html.split(tag).length - 1, 1);
    assert.doesNotThrow(() => assertHtmlResources(page, html, assets.byRelativePath));
  }
});

test("only the matching-language GlossQuote homepage is an allowed external link", async () => {
  const assets = (await collectPublicAssets(ROOT)).byRelativePath;
  assert.doesNotThrow(() => assertHtmlResources(
    "index.html",
    '<a href="https://glossquote.com/index.html">home</a>',
    assets,
  ));
  assert.doesNotThrow(() => assertHtmlResources(
    "en/index.html",
    '<a href="https://glossquote.com/en/index.html">home</a>',
    assets,
  ));
  for (const [page, markup] of [
    ["index.html", '<a href="https://glossquote.com/en/index.html">wrong language</a>'],
    ["index.html", '<a href="https://glossquote.com/index.html?next=1">query</a>'],
    ["index.html", '<a href="https://glossquote.com.evil.invalid/index.html">lookalike host</a>'],
    ["index.html", '<a href="https://glossquote.com@evil.invalid/index.html">credential-like host</a>'],
    ["index.html", '<a href="https://glossquote.com/index.html" ping="https://evil.invalid/ping">ping</a>'],
    ["en/index.html", '<a href="https://glossquote.com/en/index.html#fragment">fragment</a>'],
  ]) assert.throws(() => assertHtmlResources(page, markup, assets));
});

test("preview rejects external scripts, stylesheets, and alternate hosts", async () => {
  const assets = (await collectPublicAssets(ROOT)).byRelativePath;
  for (const markup of [
    '<script src="https://evil.invalid/app.mjs"></script>',
    '<link rel="stylesheet" href="https://evil.invalid/style.css">',
    '<link rel="alternate" hreflang="en" href="https://colors.glossquote.com/en/index.html">',
    '<link rel="stylesheet" href="./styles/missing.css">',
  ]) assert.throws(() => assertHtmlResources("index.html", markup, assets));
});
