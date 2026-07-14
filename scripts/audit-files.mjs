import { lstat, open, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const binaryExtensions = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

/** @param {readonly string[]} roots */
export async function collectRegularFiles(roots) {
  /** @type {string[]} */
  const files = [];

  for (const root of roots) {
    await visit(root, files);
  }

  return files.sort();
}

/** @param {string} path @param {string[]} files */
async function visit(path, files) {
  let metadata;

  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (metadata.isSymbolicLink()) {
    return;
  }

  if (metadata.isFile()) {
    files.push(path);
    return;
  }

  if (!metadata.isDirectory()) {
    return;
  }

  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    await visit(join(path, entry.name), files);
  }
}

/** @param {string} path */
export async function isBinaryFile(path) {
  if (binaryExtensions.has(extname(path).toLowerCase())) {
    return true;
  }

  const handle = await open(path, "r");
  try {
    const bytes = new Uint8Array(8_192);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const sample = bytes.subarray(0, bytesRead);

    if (sample.includes(0)) {
      return true;
    }

    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample);
      return false;
    } catch {
      return true;
    }
  } finally {
    await handle.close();
  }
}
