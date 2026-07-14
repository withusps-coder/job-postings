import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPublishedJobs,
  validateDraftJob,
  validateFixture,
  validatePublishedCollection,
  validatePublishedJob,
  validatePublishedRevision,
  validateStatusTransition,
} from "./job-data-validation.mjs";
import {
  validateDraftData,
  validatePublishedData,
} from "./job-asset-validation.mjs";
import { validateSite } from "./site-data-validation.mjs";

export {
  validateDraftJob,
  validateDraftData,
  validateFixture,
  validatePublishedCollection,
  validatePublishedData,
  validatePublishedJob,
  validatePublishedRevision,
  validateSite,
  validateStatusTransition,
};

const rootDirectory = fileURLToPath(new URL("../", import.meta.url));
const defaultJobsDirectory = resolve(rootDirectory, "src/jobs");

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {readonly unknown[]} jobs
 * @param {string} company
 * @returns {Record<string, unknown>[]}
 */
export function filterJobsByCompany(jobs, company) {
  return jobs.reduce(
    /**
     * @param {Record<string, unknown>[]} matches
     * @param {unknown} job
     */
    (matches, job) => {
      if (!isObjectRecord(job)) return matches;
      const id = job["id"];
      if (
        typeof id === "string" &&
        (id === company || id.startsWith(`${company}-`))
      )
        matches.push(job);
      return matches;
    },
    /** @type {Record<string, unknown>[]} */ ([]),
  );
}

/** @param {readonly string[]} arguments_ @param {string} option */
function optionValue(arguments_, option) {
  const index = arguments_.findIndex((argument) => argument === option);
  return index === -1 ? undefined : arguments_[index + 1];
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const file = optionValue(arguments_, "--file");
  const company = optionValue(arguments_, "--company");
  const isDraft = arguments_.includes("--draft");
  const isSite = arguments_.includes("--site");
  const isCollection = arguments_.includes("--collection");
  if (file) {
    const input = JSON.parse(await readFile(resolve(file), "utf8"));
    const result = isSite
      ? validateSite(input)
      : isCollection && Array.isArray(input)
        ? validatePublishedCollection(input)
        : (isDraft ? validateDraftJob : validatePublishedJob)(input);
    if (!result.valid) {
      for (const error of result.errors)
        console.error(`${error.instancePath}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Validated ${isSite ? "site" : isCollection ? "published collection" : isDraft ? "draft" : "published"} fixture.`,
    );
    return;
  }

  const allJobs = await loadPublishedJobs(defaultJobsDirectory);
  const jobs = company ? filterJobsByCompany(allJobs, company) : allJobs;
  if (company && jobs.length === 0) {
    console.error(`No published jobs matched company filter: ${company}.`);
    process.exitCode = 1;
    return;
  }
  const siteResult = validateSite(
    JSON.parse(
      await readFile(resolve(rootDirectory, "src/_data/site.json"), "utf8"),
    ),
  );
  const dataResult = await validatePublishedData(jobs, rootDirectory);
  const errors = [...siteResult.errors, ...dataResult.errors];
  if (errors.length > 0) {
    for (const error of errors)
      console.error(`${error.instancePath}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const collectionResult = validatePublishedCollection(jobs);
  if (!collectionResult.valid) process.exitCode = 1;
  const open = jobs.filter(
    (job) => isObjectRecord(job) && job["status"] === "open",
  ).length;
  const statuses = jobs
    .filter(isObjectRecord)
    .map((job) => `${job["slug"]}=${job["status"]}`)
    .join(", ");
  const filterLabel = company ? ` for company ${company}` : "";
  console.log(
    `Validated published data${filterLabel}: ${jobs.length} jobs (${open} open, ${jobs.length - open} closed): ${statuses}.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
