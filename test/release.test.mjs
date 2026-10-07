import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProject } from "../scripts/build.mjs";
import { assertHtmlResources, checkReleaseOutput, collectPublicAssets, runProjectCheck } from "../scripts/check.mjs";
import { cloudflarePolicy } from "../scripts/cloudflare.mjs";
import {
  assertProductionHtml,
  expectedJsonLd,
  parseReleaseArgs,
  previewSeoTags,
  productionHtml,
  releasePolicy,
} from "../scripts/release.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TEMP = resolve(ROOT, "test/.tmp");
const SITE = "https://colors.glossquote.com/";

function isInside(root, candidate) {
  const part = relative(root, candidate);
  return part !== "" && !isAbsolute(part) && part.split(sep)[0] !== "..";
}

async function copyRegularTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("Release fixture source cannot contain links.");
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await copyRegularTree(resolve(source, entry.name), resolve(destination, entry.name));
    }
    return;
  }
  if (!info.isFile()) throw new Error("Release fixture source must contain regular files.");
  await mkdir(resolve(destination, ".."), { recursive: true });
  await writeFile(destination, await readFile(source), { flag: "wx" });
}

async function removeOwnedTree(directory, allowedRoot) {
  const canonicalRoot = await realpath(allowedRoot);
  const canonicalDirectory = await realpath(directory);
  assert.ok(isInside(canonicalRoot, canonicalDirectory));
  const info = await lstat(canonicalDirectory);
  assert.equal(info.isSymbolicLink(), false);
  for (const entry of await readdir(canonicalDirectory, { withFileTypes: true })) {
    const child = resolve(canonicalDirectory, entry.name);
    const childInfo = await lstat(child);
    if (childInfo.isSymbolicLink()) throw new Error("Release fixture cleanup encountered a link.");
    if (childInfo.isDirectory()) await removeOwnedTree(child, canonicalRoot);
    else if (childInfo.isFile()) await rm(child);
    else throw new Error("Release fixture cleanup encountered an unsupported path.");
  }
  await rmdir(canonicalDirectory);
}

async function writeFixtureProject(projectRoot) {
  for (const name of ["public", "scripts", "test"]) await mkdir(resolve(projectRoot, name), { recursive: true });
  await copyRegularTree(resolve(ROOT, "public"), resolve(projectRoot, "public"));
  await writeFile(resolve(projectRoot, "package.json"), await readFile(resolve(ROOT, "package.json")));
  await writeFile(resolve(projectRoot, "wrangler.jsonc"), await readFile(resolve(ROOT, "wrangler.jsonc")));
  await writeFile(resolve(projectRoot, ".gitignore"), await readFile(resolve(ROOT, ".gitignore")));
  await writeFile(resolve(projectRoot, "README.md"), await readFile(resolve(ROOT, "README.md")));
  for (const name of ["serve.mjs", "check.mjs", "build.mjs", "release.mjs", "cloudflare.mjs"]) {
    await writeFile(resolve(projectRoot, "scripts", name), "export {};\n");
  }
  for (const name of ["scaffold.test.mjs", "release.test.mjs", "site-links.test.mjs"]) {
    await writeFile(resolve(projectRoot, "test", name), "export {};\n");
  }
}

async function withFixture(action) {
  await mkdir(TEMP, { recursive: true });
  const tempInfo = await lstat(TEMP);
  assert.equal(tempInfo.isSymbolicLink(), false);
  assert.equal(await realpath(TEMP), TEMP);
  const workspace = await mkdtemp(resolve(TEMP, "release-"));
  const projectRoot = resolve(workspace, "product");
  await mkdir(projectRoot);
  try {
    await writeFixtureProject(projectRoot);
    return await action(projectRoot);
  } finally {
    await removeOwnedTree(workspace, TEMP);
  }
}

const build = (projectRoot, options = {}) => buildProject({ projectRoot, ...options });

test("production arguments require every explicit flag and the exact site origin", () => {
  assert.deepEqual(parseReleaseArgs([]), { production: false });
  assert.deepEqual(parseReleaseArgs(["--production", "--cloudflare", "--site-url", SITE]), {
    production: true,
    cloudflare: true,
    siteUrl: SITE,
  });
  for (const args of [
    ["--production"],
    ["--production", "--site-url", SITE],
    ["--cloudflare", "--site-url", SITE],
    ["--production", "--cloudflare"],
    ["--production", "--cloudflare", "--site-url", "https://colors.example.invalid/"],
    ["--production", "--cloudflare", "--site-url", "https://colors.glossquote.com.evil.invalid/"],
    ["--production", "--cloudflare", "--site-url", SITE, "extra"],
    ["--production", "--production", "--cloudflare", "--site-url", SITE],
  ]) assert.throws(() => parseReleaseArgs(args));
  for (const siteUrl of [
    "http://colors.glossquote.com/",
    "https://user@colors.glossquote.com/",
    "https://colors.glossquote.com/?q=1",
    "https://colors.glossquote.com/#fragment",
    "https://colors.glossquote.com/../other/",
    "https://colors.glossquote.com.evil.invalid/",
  ]) assert.throws(() => releasePolicy(siteUrl));
  assert.throws(() => cloudflarePolicy("https://colors.example.invalid/"), /colors.glossquote.com/);
});

test("preview and production builds keep metadata separate and emit exact bilingual SEO", async () => {
  await withFixture(async (projectRoot) => {
    const preview = await build(projectRoot);
    assert.equal(preview.fileCount, 11);
    const zhPreview = await readFile(resolve(preview.outputPath, "index.html"), "utf8");
    assert.match(zhPreview, /noindex, nofollow/u);
    assert.doesNotMatch(zhPreview, /colors\.glossquote\.com|rel="canonical"|application\/ld\+json/u);
    await assert.rejects(readFile(resolve(preview.outputPath, "robots.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(resolve(preview.outputPath, "_headers")), { code: "ENOENT" });

    const production = await build(projectRoot, { production: true, cloudflare: true, siteUrl: SITE });
    assert.equal(production.fileCount, 15);
    const policy = releasePolicy(SITE);
    for (const [page, language] of [["index.html", "zh-Hant"], ["en/index.html", "en"]]) {
      const html = await readFile(resolve(production.outputPath, page), "utf8");
      assert.match(html, new RegExp(`<html lang="${language}">`, "u"));
      assertProductionHtml(html, page, policy);
      const assets = (await collectPublicAssets(projectRoot)).byRelativePath;
      assertHtmlResources(page, html, assets, { production: true, policy });
      assert.match(html, /<meta name="robots" content="index, follow">/u);
      assert.match(html, /hreflang="x-default"/u);
      assert.match(html, page === "index.html"
        ? /<script type="module" src="\.\/js\/app\.mjs"><\/script>/u
        : /<script type="module" src="\.\.\/js\/app\.mjs"><\/script>/u);
      assert.match(html, /<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"WebApplication"/u);
      assert.doesNotMatch(html, /noindex|nofollow/u);
      assert.match(await readFile(resolve(projectRoot, "public", page), "utf8"), /noindex, nofollow/u);
    }
    assert.equal(await readFile(resolve(production.outputPath, "robots.txt"), "utf8"),
      `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
    const sitemap = await readFile(resolve(production.outputPath, "sitemap.xml"), "utf8");
    assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((entry) => entry[1]), [
      `${SITE}index.html`, `${SITE}en/index.html`,
    ]);
    const headers = await readFile(resolve(production.outputPath, "_headers"), "utf8");
    assert.match(headers, /connect-src 'none'/u);
    assert.match(headers, /frame-ancestors 'none'/u);
    assert.match(headers, /X-Content-Type-Options: nosniff/u);
    assert.match(headers, /Referrer-Policy: no-referrer/u);
    assert.equal(await readFile(resolve(production.outputPath, "_redirects"), "utf8"),
      "/ /index.html 301\n/en /en/index.html 301\n/en/ /en/index.html 301\n");
    assert.equal((await checkReleaseOutput(production.outputPath, {
      projectRoot,
      siteUrl: SITE,
      cloudflare: true,
    })).checkedFiles, 15);
  });
});

test("production metadata uses active head offsets when comments contain lookalike markup", async () => {
  const page = "index.html";
  const source = await readFile(resolve(ROOT, "public", page), "utf8");
  const preview = previewSeoTags(page).join(" ");
  const sourceWithDecoy = `<!-- template note: <head>${preview}</head> -->\n${source}`;
  const assets = (await collectPublicAssets(ROOT)).byRelativePath;
  const policy = releasePolicy(SITE);
  const output = productionHtml(sourceWithDecoy, page, policy);
  assert.ok(output.startsWith(`<!-- template note: <head>${preview}</head> -->\n`));
  assert.match(output, /<head>\s*<meta name="robots" content="index, follow">/u);
  assert.doesNotThrow(() => assertProductionHtml(output, page, policy));
  assert.doesNotThrow(() => assertHtmlResources(page, output, assets, { production: true, policy }));
});

test("malformed preview metadata, duplicate titles, remote assets, and unknown inline scripts preserve dist", async () => {
  await withFixture(async (projectRoot) => {
    await mkdir(resolve(projectRoot, "dist"));
    const sentinel = resolve(projectRoot, "dist/keep.txt");
    await writeFile(sentinel, "preserve before rejected build", "utf8");
    await assert.rejects(build(projectRoot, { production: true, cloudflare: true }), /site-url/u);
    await assert.rejects(build(projectRoot, {
      production: true,
      cloudflare: true,
      siteUrl: "https://colors.example.invalid/",
    }), /colors.glossquote.com/u);
    assert.equal(await readFile(sentinel, "utf8"), "preserve before rejected build");

    const page = resolve(projectRoot, "public/index.html");
    const original = await readFile(page, "utf8");
    const mutations = [
      [original.replace("<title>", "<title>Wrong "), /title differs/u],
      [original.replace("</title>", "</title><title>Duplicate</title>"), /one title/u],
      [original.replace('href="./index.html"', 'href="https://colors.glossquote.com/index.html"'), /metadata differs/u],
      [original.replace("</head>", '<script>globalThis.bad = true;</script></head>'), /inline scripts/u],
      [original.replace("</head>", '<script type="module" src="https://evil.invalid/app.mjs"></script></head>'), /local relative asset path/u],
    ];
    for (const [mutated, reason] of mutations) {
      await writeFile(page, mutated, "utf8");
      await assert.rejects(build(projectRoot, { production: true, cloudflare: true, siteUrl: SITE }), reason);
      assert.equal(await readFile(sentinel, "utf8"), "preserve before rejected build");
    }
  });
});

test("only the exact controlled JSON-LD block is allowed in production HTML", async () => {
  await withFixture(async (projectRoot) => {
    const { outputPath } = await build(projectRoot, { production: true, cloudflare: true, siteUrl: SITE });
    const htmlPath = resolve(outputPath, "index.html");
    const original = await readFile(htmlPath, "utf8");
    const expected = expectedJsonLd("index.html", releasePolicy(SITE));
    assert.equal(original.split(expected).length - 1, 1);

    const assets = (await collectPublicAssets(projectRoot)).byRelativePath;
    const policy = releasePolicy(SITE);
    const changedJsonLd = original.replace(expected, expected.replace("WebApplication", "Thing"));
    await writeFile(htmlPath, changedJsonLd, "utf8");
    await assert.rejects(checkReleaseOutput(outputPath, { projectRoot, siteUrl: SITE, cloudflare: true }), /release bytes differ/u);
    assert.throws(() => assertHtmlResources("index.html", changedJsonLd, assets, {
      production: true,
      policy,
    }), /exact controlled WebApplication JSON-LD/u);

    const extraScript = original.replace("</head>", '<script>globalThis.extra = true;</script></head>');
    await writeFile(htmlPath, extraScript, "utf8");
    await assert.rejects(checkReleaseOutput(outputPath, { projectRoot, siteUrl: SITE, cloudflare: true }), /release bytes differ/u);
    assert.throws(() => assertHtmlResources("index.html", extraScript, assets, {
      production: true,
      policy,
    }), /exact controlled WebApplication JSON-LD/u);
  });
});

test("production exact-output check reports missing, changed, and unexpected files", async () => {
  await withFixture(async (projectRoot) => {
    const { outputPath } = await build(projectRoot, { production: true, cloudflare: true, siteUrl: SITE });
    const englishPath = resolve(outputPath, "en/index.html");
    const originalEnglish = await readFile(englishPath);
    await rm(englishPath);
    await assert.rejects(checkReleaseOutput(outputPath, { projectRoot, siteUrl: SITE, cloudflare: true }), /Missing release file: en\/index\.html/u);
    await writeFile(englishPath, originalEnglish);

    const modulePath = resolve(outputPath, "js/i18n.mjs");
    const originalModule = await readFile(modulePath);
    await writeFile(modulePath, Buffer.concat([originalModule, Buffer.from("\n// changed\n")]));
    await assert.rejects(checkReleaseOutput(outputPath, { projectRoot, siteUrl: SITE, cloudflare: true }), /release bytes differ/u);
    await writeFile(modulePath, originalModule);

    await writeFile(resolve(outputPath, "unexpected.txt"), "not part of release", "utf8");
    await assert.rejects(checkReleaseOutput(outputPath, { projectRoot, siteUrl: SITE, cloudflare: true }), /Unexpected release file: unexpected\.txt/u);
  });
});

test("source check rejects missing or unexpected public assets", async () => {
  await withFixture(async (projectRoot) => {
    const extra = resolve(projectRoot, "public/styles/unexpected.css");
    await writeFile(extra, "body { color: red; }\n", "utf8");
    await assert.rejects(runProjectCheck({ projectRoot }), /Unexpected public asset: styles\/unexpected\.css/u);
    await rm(extra);

    const required = resolve(projectRoot, "public/js/clipboard.mjs");
    const original = await readFile(required);
    await rm(required);
    await assert.rejects(runProjectCheck({ projectRoot }), /Missing public asset: js\/clipboard\.mjs/u);
    await writeFile(required, original);
  });
});
