import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  filterJobsByCompany,
  validateDraftJob,
  validateDraftData,
  validatePublishedCollection,
  validatePublishedData,
  validatePublishedJob,
  validatePublishedRevision,
  validateSite,
  validateStatusTransition,
} from "../scripts/validate-data.mjs";

/** @param {string} name */
const fixture = (name) =>
  readFile(
    fileURLToPath(new URL(`./fixtures/data/${name}`, import.meta.url)),
    "utf8",
  ).then(JSON.parse);

test("Given a minimal published job, when validated, then it is accepted", async () => {
  const result = validatePublishedJob(await fixture("valid-minimal.json"));

  assert.equal(result.valid, true);
});

test("Given company-prefixed job ids, when filtered, then only that company's exact job family remains", () => {
  const jobs = [
    { id: "mildo", status: "open" },
    { id: "mildo-design", status: "closed" },
    { id: "mild", status: "open" },
  ];

  assert.deepEqual(
    filterJobsByCompany(jobs, "mildo").map((job) => job["id"]),
    ["mildo", "mildo-design"],
  );
});

test("Given a rich published job, when validated, then every structured section is accepted", async () => {
  const result = validatePublishedJob(await fixture("valid-rich.json"));

  assert.equal(result.valid, true);
});

test("Given a draft with an HTTPS image source, when validated, then it is accepted only in draft form", async () => {
  const draft = await fixture("valid-draft-remote-image.json");
  const published = await fixture("valid-minimal.json");
  published.company.logo = draft.company.logo;

  assert.equal(validateDraftJob(draft).valid, true);
  assert.equal(validatePublishedJob(published).valid, false);
});

test("Given unsafe values, when validated, then exact pointers are returned without echoing input", async () => {
  const job = await fixture("valid-minimal.json");
  job.slug = "../unsafe";
  job.title = "<script>unsafe</script>";

  const result = validatePublishedJob(job);

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map((error) => error.instancePath),
    ["/slug", "/title"],
  );
  assert.equal(JSON.stringify(result.errors).includes("<script>"), false);
});

test("Given required fields, optional fields, URLs, and invented salary, when validated, then the boundary is exact", async () => {
  const required = await fixture("valid-minimal.json");
  delete required.title;
  const httpUrl = await fixture("valid-minimal.json");
  httpUrl.company.website = "http://example.com";
  const salary = await fixture("valid-minimal.json");
  salary.salary = "invented";

  assert.deepEqual(validatePublishedJob(required).errors[0]?.instancePath, "/");
  assert.deepEqual(
    validatePublishedJob(httpUrl).errors[0]?.instancePath,
    "/company/website",
  );
  assert.deepEqual(validatePublishedJob(salary).errors[0]?.instancePath, "/");
});

test("Given duplicate identifiers and an authorization or closed-state breach, when validating, then publication fails closed", async () => {
  const first = await fixture("valid-minimal.json");
  const duplicate = await fixture("valid-minimal.json");
  duplicate.title = "Different role";
  const unauthorized = await fixture("valid-minimal.json");
  delete unauthorized.publisherAuthorization;
  const closed = await fixture("valid-minimal.json");
  closed.status = "closed";

  assert.equal(
    validatePublishedCollection([first, duplicate]).errors[0]?.instancePath,
    "/jobs/1/id",
  );
  assert.equal(validatePublishedJob(unauthorized).valid, false);
  assert.equal(validatePublishedJob(closed).errors.at(-1)?.instancePath, "/");
  assert.equal(validateStatusTransition("open", "closed").valid, true);
  assert.equal(validateStatusTransition("closed", "open").valid, true);
  assert.equal(validateStatusTransition("open", "open").valid, false);
  const changedSlug = structuredClone(first);
  changedSlug.slug = "changed-slug";
  assert.equal(
    validatePublishedRevision(first, changedSlug).errors[0]?.instancePath,
    "/slug",
  );
});

test("Given local, remote, missing, oversized, and PDF assets, when validating publication, then published assets stay local and bounded", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "job-data-"));
  context.after(async () => rm(root, { force: true, recursive: true }));
  const imagePath = join(root, "src/assets/jobs/sample/logo.png");
  const pdfPath = join(root, "src/assets/jobs/sample/profile.pdf");
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(pdfPath, "%PDF-safe", "utf8");
  const job = await fixture("valid-minimal.json");
  job.company.logo = "src/assets/jobs/sample/logo.png";
  job.documents = [
    { label: "Profile", url: "src/assets/jobs/sample/profile.pdf" },
  ];

  assert.equal((await validatePublishedData([job], root)).valid, true);
  job.mapImage = "src/assets/jobs/sample/missing-map.jpg";
  assert.equal(
    (await validatePublishedData([job], root)).errors[0]?.instancePath,
    "/jobs/0/mapImage",
  );
  delete job.mapImage;
  job.company.logo = "src/assets/jobs/sample/missing.png";
  assert.equal(
    (await validatePublishedData([job], root)).errors[0]?.instancePath,
    "/jobs/0/company/logo",
  );
  await writeFile(imagePath, Buffer.alloc(2 * 1024 * 1024 + 1));
  job.company.logo = "src/assets/jobs/sample/logo.png";
  assert.equal(
    (await validatePublishedData([job], root)).errors[0]?.message,
    "must not exceed 2 MiB",
  );
  job.documents[0].url = "http://example.com/profile.pdf";
  assert.equal(validatePublishedJob(job).valid, false);
});

test("Given site contact data and draft assets, when alternate contact or unsafe paths are introduced, then strict models reject them", async () => {
  const site = JSON.parse(
    await readFile(new URL("../src/_data/site.json", import.meta.url), "utf8"),
  );
  const alternateContact = structuredClone(site);
  alternateContact.alternateContact = site.contactEmail;
  const draft = await fixture("valid-draft-remote-image.json");
  draft.company.logo = "ablearn-b2b/logo-ablearn.png";
  const traversalDraft = structuredClone(draft);
  traversalDraft.company.logo = "../logo.png";
  const traversalPdfDraft = structuredClone(draft);
  traversalPdfDraft.documents = [
    { label: "Profile", url: "src/assets/x/../brand/file.pdf" },
  ];
  draft.documents = [
    { label: "Profile", url: "ablearn-b2b/ablearn-company-profile.pdf" },
  ];

  assert.equal(validateSite(site).valid, true);
  assert.equal(validateSite(alternateContact).valid, false);
  assert.equal(validateDraftJob(draft).valid, true);
  assert.equal((await validateDraftData(draft, process.cwd())).valid, true);
  assert.equal(
    validateDraftJob(traversalDraft).errors[0]?.instancePath,
    "/company/logo",
  );
  assert.equal(
    validateDraftJob(traversalPdfDraft).errors[0]?.instancePath,
    "/documents/0/url",
  );
});

test("Given dot-segment assets and hostless HTTPS values, when validated, then every unsafe reference fails closed", async () => {
  const assetTraversal = await fixture("valid-minimal.json");
  assetTraversal.company.logo = "src/assets/x/../brand/favicon.png";
  const hostlessWebsite = await fixture("valid-minimal.json");
  hostlessWebsite.company.website = "https:///";
  const hostlessDraft = await fixture("valid-draft-remote-image.json");
  hostlessDraft.company.logo = "https:///logo.png";

  assert.equal(
    validatePublishedJob(assetTraversal).errors[0]?.instancePath,
    "/company/logo",
  );
  assert.equal(
    validatePublishedJob(hostlessWebsite).errors[0]?.instancePath,
    "/company/website",
  );
  assert.equal(
    validateDraftJob(hostlessDraft).errors[0]?.instancePath,
    "/company/logo",
  );
});

test("Given altered contact or approval receipts, when site data is validated, then immutable approval facts are enforced", async () => {
  const site = JSON.parse(
    await readFile(new URL("../src/_data/site.json", import.meta.url), "utf8"),
  );
  const markupContact = structuredClone(site);
  markupContact.contactEmail = `<${site.contactEmail}>`;
  const unapprovedReceipt = structuredClone(site);
  unapprovedReceipt.approvalReceipt.contactConfirmed = false;
  const changedApprovalDate = structuredClone(site);
  changedApprovalDate.approvalReceipt.approvedAt = "2026-99-99";

  assert.equal(validateSite(markupContact).valid, false);
  assert.equal(
    validateSite(unapprovedReceipt).errors.at(-1)?.instancePath,
    "/approvalReceipt",
  );
  assert.equal(
    validateSite(changedApprovalDate).errors.at(-1)?.instancePath,
    "/approvalReceipt",
  );
});
