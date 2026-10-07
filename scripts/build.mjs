import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPublicAssets, runProjectCheck } from "./check.mjs";
import { cloudflarePolicy } from "./cloudflare.mjs";
import { parseReleaseArgs, productionHtml, releasePolicy } from "./release.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

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

async function inspectExistingDist(projectRoot, distPath) {
  const expectedDist = resolve(projectRoot, "dist");
  if (!samePath(distPath, expectedDist) || relative(projectRoot, distPath) !== "dist") {
    throw new Error("The build output must be exactly the project dist directory.");
  }

  let info;
  try {
    info = await lstat(distPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("The existing dist output could not be inspected.");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("The dist output cannot be a link or a non-directory.");
  }

  const canonicalDist = await resolvePhysicalDirectory(distPath);
  if (
    !canonicalDist ||
    !isPathInside(projectRoot, canonicalDist) ||
    samePath(projectRoot, canonicalDist)
  ) {
    throw new Error("The dist output or one of its ancestors is linked or outside the project.");
  }

  async function rejectLinkedDescendants(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = resolve(directory, entry.name);
      const childInfo = await lstat(childPath);
      if (childInfo.isSymbolicLink()) {
        throw new Error("The existing dist tree contains a link.");
      }
      if (childInfo.isDirectory()) {
        await rejectLinkedDescendants(childPath);
      } else if (!childInfo.isFile()) {
        throw new Error("The existing dist tree contains a non-file asset.");
      }
    }
  }
  await rejectLinkedDescendants(canonicalDist);
  return true;
}

export async function preflightBuild(projectPath = PROJECT_ROOT) {
  const requestedRoot = resolve(projectPath);
  const projectRoot = await resolvePhysicalDirectory(requestedRoot);
  if (!projectRoot || !samePath(projectRoot, requestedRoot)) {
    throw new Error("The project root or one of its ancestors is linked or unavailable.");
  }

  const publicAssets = await collectPublicAssets(projectRoot);
  const distPath = resolve(projectRoot, "dist");
  const exactDistPath = resolve(projectRoot, "dist");
  if (!samePath(distPath, exactDistPath) || relative(projectRoot, distPath) !== "dist") {
    throw new Error("The build output must be exactly the project dist directory.");
  }
  const existingDist = await inspectExistingDist(projectRoot, distPath);

  for (const asset of publicAssets.files) {
    const destination = resolve(distPath, ...asset.relativePath.split("/"));
    if (!isPathInside(distPath, destination) || samePath(distPath, destination)) {
      throw new Error("A public asset path escapes dist.");
    }
  }
  return {
    projectRoot,
    publicRoot: publicAssets.publicRoot,
    distPath,
    files: publicAssets.files,
    existingDist,
  };
}

async function verifyBuildOutput(distPath, expectedFiles) {
  const canonicalDist = await resolvePhysicalDirectory(distPath);
  if (!canonicalDist || !samePath(canonicalDist, distPath)) {
    throw new Error("The built dist directory is linked or unavailable.");
  }

  const actualFiles = new Map();
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = resolve(directory, entry.name);
      const info = await lstat(childPath);
      if (info.isSymbolicLink()) throw new Error("The built dist tree contains a link.");
      if (info.isDirectory()) {
        await visit(childPath);
      } else if (info.isFile()) {
        const relativePath = relative(canonicalDist, childPath).split(sep).join("/");
        actualFiles.set(relativePath, childPath);
      } else {
        throw new Error("The built dist tree contains a non-file asset.");
      }
    }
  }
  await visit(canonicalDist);

  if (actualFiles.size !== expectedFiles.size) {
    for (const relativePath of actualFiles.keys()) {
      if (!expectedFiles.has(relativePath)) throw new Error("Unexpected build file: " + relativePath);
    }
    for (const relativePath of expectedFiles.keys()) {
      if (!actualFiles.has(relativePath)) throw new Error("The built dist is missing " + relativePath + ".");
    }
    throw new Error("The built dist file list does not match the release allowlist.");
  }
  for (const [relativePath, expectedBytes] of expectedFiles) {
    const outputPath = actualFiles.get(relativePath);
    if (!outputPath) {
      throw new Error("The built dist is missing " + relativePath + ".");
    }
    const outputBytes = await readFile(outputPath);
    if (!expectedBytes.equals(outputBytes)) {
      throw new Error("The built file has unexpected bytes: " + relativePath);
    }
  }
  return actualFiles.size;
}

export async function buildProject({
  projectRoot = PROJECT_ROOT,
  production = false,
  cloudflare = false,
  siteUrl,
} = {}) {
  let seoPolicy;
  let generatedFiles = new Map();
  if (production) {
    if (!cloudflare || siteUrl === undefined) {
      throw new Error("Production build requires --production, --cloudflare, and --site-url.");
    }
    seoPolicy = releasePolicy(siteUrl);
    generatedFiles = new Map([
      ...cloudflarePolicy(siteUrl).files,
      ...seoPolicy.files,
    ]);
  } else if (cloudflare || siteUrl !== undefined) {
    throw new Error("Preview builds cannot use production flags.");
  }

  await runProjectCheck({ projectRoot });
  const plan = await preflightBuild(projectRoot);

  // Read and validate every output before cleaning the existing dist tree.
  const expectedFiles = new Map();
  for (const asset of plan.files) {
    const sourceInfo = await lstat(asset.sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new Error("A public source changed during build.");
    }
    const canonicalSource = await realpath(asset.sourcePath);
    if (
      !isPathInside(plan.publicRoot, canonicalSource) ||
      samePath(plan.publicRoot, canonicalSource)
    ) {
      throw new Error("A public source resolves outside public.");
    }
    const sourceBytes = await readFile(canonicalSource);
    const outputBytes = production && asset.extension === ".html"
      ? Buffer.from(productionHtml(sourceBytes.toString("utf8"), asset.relativePath, seoPolicy), "utf8")
      : sourceBytes;
    expectedFiles.set(asset.relativePath, outputBytes);
  }
  for (const [relativePath, contents] of generatedFiles) {
    expectedFiles.set(relativePath, Buffer.from(contents, "utf8"));
  }
  for (const relativePath of expectedFiles.keys()) {
    const destination = resolve(plan.distPath, ...relativePath.split("/"));
    if (!isPathInside(plan.distPath, destination) || samePath(plan.distPath, destination)) {
      throw new Error("A build destination escapes dist.");
    }
  }

  if (plan.existingDist) {
    await inspectExistingDist(plan.projectRoot, plan.distPath);
    await rm(plan.distPath, { recursive: true, force: false });
  }
  await mkdir(plan.distPath);

  const canonicalDist = await resolvePhysicalDirectory(plan.distPath);
  if (
    !canonicalDist ||
    !samePath(canonicalDist, plan.distPath) ||
    !isPathInside(plan.projectRoot, canonicalDist) ||
    samePath(plan.projectRoot, canonicalDist)
  ) {
    throw new Error("The new dist output is not a regular project directory.");
  }

  for (const [relativePath, contents] of expectedFiles) {
    const destination = resolve(canonicalDist, ...relativePath.split("/"));
    if (!isPathInside(canonicalDist, destination) || samePath(canonicalDist, destination)) {
      throw new Error("A build destination escapes dist.");
    }
    await mkdir(dirname(destination), { recursive: true });
    const parentDirectory = await resolvePhysicalDirectory(dirname(destination));
    if (!parentDirectory || !isPathInside(canonicalDist, parentDirectory)) {
      throw new Error("A build destination has a linked or invalid parent directory.");
    }
    await writeFile(destination, contents, { flag: "wx" });
  }

  const fileCount = await verifyBuildOutput(canonicalDist, expectedFiles);
  return { outputPath: canonicalDist, fileCount };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseReleaseArgs(process.argv.slice(2));
    const result = await buildProject(options);
    process.stdout.write(
      `Built and byte-verified ${result.fileCount} ${options.production ? "production release files" : "preview assets"} in dist.\n`,
    );
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "Build failed.") + "\n");
    process.exitCode = 1;
  }
}
