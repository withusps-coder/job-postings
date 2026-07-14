import { existsSync, readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isJsonObject } from "./data-validation-utils.mjs";
import {
  validateDraftJob,
  validatePublishedCollection,
} from "./job-data-validation.mjs";

const maximumImageBytes = 2 * 1024 * 1024;

/** @typedef {import("./data-validation-utils.mjs").ValidationError} ValidationError */

/** @param {readonly unknown[]} jobs @param {string} root @returns {Promise<import("./data-validation-utils.mjs").ValidationResult>} */
export async function validatePublishedData(jobs, root) {
  const schemaResult = validatePublishedCollection(jobs);
  if (!schemaResult.valid) return { valid: false, errors: schemaResult.errors };
  /** @type {ValidationError[]} */
  const errors = [];
  for (const [index, job] of jobs.entries()) {
    if (!isJsonObject(job) || !isJsonObject(job["company"])) continue;
    for (const key of ["logo", "heroImage"]) {
      const asset = job["company"][key];
      if (typeof asset !== "string") continue;
      const result = await validateLocalAsset(asset, root, true, "src/assets");
      if (!result.valid)
        errors.push({
          instancePath: `/jobs/${index}/company/${key}`,
          message: result.message,
        });
    }
    const mapImage = job["mapImage"];
    if (typeof mapImage === "string") {
      const result = await validateLocalAsset(
        mapImage,
        root,
        true,
        "src/assets",
      );
      if (!result.valid)
        errors.push({
          instancePath: `/jobs/${index}/mapImage`,
          message: result.message,
        });
    }
    if (!Array.isArray(job["documents"])) continue;
    for (const [documentIndex, document] of job["documents"].entries()) {
      if (
        !isJsonObject(document) ||
        typeof document["url"] !== "string" ||
        document["url"].startsWith("https://")
      )
        continue;
      const result = await validateLocalAsset(
        document["url"],
        root,
        false,
        "src/assets",
      );
      if (!result.valid)
        errors.push({
          instancePath: `/jobs/${index}/documents/${documentIndex}/url`,
          message: result.message,
        });
    }
  }
  if (errors.length === 0) return { valid: true, errors: [] };
  return { valid: false, errors };
}

/** @param {unknown} draft @param {string} root @returns {Promise<import("./data-validation-utils.mjs").ValidationResult>} */
export async function validateDraftData(draft, root) {
  const schemaResult = validateDraftJob(draft);
  if (!schemaResult.valid) return { valid: false, errors: schemaResult.errors };
  if (!isJsonObject(draft) || !isJsonObject(draft["company"])) {
    return {
      valid: false,
      errors: [{ instancePath: "/company", message: "must be an object" }],
    };
  }
  /** @type {ValidationError[]} */
  const errors = [];
  for (const key of ["logo", "heroImage"]) {
    const asset = draft["company"][key];
    if (typeof asset === "string" && !asset.startsWith("https://")) {
      const result = await validateLocalAsset(asset, root, true, "");
      if (!result.valid)
        errors.push({
          instancePath: `/company/${key}`,
          message: result.message,
        });
    }
  }
  const mapImage = draft["mapImage"];
  if (typeof mapImage === "string" && !mapImage.startsWith("https://")) {
    const result = await validateLocalAsset(mapImage, root, true, "");
    if (!result.valid)
      errors.push({ instancePath: "/mapImage", message: result.message });
  }
  if (Array.isArray(draft["documents"])) {
    for (const [index, document] of draft["documents"].entries()) {
      if (
        !isJsonObject(document) ||
        typeof document["url"] !== "string" ||
        document["url"].startsWith("https://")
      )
        continue;
      const result = await validateLocalAsset(document["url"], root, false, "");
      if (!result.valid)
        errors.push({
          instancePath: `/documents/${index}/url`,
          message: result.message,
        });
    }
  }
  if (errors.length === 0) return { valid: true, errors: [] };
  return { valid: false, errors };
}

/** @param {string} asset @param {string} root @param {boolean} image @param {string} allowedDirectory */
async function validateLocalAsset(asset, root, image, allowedDirectory) {
  const candidate = resolve(root, asset);
  const allowedRoot = resolve(root, allowedDirectory);
  if (!candidate.startsWith(`${allowedRoot}/`) || !existsSync(candidate))
    return {
      valid: false,
      message: "must reference an existing allowed local asset",
    };
  if (!image)
    return hasPdfSignature(candidate)
      ? { valid: true, message: "" }
      : { valid: false, message: "must be a PDF asset" };
  if ((await stat(candidate)).size > maximumImageBytes)
    return { valid: false, message: "must not exceed 2 MiB" };
  return (await hasImageSignature(candidate))
    ? { valid: true, message: "" }
    : { valid: false, message: "must be a PNG, JPEG, or WebP asset" };
}

/** @param {string} path */
async function hasImageSignature(path) {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(12);
    await handle.read(bytes, 0, bytes.length, 0);
    return (
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
      (bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
        bytes.subarray(8, 12).equals(Buffer.from("WEBP")))
    );
  } finally {
    await handle.close();
  }
}

/** @param {string} path */
function hasPdfSignature(path) {
  return readFileSync(path).subarray(0, 5).equals(Buffer.from("%PDF-"));
}
