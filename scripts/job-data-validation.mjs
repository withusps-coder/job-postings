import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { emptySiteSchema } from "./fixture-schema.mjs";
import { isJsonObject, validateWithSchema } from "./data-validation-utils.mjs";
import { validateJobUrls } from "../src/validation/job-urls.js";

const rootDirectory = fileURLToPath(new URL("../", import.meta.url));
/** @param {string} path @returns {import("ajv").AnySchema} */
const parseJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const createAjv = () => new Ajv2020({ allErrors: true, strict: true });
const publishedValidator = createAjv().compile(
  parseJson(resolve(rootDirectory, "src/schema/job.schema.json")),
);
const draftValidator = createAjv().compile(
  parseJson(resolve(rootDirectory, "src/schema/job-draft.schema.json")),
);
const fixtureValidator = createAjv().compile(emptySiteSchema);

/** @param {unknown} input @returns {import("./data-validation-utils.mjs").ValidationResult} */
export function validatePublishedJob(input) {
  const result = validateWithSchema(input, publishedValidator);
  return result.valid ? validateUrls(input) : result;
}

/** @param {unknown} input @returns {import("./data-validation-utils.mjs").ValidationResult} */
export function validateDraftJob(input) {
  const result = validateWithSchema(input, draftValidator);
  return result.valid ? validateUrls(input) : result;
}

/** @param {unknown} input @returns {import("./data-validation-utils.mjs").ValidationResult} */
export function validateFixture(input) {
  return validateWithSchema(input, fixtureValidator);
}

/** @param {unknown} input @returns {import("./data-validation-utils.mjs").ValidationResult} */
function validateUrls(input) {
  const errors = validateJobUrls(input);
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

/** @param {readonly unknown[]} jobs @returns {import("./data-validation-utils.mjs").ValidationResult} */
export function validatePublishedCollection(jobs) {
  /** @type {import("./data-validation-utils.mjs").ValidationError[]} */
  const errors = [];
  const ids = new Set();
  const slugs = new Set();
  for (const [index, job] of jobs.entries()) {
    const result = validatePublishedJob(job);
    errors.push(
      ...result.errors.map((error) => ({
        instancePath: `/jobs/${index}${error.instancePath === "/" ? "" : error.instancePath}`,
        message: error.message,
      })),
    );
    if (!isJsonObject(job)) continue;
    const id = job["id"];
    if (typeof id === "string") {
      if (ids.has(id))
        errors.push({
          instancePath: `/jobs/${index}/id`,
          message: "must be unique",
        });
      ids.add(id);
    }
    const slug = job["slug"];
    if (typeof slug === "string") {
      if (slugs.has(slug))
        errors.push({
          instancePath: `/jobs/${index}/slug`,
          message: "must be unique",
        });
      slugs.add(slug);
    }
  }
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

/** @param {"open" | "closed"} previous @param {"open" | "closed"} next @returns {import("./data-validation-utils.mjs").ValidationResult} */
export function validateStatusTransition(previous, next) {
  return previous === next
    ? {
        valid: false,
        errors: [{ instancePath: "/status", message: "must change state" }],
      }
    : { valid: true, errors: [] };
}

/** @param {unknown} previous @param {unknown} next @returns {import("./data-validation-utils.mjs").ValidationResult} */
export function validatePublishedRevision(previous, next) {
  if (!isJsonObject(previous) || !isJsonObject(next))
    return {
      valid: false,
      errors: [{ instancePath: "/", message: "must compare published jobs" }],
    };
  const errors = ["id", "slug"].flatMap((key) =>
    previous[key] === next[key]
      ? []
      : [{ instancePath: `/${key}`, message: "is immutable" }],
  );
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

/** @param {string} directory */
export async function loadPublishedJobs(directory) {
  if (!existsSync(directory)) return [];
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => parseJson(resolve(directory, entry.name)));
}
