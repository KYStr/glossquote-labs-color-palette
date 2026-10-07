import { spawnSync } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { builtinModules } from "node:module";
import { extname, isAbsolute, parse, relative, resolve, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPreviewHtml,
  assertProductionHtml,
  expectedJsonLd,
  parseReleaseArgs,
  productionHtml,
  releasePolicy,
} from "./release.mjs";
import { cloudflarePolicy } from "./cloudflare.mjs";
import { STATIC_MIME_TYPES } from "./serve.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REQUIRED_FILES = Object.freeze([
  "package.json",
  "scripts/serve.mjs",
  "scripts/check.mjs",
  "scripts/build.mjs",
  "scripts/release.mjs",
  "scripts/cloudflare.mjs",
  "public/index.html",
  "public/en/index.html",
  "public/styles/tokens.css",
  "public/styles/app.css",
  "public/js/app.mjs",
  "public/js/i18n.mjs",
  "test/scaffold.test.mjs",
  "test/release.test.mjs",
  "test/site-links.test.mjs",
  "wrangler.jsonc",
  ".gitignore",
  "README.md",
]);
const REQUIRED_SCRIPTS = Object.freeze({
  dev: "node scripts/serve.mjs",
  test: "node --test",
  check: "node scripts/check.mjs",
  build: "node scripts/build.mjs",
});
const EXPECTED_PUBLIC_ASSETS = Object.freeze([
  "en/index.html",
  "index.html",
  "js/app.mjs",
  "js/clipboard.mjs",
  "js/core/color.mjs",
  "js/core/contrast.mjs",
  "js/core/export.mjs",
  "js/core/palette.mjs",
  "js/i18n.mjs",
  "styles/app.css",
  "styles/tokens.css",
]);
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;
const APPROVED_FAMILY_HOME_LINKS = new Map([
  ["index.html", "https://glossquote.com/index.html"],
  ["en/index.html", "https://glossquote.com/en/index.html"],
]);
const NODE_BUILTINS = new Set(builtinModules);
for (const builtin of builtinModules) {
  if (!builtin.startsWith("node:")) NODE_BUILTINS.add("node:" + builtin);
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPathInside(rootPath, candidatePath) {
  const difference = relative(rootPath, candidatePath);
  return difference === "" || (
    difference !== ".." &&
    !isAbsolute(difference) &&
    difference.split(sep)[0] !== ".."
  );
}

async function resolvePhysicalDirectory(directoryPath) {
  const absolutePath = resolve(directoryPath);
  const { root } = parse(absolutePath);
  let currentPath = root;

  try {
    const rootInfo = await lstat(currentPath);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null;
    for (const segment of absolutePath.slice(root.length).split(sep).filter(Boolean)) {
      currentPath = resolve(currentPath, segment);
      const info = await lstat(currentPath);
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
    }
    const canonicalPath = await realpath(absolutePath);
    return samePath(canonicalPath, absolutePath) ? canonicalPath : null;
  } catch {
    return null;
  }
}

async function readRegularFile(path, projectRoot) {
  const absolutePath = resolve(path);
  if (!isPathInside(projectRoot, absolutePath) || samePath(projectRoot, absolutePath)) {
    throw new Error("A required source is outside the project.");
  }
  try {
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error();
    const canonicalPath = await realpath(absolutePath);
    if (!isPathInside(projectRoot, canonicalPath) || samePath(projectRoot, canonicalPath)) {
      throw new Error();
    }
    return { path: canonicalPath, contents: await readFile(canonicalPath, "utf8") };
  } catch {
    throw new Error("A required source is missing, linked, or not a regular file.");
  }
}

export async function collectPublicAssets(projectPath = PROJECT_ROOT) {
  const requestedRoot = resolve(projectPath);
  const projectRoot = await resolvePhysicalDirectory(requestedRoot);
  if (!projectRoot || !samePath(projectRoot, requestedRoot)) {
    throw new Error("The project root or one of its ancestors is linked or unavailable.");
  }

  const requestedPublicRoot = resolve(projectRoot, "public");
  const publicRoot = await resolvePhysicalDirectory(requestedPublicRoot);
  if (
    !publicRoot ||
    !isPathInside(projectRoot, publicRoot) ||
    samePath(projectRoot, publicRoot)
  ) {
    throw new Error("The public source must be a regular directory inside the project.");
  }

  const files = [];
  const byRelativePath = new Map();
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = resolve(directory, entry.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) throw new Error("Linked public sources are not allowed.");
      if (!SAFE_PATH_SEGMENT.test(entry.name)) {
        throw new Error("Public asset paths must use simple ASCII file names.");
      }
      if (info.isDirectory()) {
        await visit(sourcePath);
        continue;
      }
      if (!info.isFile()) throw new Error("Public assets must be regular files.");

      const relativePath = relative(publicRoot, sourcePath).split(sep).join("/");
      const extension = extname(relativePath).toLowerCase();
      if (!STATIC_MIME_TYPES.has(extension)) {
        throw new Error("Unsupported public asset type: " + relativePath);
      }
      const canonicalPath = await realpath(sourcePath);
      if (
        !isPathInside(publicRoot, canonicalPath) ||
        samePath(publicRoot, canonicalPath)
      ) {
        throw new Error("A public asset resolves outside public.");
      }
      const asset = { sourcePath: canonicalPath, relativePath, extension };
      files.push(asset);
      byRelativePath.set(relativePath, asset);
    }
  }

  await visit(publicRoot);
  if (!byRelativePath.has("index.html")) {
    throw new Error("The public directory must contain index.html.");
  }
  return { projectRoot, publicRoot, files, byRelativePath };
}

export function assertSafeRuntimeSource(source, fileLabel = "Public JavaScript") {
  const forbiddenPatterns = [
    ["dynamic code execution", /\beval\s*\(/u],
    ["dynamic function construction", /\bnew\s+Function\s*\(/u],
    ["HTML string injection", /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/u],
    ["document.write", /\bdocument\s*\.\s*write(?:ln)?\s*\(/u],
    ["network APIs", /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/u],
    ["persistent browser storage", /\b(?:localStorage|sessionStorage|indexedDB|caches|CacheStorage|serviceWorker)\b/u],
    ["cookie access", /\bdocument\s*\.\s*cookie\b/u],
    ["clipboard reads", /\bclipboard\s*(?:\?\.|\.)\s*read(?:Text)?\b/u],
  ];

  for (const [label, pattern] of forbiddenPatterns) {
    if (pattern.test(source)) {
      throw new Error(fileLabel + " contains disallowed " + label + ".");
    }
  }
}

function parseTagAttributes(tagText) {
  const firstSpace = tagText.search(/\s/u);
  const content = firstSpace === -1
    ? tagText.slice(1, -1)
    : tagText.slice(firstSpace, -1);
  const attributes = new Map();
  const pattern = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;
  for (const match of content.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attributes.set(name, value);
  }
  return attributes;
}

function localAssetTarget(ownerRelativePath, reference, assets, label) {
  const value = reference.trim();
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/u.test(value)
  ) {
    throw new Error(label + " must use a local relative asset path.");
  }

  const pathPart = value.split(/[?#]/u, 1)[0];
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    throw new Error(label + " contains an invalid encoded path.");
  }
  if (decodedPath.length === 0 || decodedPath.includes("\0") || decodedPath.includes("\\")) {
    throw new Error(label + " contains an invalid asset path.");
  }

  const target = posix.normalize(posix.join(posix.dirname(ownerRelativePath), decodedPath));
  if (
    target === "." ||
    target === ".." ||
    target.startsWith("../") ||
    target.startsWith("/")
  ) {
    throw new Error(label + " escapes the public directory.");
  }
  if (!assets.has(target)) {
    throw new Error(label + " points to a missing public asset: " + target);
  }
  return target;
}

export function assertHtmlResources(relativePath, html, assets, options = {}) {
  const production = options.production === true;
  const policy = options.policy;
  let exactJsonLd;
  if (production) {
    if (!policy) throw new Error("Production resource checks require the fixed release policy.");
    assertProductionHtml(html, relativePath, policy);
    exactJsonLd = expectedJsonLd(relativePath, policy);
    const scriptBlocks = [...html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/giu)];
    const inlineScripts = scriptBlocks.filter(([, attributes]) => !/\bsrc(?:\s|=|>|$)/iu.test(attributes));
    if (inlineScripts.length !== 1 || inlineScripts[0][0] !== exactJsonLd) {
      throw new Error(relativePath + " must contain only the exact controlled JSON-LD script.");
    }
  }
  if (/<style\b/iu.test(html)) {
    throw new Error(relativePath + " must load stylesheets from local CSS files.");
  }
  if (/<base\b/iu.test(html)) {
    throw new Error(relativePath + " cannot change the document base URL.");
  }

  for (const match of html.matchAll(/<([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/gu)) {
    const tagName = match[1].toLowerCase();
    const tagText = match[0];
    const attributes = parseTagAttributes(tagText);
    for (const name of attributes.keys()) {
      if (/^on[a-z]+$/u.test(name)) {
        throw new Error(relativePath + " contains an inline event handler.");
      }
      if (name === "style") {
        throw new Error(relativePath + " must not contain inline CSS.");
      }
    }

    for (const name of ["href", "src", "action", "formaction", "poster", "background"]) {
      const value = attributes.get(name);
      if (value && /^\s*javascript:/iu.test(value)) {
        throw new Error(relativePath + " contains a javascript URL.");
      }
    }
    if (attributes.has("ping")) {
      throw new Error(relativePath + " cannot send ping requests.");
    }
    if (attributes.has("action") || attributes.has("formaction")) {
      throw new Error(relativePath + " cannot submit a form.");
    }
    if (attributes.has("srcset")) {
      throw new Error(relativePath + " uses an unsupported srcset resource.");
    }
    if (tagName === "meta" && attributes.get("http-equiv")?.toLowerCase() === "refresh") {
      throw new Error(relativePath + " cannot redirect through a refresh directive.");
    }
    if (["iframe", "object", "embed"].includes(tagName)) {
      throw new Error(relativePath + " contains a blocked embedded resource.");
    }

    if (["script", "img", "source", "video", "audio", "track", "input"].includes(tagName)) {
      const source = attributes.get("src");
      if (tagName === "script" && !source) {
        if (!production || tagText !== '<script type="application/ld+json">') {
          throw new Error(relativePath + " must not contain inline scripts.");
        }
      }
      if (source) localAssetTarget(relativePath, source, assets, relativePath + " src");
    }
    for (const name of ["poster", "background"]) {
      const value = attributes.get(name);
      if (value) localAssetTarget(relativePath, value, assets, relativePath + " " + name);
    }

    if (tagName === "link") {
      const relTokens = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/u);
      const productionMetadataLink = production && relTokens.some((token) =>
        ["canonical", "alternate"].includes(token));
      if (relTokens.some((token) => (
        ["preconnect", "dns-prefetch", "prefetch", "prerender"].includes(token)
      ))) {
        throw new Error(relativePath + " cannot request a prefetched or external connection.");
      }
      if (!productionMetadataLink && (attributes.has("href") || relTokens.some((token) => (
        ["stylesheet", "icon", "manifest", "preload", "modulepreload"].includes(token)
      )))) {
        const href = attributes.get("href");
        if (!href) throw new Error(relativePath + " has a link without a local href.");
        localAssetTarget(relativePath, href, assets, relativePath + " href");
      }
    }

    if ((tagName === "a" || tagName === "area") && attributes.has("href")) {
      const href = attributes.get("href").trim();
      if (href.startsWith("#")) {
        if (href.includes("\\") || href.includes("\0")) {
          throw new Error(relativePath + " contains an invalid local fragment.");
        }
      } else if (tagName === "a" && APPROVED_FAMILY_HOME_LINKS.get(relativePath) === href) {
        // Only each static page's matching-language family homepage is external.
      } else {
        localAssetTarget(relativePath, href, assets, relativePath + " href");
      }
    }
    if ((tagName === "use" || tagName === "image") && attributes.has("href")) {
      localAssetTarget(relativePath, attributes.get("href"), assets, relativePath + " href");
    }
  }

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    if (match[2].trim().length > 0) {
      if (!production || match[0] !== exactJsonLd) {
        throw new Error(relativePath + " must not contain inline script content.");
      }
    }
  }
}

function assertCssResources(relativePath, css, assets) {
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/giu)) {
    const reference = match[1] ?? match[2] ?? match[3] ?? "";
    localAssetTarget(relativePath, reference, assets, relativePath + " CSS URL");
  }

  const importPattern = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s);]+))\s*\)?\s*;/giu;
  let importCount = 0;
  for (const match of css.matchAll(importPattern)) {
    importCount += 1;
    const reference = match[1] ?? match[2] ?? match[3] ?? "";
    localAssetTarget(relativePath, reference, assets, relativePath + " CSS import");
  }
  if (/@import\b/iu.test(css) && importCount === 0) {
    throw new Error(relativePath + " contains an invalid CSS import.");
  }
}

function extractModuleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gu,
    /\bexport\s+[^"';]*?\sfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  if (/\bimport\s*\(\s*(?!["'])/u.test(source)) {
    throw new Error("Non-literal dynamic module imports are not allowed.");
  }
  return specifiers;
}

export async function assertModuleReference(
  specifier,
  sourcePath,
  projectRoot,
  publicRoot,
  managedSources,
) {
  const sourceRelative = relative(projectRoot, sourcePath).split(sep).join("/");
  const isPublicSource = isPathInside(publicRoot, sourcePath);
  if (NODE_BUILTINS.has(specifier)) {
    if (isPublicSource) {
      throw new Error("Browser modules cannot import Node built-ins: " + sourceRelative);
    }
    return;
  }
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new Error("Module imports must be local or Node built-ins: " + sourceRelative);
  }
  if (/[?#\\\0]/u.test(specifier)) {
    throw new Error("Module imports cannot contain query, fragment, or backslash paths.");
  }

  let decodedSpecifier;
  try {
    decodedSpecifier = decodeURIComponent(specifier);
  } catch {
    throw new Error("A module import contains an invalid encoded path.");
  }
  const targetRelative = posix.normalize(
    posix.join(posix.dirname(sourceRelative), decodedSpecifier),
  );
  if (
    targetRelative === "." ||
    targetRelative === ".." ||
    targetRelative.startsWith("../") ||
    targetRelative.startsWith("/")
  ) {
    throw new Error("A module import escapes the project.");
  }
  const targetPath = resolve(projectRoot, ...targetRelative.split("/"));
  if (!isPathInside(projectRoot, targetPath) || samePath(projectRoot, targetPath)) {
    throw new Error("A module import escapes the project.");
  }
  if (isPublicSource && !isPathInside(publicRoot, targetPath)) {
    throw new Error("A browser module import escapes public.");
  }
  const targetFile = await readRegularFile(targetPath, projectRoot);
  if (!managedSources.has(resolve(targetFile.path))) {
    throw new Error("Module imports must target a managed JavaScript source.");
  }
}

export async function collectNodeSources(projectRoot, publicAssets) {
  const files = publicAssets.files
    .filter((asset) => asset.extension === ".js" || asset.extension === ".mjs")
    .map((asset) => asset.sourcePath);

  async function visit(directory, relativeDirectory) {
    const canonicalDirectory = await resolvePhysicalDirectory(directory);
    if (!canonicalDirectory || !isPathInside(projectRoot, canonicalDirectory)) {
      throw new Error("A Node source directory is linked or outside the project.");
    }
    const entries = await readdir(canonicalDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (relativeDirectory === "test" && entry.name === ".tmp") continue;
      const childPath = resolve(canonicalDirectory, entry.name);
      const info = await lstat(childPath);
      if (info.isSymbolicLink()) {
        throw new Error("Node source trees cannot contain links.");
      }
      if (info.isDirectory()) {
        await visit(childPath, relativeDirectory + "/" + entry.name);
      } else if (info.isFile() && [".js", ".mjs"].includes(extname(entry.name).toLowerCase())) {
        files.push(childPath);
      } else if (!info.isFile()) {
        throw new Error("Node source trees must contain regular files.");
      }
    }
  }

  for (const directoryName of ["scripts", "test"]) {
    await visit(resolve(projectRoot, directoryName), directoryName);
  }
  return [...new Set(files.map((path) => resolve(path)))].sort();
}

function assertPackageContract(packageJson) {
  if (
    packageJson.private !== true ||
    packageJson.type !== "module" ||
    packageJson.engines?.node !== ">=24"
  ) {
    throw new Error("package.json must declare a private Node 24+ ESM project.");
  }
  for (const [name, expected] of Object.entries(REQUIRED_SCRIPTS)) {
    if (packageJson.scripts?.[name] !== expected) {
      throw new Error("package.json has an unexpected " + name + " script.");
    }
  }
  if (
    Object.keys(packageJson.dependencies ?? {}).length > 0 ||
    Object.keys(packageJson.devDependencies ?? {}).length > 0
  ) {
    throw new Error("T00 must not add package dependencies.");
  }
}

function assertPublicAssetAllowlist(publicAssets) {
  const actual = publicAssets.files.map((asset) => asset.relativePath).sort();
  const expected = [...EXPECTED_PUBLIC_ASSETS].sort();
  for (const relativePath of actual) {
    if (!expected.includes(relativePath)) throw new Error("Unexpected public asset: " + relativePath);
  }
  for (const relativePath of expected) {
    if (!actual.includes(relativePath)) throw new Error("Missing public asset: " + relativePath);
  }
}

const EXPECTED_WRANGLER = Object.freeze({
  name: "glossquote-color-palette",
  compatibility_date: "2026-10-07",
  workers_dev: false,
  preview_urls: false,
  send_metrics: false,
  dependencies_instrumentation: { enabled: false },
  build: {
    command: "node scripts/build.mjs --production --cloudflare --site-url https://colors.glossquote.com/ && node scripts/check.mjs --production --cloudflare --site-url https://colors.glossquote.com/",
    cwd: ".",
  },
  assets: { directory: "./dist", html_handling: "none", not_found_handling: "none" },
  route: { pattern: "colors.glossquote.com", custom_domain: true },
  observability: {
    enabled: false,
    logs: { enabled: false, invocation_logs: false },
    traces: { enabled: false },
  },
});

function assertWranglerContract(contents) {
  let config;
  try {
    config = JSON.parse(contents);
  } catch {
    throw new Error("wrangler.jsonc must contain valid JSON without deployment extensions.");
  }
  if (JSON.stringify(config) !== JSON.stringify(EXPECTED_WRANGLER)) {
    throw new Error("wrangler.jsonc differs from the exact static-assets-only deployment policy.");
  }
}

async function readExpectedReleaseFiles(projectRoot, siteUrl) {
  const policy = releasePolicy(siteUrl);
  const cloudflare = cloudflarePolicy(siteUrl);
  const publicAssets = await collectPublicAssets(projectRoot);
  const expected = new Map();
  for (const asset of publicAssets.files) {
    const source = await readFile(asset.sourcePath);
    if (asset.extension === ".html") {
      const sourceHtml = source.toString("utf8");
      const transformed = productionHtml(sourceHtml, asset.relativePath, policy);
      assertHtmlResources(asset.relativePath, transformed, publicAssets.byRelativePath, {
        production: true,
        policy,
      });
      expected.set(asset.relativePath, Buffer.from(transformed, "utf8"));
    } else {
      expected.set(asset.relativePath, source);
    }
  }
  for (const [relativePath, contents] of cloudflare.files) {
    expected.set(relativePath, Buffer.from(contents, "utf8"));
  }
  for (const [relativePath, contents] of policy.files) {
    expected.set(relativePath, Buffer.from(contents, "utf8"));
  }
  return { expected, policy, publicAssets };
}

export async function checkReleaseOutput(
  outputPath = resolve(PROJECT_ROOT, "dist"),
  { projectRoot = PROJECT_ROOT, siteUrl, cloudflare = false } = {},
) {
  if (!cloudflare) throw new Error("Production output checking requires --cloudflare.");
  const requestedRoot = resolve(projectRoot);
  const canonicalRoot = await resolvePhysicalDirectory(requestedRoot);
  if (!canonicalRoot || !samePath(canonicalRoot, requestedRoot)) {
    throw new Error("The project root or one of its ancestors is linked or unavailable.");
  }
  const requestedOutput = resolve(outputPath);
  const expectedOutput = resolve(canonicalRoot, "dist");
  if (!samePath(requestedOutput, expectedOutput) || relative(canonicalRoot, requestedOutput) !== "dist") {
    throw new Error("The release output must be exactly the project dist directory.");
  }
  const canonicalOutput = await resolvePhysicalDirectory(requestedOutput);
  if (!canonicalOutput || !samePath(canonicalOutput, requestedOutput)) {
    throw new Error("The production dist directory is linked or unavailable.");
  }

  const { expected } = await readExpectedReleaseFiles(canonicalRoot, siteUrl);
  const actualFiles = new Map();
  const actualDirectories = new Set();
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childPath = resolve(directory, entry.name);
      const info = await lstat(childPath);
      if (info.isSymbolicLink()) throw new Error("The production dist tree contains a link.");
      if (info.isDirectory()) {
        const relativePath = relative(canonicalOutput, childPath).split(sep).join("/");
        actualDirectories.add(relativePath);
        await visit(childPath);
      } else if (info.isFile()) {
        const relativePath = relative(canonicalOutput, childPath).split(sep).join("/");
        actualFiles.set(relativePath, childPath);
      } else {
        throw new Error("The production dist tree contains a non-file asset.");
      }
    }
  }
  await visit(canonicalOutput);

  const expectedDirectories = new Set();
  for (const relativePath of expected.keys()) {
    const segments = relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      expectedDirectories.add(parent);
    }
  }
  for (const relativePath of actualFiles.keys()) {
    if (!expected.has(relativePath)) throw new Error("Unexpected release file: " + relativePath);
  }
  for (const relativePath of actualDirectories) {
    if (!expectedDirectories.has(relativePath)) throw new Error("Unexpected release directory: " + relativePath);
  }
  for (const [relativePath, expectedBytes] of expected) {
    const actualPath = actualFiles.get(relativePath);
    if (!actualPath) throw new Error("Missing release file: " + relativePath);
    const actualBytes = await readFile(actualPath);
    if (!actualBytes.equals(expectedBytes)) {
      throw new Error("Production release bytes differ: " + relativePath);
    }
  }
  return { checkedFiles: expected.size, outputPath: canonicalOutput };
}

export async function runProjectCheck({ projectRoot = PROJECT_ROOT } = {}) {
  const requestedRoot = resolve(projectRoot);
  const canonicalRoot = await resolvePhysicalDirectory(requestedRoot);
  if (!canonicalRoot || !samePath(canonicalRoot, requestedRoot)) {
    throw new Error("The project root or one of its ancestors is linked or unavailable.");
  }

  for (const relativePath of REQUIRED_FILES) {
    await readRegularFile(resolve(canonicalRoot, ...relativePath.split("/")), canonicalRoot);
  }
  const packageFile = await readRegularFile(resolve(canonicalRoot, "package.json"), canonicalRoot);
  let packageJson;
  try {
    packageJson = JSON.parse(packageFile.contents);
  } catch {
    throw new Error("package.json is not valid JSON.");
  }
  assertPackageContract(packageJson);
  const wranglerFile = await readRegularFile(resolve(canonicalRoot, "wrangler.jsonc"), canonicalRoot);
  assertWranglerContract(wranglerFile.contents);

  const publicAssets = await collectPublicAssets(canonicalRoot);
  assertPublicAssetAllowlist(publicAssets);
  for (const asset of publicAssets.files) {
    if (asset.extension === ".html") {
      const source = await readFile(asset.sourcePath, "utf8");
      if (["index.html", "en/index.html"].includes(asset.relativePath)) {
        assertPreviewHtml(source, asset.relativePath);
      }
      assertHtmlResources(asset.relativePath, source, publicAssets.byRelativePath);
    } else if (asset.extension === ".css") {
      const source = await readFile(asset.sourcePath, "utf8");
      assertCssResources(asset.relativePath, source, publicAssets.byRelativePath);
    } else if (asset.extension === ".js" || asset.extension === ".mjs") {
      const source = await readFile(asset.sourcePath, "utf8");
      assertSafeRuntimeSource(source, asset.relativePath);
    }
  }

  const nodeSources = await collectNodeSources(canonicalRoot, publicAssets);
  const managedSources = new Set(nodeSources.map((path) => resolve(path)));
  for (const sourcePath of nodeSources) {
    const source = await readFile(sourcePath, "utf8");
    for (const specifier of extractModuleSpecifiers(source)) {
      await assertModuleReference(
        specifier,
        sourcePath,
        canonicalRoot,
        publicAssets.publicRoot,
        managedSources,
      );
    }

    const syntax = spawnSync(process.execPath, ["--check", sourcePath], {
      cwd: canonicalRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (syntax.error || syntax.status !== 0) {
      const details = (syntax.stderr || syntax.stdout || "").trim();
      throw new Error(
        "JavaScript syntax check failed for " +
          relative(canonicalRoot, sourcePath).split(sep).join("/") +
          (details ? ":\n" + details : "."),
      );
    }
  }

  return {
    publicAssetCount: publicAssets.files.length,
    nodeSourceCount: nodeSources.length,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseReleaseArgs(process.argv.slice(2));
    const result = await runProjectCheck();
    if (options.production) {
      const production = await checkReleaseOutput(resolve(PROJECT_ROOT, "dist"), {
        projectRoot: PROJECT_ROOT,
        siteUrl: options.siteUrl,
        cloudflare: options.cloudflare,
      });
      process.stdout.write(`Checked ${production.checkedFiles} exact production release files in dist.\n`);
    } else {
      process.stdout.write(
        "Checked " + result.publicAssetCount + " public assets and " +
          result.nodeSourceCount + " JavaScript sources. Static checks do not replace manual privacy review.\n",
      );
    }
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : "Project check failed.") + "\n",
    );
    process.exitCode = 1;
  }
}
