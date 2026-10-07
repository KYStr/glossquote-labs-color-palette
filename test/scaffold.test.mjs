import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertHtmlResources,
  assertModuleReference,
  assertSafeRuntimeSource,
  collectNodeSources,
  collectPublicAssets,
} from "../scripts/check.mjs";
import { preflightBuild } from "../scripts/build.mjs";
import { createStaticServer } from "../scripts/serve.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TEMP_PARENT = resolve(PROJECT_ROOT, "test", ".tmp");

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

async function assertPhysicalDirectory(directoryPath) {
  const absolutePath = resolve(directoryPath);
  const { root } = parse(absolutePath);
  let currentPath = root;
  const rootInfo = await lstat(currentPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Temporary paths must have regular physical ancestors.");
  }
  for (const segment of absolutePath.slice(root.length).split(sep).filter(Boolean)) {
    currentPath = resolve(currentPath, segment);
    const info = await lstat(currentPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Temporary paths must not contain linked ancestors.");
    }
  }
  const canonicalPath = await realpath(absolutePath);
  if (!samePath(canonicalPath, absolutePath)) {
    throw new Error("Temporary paths must resolve to their physical locations.");
  }
  return canonicalPath;
}

async function rejectLinkedDescendants(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = resolve(directory, entry.name);
    const info = await lstat(childPath);
    if (info.isSymbolicLink()) {
      throw new Error("Temporary cleanup refuses linked descendants.");
    }
    if (info.isDirectory()) {
      await rejectLinkedDescendants(childPath);
    } else if (!info.isFile()) {
      throw new Error("Temporary cleanup requires regular files and directories.");
    }
  }
}

async function createTemporaryRoot(parentPath = TEMP_PARENT) {
  const workspaceRoot = await assertPhysicalDirectory(PROJECT_ROOT);
  const requestedParent = resolve(parentPath);
  if (!isPathInside(workspaceRoot, requestedParent) || samePath(workspaceRoot, requestedParent)) {
    throw new Error("Temporary directories must stay inside the workspace.");
  }
  const parentDirectory = dirname(requestedParent);
  const canonicalParentDirectory = await assertPhysicalDirectory(parentDirectory);
  if (!isPathInside(workspaceRoot, canonicalParentDirectory)) {
    throw new Error("Temporary directory parents must stay inside the workspace.");
  }

  try {
    const info = await lstat(requestedParent);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("The temporary parent is linked or not a directory.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(requestedParent);
  }

  const canonicalParent = await assertPhysicalDirectory(requestedParent);
  if (
    !isPathInside(workspaceRoot, canonicalParent) ||
    !samePath(canonicalParent, requestedParent)
  ) {
    throw new Error("The temporary parent resolves outside the workspace.");
  }
  const created = await mkdtemp(join(canonicalParent, "scaffold-"));
  const canonicalCreated = await assertPhysicalDirectory(created);
  if (!isPathInside(canonicalParent, canonicalCreated)) {
    throw new Error("The temporary directory resolves outside its parent.");
  }
  return canonicalCreated;
}

async function removeTemporaryRoot(pathToRemove, parentPath = TEMP_PARENT) {
  const workspaceRoot = await assertPhysicalDirectory(PROJECT_ROOT);
  const canonicalParent = await assertPhysicalDirectory(parentPath);
  if (
    !isPathInside(workspaceRoot, canonicalParent) ||
    samePath(workspaceRoot, canonicalParent)
  ) {
    throw new Error("Temporary cleanup parent is outside the workspace.");
  }
  const target = resolve(pathToRemove);
  const difference = relative(canonicalParent, target);
  assert.ok(
    difference !== "" &&
      difference !== ".." &&
      !difference.startsWith(".." + sep) &&
      !isAbsolute(difference),
    "temporary cleanup target must stay inside test/.tmp",
  );
  const canonicalTarget = await assertPhysicalDirectory(target);
  assert.ok(
    isPathInside(canonicalParent, canonicalTarget) &&
      !samePath(canonicalParent, canonicalTarget),
    "temporary cleanup target must resolve inside its physical parent",
  );
  await rejectLinkedDescendants(canonicalTarget);
  await rm(canonicalTarget, { recursive: true, force: false });
}

async function initializeProjectRoot(projectRoot) {
  await mkdir(resolve(projectRoot, "public"), { recursive: true });
  await writeFile(resolve(projectRoot, "public", "index.html"), "<!doctype html>\n");
}

async function listenLoopback(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  return address.port;
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
}

function request(port, { method = "GET", path = "/" } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, method, path },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolvePromise({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", rejectPromise);
    req.end();
  });
}

test("T00 package and bilingual pages keep an honest noindex fallback", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(PROJECT_ROOT, "package.json"), "utf8"),
  );
  const html = await readFile(resolve(PROJECT_ROOT, "public", "index.html"), "utf8");
  const english = await readFile(resolve(PROJECT_ROOT, "public", "en", "index.html"), "utf8");

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines.node, ">=24");
  assert.deepEqual(packageJson.scripts, {
    dev: "node scripts/serve.mjs",
    test: "node --test",
    check: "node scripts/check.mjs",
    build: "node scripts/build.mjs",
  });
  assert.match(html, /<meta\s+name="robots"\s+content="noindex, nofollow">/u);
  assert.match(html, /<link rel="alternate" hreflang="en" href="\.\/en\/index\.html">/u);
  assert.match(html, /<link rel="alternate" hreflang="zh-Hant" href="\.\/index\.html">/u);
  assert.match(html, /配色與文字對比/u);
  assert.match(html, /id="palette-app"/u);
  assert.match(html, /互動功能需要 JavaScript/u);
  assert.match(html, /<button[^>]+disabled/u);
  assert.match(english, /<html lang="en">/u);
  assert.match(english, /<meta\s+name="robots"\s+content="noindex, nofollow">/u);
  assert.match(english, /<link rel="alternate" hreflang="zh-Hant" href="\.\.\/index\.html">/u);
  assert.match(english, /<link rel="alternate" hreflang="en" href="\.\/index\.html">/u);
  assert.match(english, /id="palette-app"/u);
  assert.match(english, /JavaScript is required for interactive features/u);
});

test("loopback server handles static methods, headers, queries, and path boundaries", async (t) => {
  const server = createStaticServer();
  const port = await listenLoopback(server);
  t.after(() => closeServer(server));

  const home = await request(port);
  assert.equal(home.statusCode, 200);
  assert.match(home.headers["content-type"], /^text\/html;\s*charset=utf-8$/u);
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.match(home.headers["content-security-policy"], /connect-src 'none'/u);
  assert.match(home.headers["x-robots-tag"], /noindex/u);
  assert.match(home.body, /noindex, nofollow/u);

  const query = await request(port, { path: "/index.html?private-value=never-log" });
  assert.equal(query.statusCode, 200);
  assert.match(query.body, /配色與文字對比/u);

  const englishRoute = await request(port, { path: "/en/" });
  assert.equal(englishRoute.statusCode, 200);
  assert.match(englishRoute.body, /Color Palette and Text Contrast/u);
  const englishRouteWithoutSlash = await request(port, { path: "/en?private-value=never-log" });
  assert.equal(englishRouteWithoutSlash.statusCode, 200);
  assert.match(englishRouteWithoutSlash.body, /<html lang="en">/u);

  const head = await request(port, { method: "HEAD", path: "/styles/app.css" });
  assert.equal(head.statusCode, 200);
  assert.match(head.headers["content-type"], /^text\/css;\s*charset=utf-8$/u);
  assert.equal(head.body, "");

  const post = await request(port, { method: "POST", path: "/index.html" });
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, "GET, HEAD");

  const packageRequest = await request(port, { path: "/package.json" });
  assert.equal(packageRequest.statusCode, 404);
  const unknown = await request(port, { path: "/unknown-page.html" });
  assert.equal(unknown.statusCode, 404);
  const traversal = await request(port, { path: "/%2e%2e/package.json" });
  assert.equal(traversal.statusCode, 403);
});

test("loopback server refuses linked public directories and linked descendants", async () => {
  const temporaryRoot = await createTemporaryRoot();
  const outside = resolve(temporaryRoot, "outside");
  const projectWithLinkedChild = resolve(temporaryRoot, "project-child");
  const projectWithLinkedPublic = resolve(temporaryRoot, "project-public");
  const linkedChild = resolve(projectWithLinkedChild, "public", "linked");
  const linkedPublic = resolve(projectWithLinkedPublic, "public");
  let childServer;
  let publicServer;

  try {
    await mkdir(outside, { recursive: true });
    await writeFile(resolve(outside, "secret.html"), "outside public");
    await initializeProjectRoot(projectWithLinkedChild);
    await symlink(outside, linkedChild, "junction");

    childServer = createStaticServer({
      projectRoot: projectWithLinkedChild,
      publicRoot: resolve(projectWithLinkedChild, "public"),
    });
    const childPort = await listenLoopback(childServer);
    assert.equal(
      (await request(childPort, { path: "/linked/secret.html" })).statusCode,
      403,
    );
    await closeServer(childServer);

    await mkdir(projectWithLinkedPublic, { recursive: true });
    await symlink(outside, linkedPublic, "junction");
    publicServer = createStaticServer({
      projectRoot: projectWithLinkedPublic,
      publicRoot: linkedPublic,
    });
    const publicPort = await listenLoopback(publicServer);
    assert.equal((await request(publicPort, { path: "/secret.html" })).statusCode, 403);
  } finally {
    await closeServer(childServer);
    await closeServer(publicServer);
    for (const linkPath of [linkedChild, linkedPublic]) {
      try {
        const info = await lstat(linkPath);
        if (info.isSymbolicLink()) await unlink(linkPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await removeTemporaryRoot(temporaryRoot);
  }
});

test("public discovery includes future modules and rejects non-static assets", async () => {
  const temporaryRoot = await createTemporaryRoot();
  try {
    await initializeProjectRoot(temporaryRoot);
    await mkdir(resolve(temporaryRoot, "public", "js", "core"), { recursive: true });
    await writeFile(
      resolve(temporaryRoot, "public", "js", "core", "color.mjs"),
      "export const sample = 1;\n",
    );
    const discovered = await collectPublicAssets(temporaryRoot);
    assert.ok(discovered.byRelativePath.has("js/core/color.mjs"));

    await writeFile(resolve(temporaryRoot, "public", "notes.md"), "not a static asset\n");
    await assert.rejects(
      collectPublicAssets(temporaryRoot),
      /Unsupported public asset type/u,
    );
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
});

test("HTML checks reject external navigation and request paths but allow local links", async () => {
  const publicAssets = await collectPublicAssets(PROJECT_ROOT);
  const assets = publicAssets.byRelativePath;
  assert.doesNotThrow(() => assertHtmlResources(
    "index.html",
    '<a href="#status-title">status</a><a href="./index.html#status-title">same page</a>',
    assets,
  ));
  assert.doesNotThrow(() => assertHtmlResources(
    "index.html",
    '<a href="https://glossquote.com/index.html">matching language home</a>',
    assets,
  ));
  assert.doesNotThrow(() => assertHtmlResources(
    "en/index.html",
    '<a href="https://glossquote.com/en/index.html">matching language home</a>',
    assets,
  ));

  const unsupportedMarkup = [
    '<a href="https://example.invalid/">external</a>',
    '<a href="https://glossquote.com/en/index.html">wrong language home</a>',
    '<a href="https://glossquote.com/index.html?next=1">modified home URL</a>',
    '<a href="./index.html" ping="https://example.invalid/ping">local</a>',
    '<form action="https://example.invalid/"><button>send</button></form>',
    '<button formaction="https://example.invalid/">send</button>',
    '<video poster="https://example.invalid/preview.png"></video>',
    '<link rel="prefetch" href="https://example.invalid/app.mjs">',
  ];
  for (const html of unsupportedMarkup) {
    assert.throws(() => assertHtmlResources("index.html", html, assets));
  }
});

test("module resolution allows managed test-to-public imports and rejects unmanaged targets", async () => {
  const temporaryRoot = await createTemporaryRoot();
  try {
    await initializeProjectRoot(temporaryRoot);
    await mkdir(resolve(temporaryRoot, "public", "js", "core"), { recursive: true });
    await mkdir(resolve(temporaryRoot, "scripts"), { recursive: true });
    await mkdir(resolve(temporaryRoot, "test"), { recursive: true });
    await mkdir(resolve(temporaryRoot, "docs"), { recursive: true });
    await writeFile(
      resolve(temporaryRoot, "public", "js", "core", "color.mjs"),
      "export const parse = () => null;\n",
    );
    const testSource = resolve(temporaryRoot, "test", "scaffold.test.mjs");
    await writeFile(testSource, "import test from 'node:test';\n");
    await writeFile(
      resolve(temporaryRoot, "docs", "ENGINEERING.md"),
      "documentation is not an executable module\n",
    );

    const publicAssets = await collectPublicAssets(temporaryRoot);
    const managedSources = new Set(
      (await collectNodeSources(temporaryRoot, publicAssets)).map((path) => resolve(path)),
    );
    await assert.doesNotReject(assertModuleReference(
      "../public/js/core/color.mjs",
      testSource,
      temporaryRoot,
      publicAssets.publicRoot,
      managedSources,
    ));
    await assert.rejects(assertModuleReference(
      "../docs/ENGINEERING.md",
      testSource,
      temporaryRoot,
      publicAssets.publicRoot,
      managedSources,
    ), /managed JavaScript source/u);
    await assert.rejects(assertModuleReference(
      "../public/js/core/missing.mjs",
      testSource,
      temporaryRoot,
      publicAssets.publicRoot,
      managedSources,
    ), /missing, linked/u);
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
});

test("build preflight refuses linked dist descendants before cleanup", async () => {
  const temporaryRoot = await createTemporaryRoot();
  const outside = resolve(temporaryRoot, "outside");
  const linkedOutput = resolve(temporaryRoot, "dist", "linked");
  try {
    await initializeProjectRoot(temporaryRoot);
    await mkdir(outside, { recursive: true });
    await writeFile(resolve(outside, "keep.txt"), "preserve this file\n");
    await mkdir(resolve(temporaryRoot, "dist"), { recursive: true });
    await symlink(outside, linkedOutput, "junction");

    await assert.rejects(preflightBuild(temporaryRoot), /dist tree contains a link/u);
    assert.equal(await readFile(resolve(outside, "keep.txt"), "utf8"), "preserve this file\n");
  } finally {
    try {
      const info = await lstat(linkedOutput);
      if (info.isSymbolicLink()) await unlink(linkedOutput);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await removeTemporaryRoot(temporaryRoot);
  }
});

test("temporary helpers reject linked parents and descendants before cleanup", async () => {
  const temporaryRoot = await createTemporaryRoot();
  const outside = resolve(temporaryRoot, "outside");
  const linkedParent = resolve(temporaryRoot, "linked-parent");
  const linkedDescendant = resolve(temporaryRoot, "linked-descendant");
  try {
    await mkdir(outside, { recursive: true });
    await writeFile(resolve(outside, "keep.txt"), "preserve this file\n");
    await symlink(outside, linkedParent, "junction");
    await assert.rejects(createTemporaryRoot(linkedParent), /linked|physical/u);
    await assert.rejects(
      removeTemporaryRoot(resolve(linkedParent, "child"), linkedParent),
      /linked|physical/u,
    );
    await symlink(outside, linkedDescendant, "junction");
    await assert.rejects(removeTemporaryRoot(temporaryRoot), /linked descendants/u);
    assert.equal(await readFile(resolve(outside, "keep.txt"), "utf8"), "preserve this file\n");
  } finally {
    for (const linkPath of [linkedParent, linkedDescendant]) {
      try {
        const info = await lstat(linkPath);
        if (info.isSymbolicLink()) await unlink(linkPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await removeTemporaryRoot(temporaryRoot);
  }
});

test("runtime checker allows explicit output APIs and rejects unsafe alternatives", () => {
  assert.doesNotThrow(() => assertSafeRuntimeSource(
    "navigator.clipboard.writeText(css); new Blob([css]); URL.createObjectURL(blob); preview.style.backgroundColor = validatedHex;",
  ));

  for (const source of [
    "navigator.clipboard.readText();",
    "fetch('/remote');",
    "element.innerHTML = value;",
    "new Function('return 1')();",
  ]) {
    assert.throws(() => assertSafeRuntimeSource(source));
  }
});
