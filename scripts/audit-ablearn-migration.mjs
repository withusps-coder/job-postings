import { verifyMediaBytes } from "../functions/_lib/media.js";
import { buildRevisionSnapshot } from "../functions/_lib/snapshot.js";
import {
  createApplyMailto,
  publicSite,
  renderJobDetail,
} from "../src/_includes/render/public-pages.js";

const applicationProvenance =
  "src/_data/site.json.contactEmail via createApplyMailto fallback; no official URL";
const inventoryAuthority =
  "Reviewed preservation evidence and non-authoritative one-time migration input. D1 active revisions are the sole authority after cutover.";

/**
 * @typedef {"company-logo" | "company-map" | "company-document"} AssetRole
 * @typedef {{ role: AssetRole, assetId: string, source: string, mimeType: string, byteLength: number, sha256: string }} ReviewedAsset
 * @typedef {{ companyId: string, jobId: string, revisionId: string, createdAt: string }} MigrationIdentity
 * @typedef {{ kind: "email", value: string, provenance: string }} ApplicationEvidence
 * @typedef {{ label: string, value: string }} JobStat
 * @typedef {{ label: string, url: string }} JobLink
 * @typedef {{ label: string, assetRole: AssetRole }} NormalizedDocument
 * @typedef {{ stats: JobStat[], company: string[], news: JobLink[], responsibilities: string[], qualifications: string[], preferred: string[], benefits: string[], conditions: string[], process: string[], notes: string[] }} NormalizedSections
 * @typedef {{ name: string, website: string, summary: string }} NormalizedCompany
 * @typedef {{ authorized: true, scope: "published-job", attestedAt: string }} PublisherAuthorization
 * @typedef {{ slug: string, status: "open" | "closed", datePosted: string, publisherAuthorization: PublisherAuthorization, title: string, category: string, company: NormalizedCompany, employment: string, location: string, mapQuery: string, remote: "onsite" | "hybrid" | "remote", experience: string, tags: string[], sections: NormalizedSections, documents: NormalizedDocument[], application: ApplicationEvidence }} NormalizedJob
 * @typedef {{ migration: MigrationIdentity, assets: ReviewedAsset[], job: NormalizedJob, legacy: { headings: string[], links: number, listItems: number }, render: { snapshotHash: string, headings: string[], applicationMailto: string, media: Record<AssetRole, string>, contentLinks: string[] }, normalizations: string[] }} ReviewedInventory
 * @typedef {{ draftJson: Record<string, unknown>, companySnapshotJson: NormalizedCompany, applicationJson: ApplicationEvidence }} MigrationDraft
 * @typedef {{ role: AssetRole, source: string, assetId: string, media: import("../functions/_lib/media.js").VerifiedMedia }} MigrationAsset
 * @typedef {{ headings: string[], linkUrls: string[], listItems: number, listItemText: string[], benefitText: string[] }} LegacyInventory
 * @typedef {{ headings: string[], links: string[] }} RenderedInventory
 * @typedef {{ schemaVersion: number, id: string, slug: string, status: "open" | "closed", datePosted: string, publisherAuthorization: PublisherAuthorization, title: string, category: string, company: { name: string, website: string, summary: string, logo: string }, employment: string, location: string, mapQuery: string, remote: "onsite" | "hybrid" | "remote", experience: string, tags: string[], sections: NormalizedSections, documents: { label: string, url: string }[] }} RendererJob
 */

/**
 * @typedef {(path: string, encoding?: "utf8") => Promise<unknown>} EvidenceFileReader
 */

/** @param {URL} url */
function moduleDirectoryPath(url) {
  const pathname = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//u.test(pathname) ? pathname.slice(1) : pathname;
}
function defaultBaseDirectory() {
  return moduleDirectoryPath(new URL("../", import.meta.url));
}

function isDirectExecution() {
  try {
    return (
      typeof process !== "undefined" &&
      Array.isArray(process.argv) &&
      process.argv[1] === moduleDirectoryPath(new URL(import.meta.url))
    );
  } catch {
    return false;
  }
}

/** @param {string} base @param {string} relative */
function joinPath(base, relative) {
  return `${base.replace(/[\\\\/]$/u, "")}/${relative}`;
}

/** @type {EvidenceFileReader} */
async function defaultReadFile(path, encoding) {
  const nodeFileSystem = "node:fs/promises";
  const { readFile } = await import(nodeFileSystem);
  return encoding === "utf8"
    ? readFile(path, "utf8")
    : new Uint8Array(await readFile(path));
}

/** A stable failure for malformed or incomplete preservation evidence. */
export class AblearnMigrationEvidenceError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.code = "ABLEARN_MIGRATION_EVIDENCE_INVALID";
  }
}

/** @param {string} html */
function plainText(html) {
  return html
    .replace(/<br\s*\/?\s*>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

/** @param {string} html @returns {LegacyInventory} */
function legacyInventory(html) {
  const content =
    (html.split("<!-- COMPANY STATS -->")[1] ?? html).split(
      "<!-- CONTACT CTA -->",
    )[0] ?? "";
  const headings = [...content.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/giu)]
    .map((match) => plainText(match[1] ?? ""))
    .filter((heading) => heading.length > 0);
  const linkUrls = [
    ...content.matchAll(/<a\s+[^>]*href=["']([^"']+)["']/giu),
  ].map((match) => match[1] ?? "");
  const listItems = [...content.matchAll(/<li(?:\s|>)/giu)].length;
  const listItemText = [...content.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)]
    .map((match) => plainText(match[1] ?? ""))
    .filter((item) => item.length > 0);
  const benefitText = [
    ...content.matchAll(
      /<div\s+class="benefit-(?:title|desc)">([\s\S]*?)<\/div>/giu,
    ),
  ]
    .map((match) => plainText(match[1] ?? ""))
    .filter((item) => item.length > 0);
  return { headings, linkUrls, listItems, listItemText, benefitText };
}

/** @param {string} html @returns {RenderedInventory} */
function renderedInventory(html) {
  return {
    headings: [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/giu)]
      .map((match) => plainText(match[1] ?? ""))
      .filter((heading) => heading.length > 0),
    links: [...html.matchAll(/<a\s+[^>]*href="([^"]+)"/giu)].map(
      (match) => match[1] ?? "",
    ),
  };
}

/** @param {string} value */
function comparisonText(value) {
  return value.toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
}

/** @param {unknown} value @returns {string} */
function flatten(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join(" ");
  if (value !== null && typeof value === "object") {
    return Object.values(value).map(flatten).join(" ");
  }
  return "";
}

/** @param {string} path @param {EvidenceFileReader} fileReader @returns {Promise<unknown>} */
async function readJson(path, fileReader) {
  try {
    const content = await fileReader(path, "utf8");
    if (typeof content !== "string") throw new TypeError("Expected text");
    return JSON.parse(content);
  } catch {
    throw new AblearnMigrationEvidenceError(`Unable to parse ${path}.`);
  }
}

/** @param {string} path @param {EvidenceFileReader} fileReader @returns {Promise<string>} */
async function readText(path, fileReader) {
  try {
    const content = await fileReader(path, "utf8");
    if (typeof content !== "string") throw new TypeError("Expected text");
    return content;
  } catch {
    throw new AblearnMigrationEvidenceError(`Unable to read ${path}.`);
  }
}

/**
 * Loads reviewed, non-authoritative migration input. The retired runtime source JSON
 * is deliberately never read: the fixture carries the complete normalized job,
 * application provenance, and asset-byte evidence that the one-time importer uses.
 *
 * @param {string} [baseDirectory]
 * @param {EvidenceFileReader} [fileReader]
 * @returns {Promise<{ baseDirectory: string, inventory: ReviewedInventory, normalizedJob: NormalizedJob, assets: MigrationAsset[], snapshot: import("../functions/_lib/snapshot.js").RevisionSnapshot, legacy: LegacyInventory, rendered: RenderedInventory, renderedHtml: string }>}
 */
export async function readAblearnMigrationEvidence(
  baseDirectory = defaultBaseDirectory(),
  fileReader = defaultReadFile,
) {
  const [fixture, legacyHtml] = await Promise.all([
    readJson(
      joinPath(
        baseDirectory,
        "tests/fixtures/ablearn-migration-inventory.json",
      ),
      fileReader,
    ),
    readText(
      joinPath(baseDirectory, "ablearn-strategy/index.html"),
      fileReader,
    ),
  ]);
  const inventory = validateInventory(fixture);
  const assets = await Promise.all(
    inventory.assets.map(async (asset) => {
      const sourceBytes = await fileReader(
        joinPath(baseDirectory, asset.source),
      );
      if (
        !(sourceBytes instanceof Uint8Array) &&
        !(sourceBytes instanceof ArrayBuffer)
      ) {
        throw new AblearnMigrationEvidenceError(
          `Unable to read ${asset.source}.`,
        );
      }
      const bytes = new Uint8Array(sourceBytes);
      let media;
      try {
        media = await verifyMediaBytes(bytes, asset);
      } catch {
        throw new AblearnMigrationEvidenceError(
          `Live asset does not match reviewed metadata: ${asset.source}.`,
        );
      }
      return {
        role: asset.role,
        source: asset.source,
        assetId: asset.assetId,
        media,
      };
    }),
  );
  const normalizedJob = inventory.job;
  const snapshot = await buildRevisionSnapshot({
    job: { id: inventory.migration.jobId, slug: normalizedJob.slug },
    draft: migrationDraft(normalizedJob, inventory),
    assets: assets.map((asset) => ({
      assetId: asset.assetId,
      role: asset.role,
      ordinal: 0,
      mimeType: asset.media.mimeType,
      byteLength: asset.media.byteLength,
      sha256: asset.media.sha256,
    })),
  });
  const renderedHtml = renderJobDetail({
    job: snapshot.snapshot,
    site: publicSite,
    immutable: true,
  });

  return {
    baseDirectory,
    inventory,
    normalizedJob,
    assets,
    snapshot,
    legacy: legacyInventory(legacyHtml),
    rendered: renderedInventory(renderedHtml),
    renderedHtml,
  };
}

/**
 * Returns the reviewed one-time migration input. The fixture remains non-authoritative
 * after cutover; public runtime reads only the activated D1 revision.
 *
 * @param {Awaited<ReturnType<typeof readAblearnMigrationEvidence>>} evidence
 */
export function prepareAblearnMigration(evidence) {
  return {
    migration: evidence.inventory.migration,
    normalizedJob: evidence.normalizedJob,
    draft: migrationDraft(evidence.normalizedJob, evidence.inventory),
    assets: evidence.assets.map((asset) => ({
      assetId: asset.assetId,
      role: asset.role,
      ordinal: 0,
      source: asset.source,
      media: asset.media,
    })),
    snapshot: evidence.snapshot,
  };
}

/** @param {string} [baseDirectory] @param {EvidenceFileReader} [fileReader] */
export async function auditAblearnMigration(
  baseDirectory = defaultBaseDirectory(),
  fileReader = defaultReadFile,
) {
  /** @type {string[]} */
  const failures = [];
  /** @type {Awaited<ReturnType<typeof readAblearnMigrationEvidence>> | undefined} */
  let evidence;
  try {
    evidence = await readAblearnMigrationEvidence(baseDirectory, fileReader);
  } catch (error) {
    failures.push(
      error instanceof Error
        ? error.message
        : "Unable to load Ablearn migration evidence.",
    );
  }
  if (!evidence) {
    return { valid: false, failures, rows: [], normalizations: [] };
  }

  const { inventory, normalizedJob, snapshot, legacy, rendered } = evidence;
  if (inventory.job.application.provenance !== applicationProvenance) {
    failures.push(
      "application provenance does not describe the reviewed mailto fallback",
    );
  }
  if (
    inventory.assets.length !== 3 ||
    inventory.assets.some((asset) =>
      asset.source.includes("ablearn-marketing-portfolio"),
    )
  ) {
    failures.push(
      "archived Ablearn portfolio material is included in migration evidence",
    );
  }

  if (!sameTextList(legacy.headings, inventory.legacy.headings)) {
    failures.push("legacy heading inventory does not match reviewed evidence");
  }
  if (legacy.linkUrls.length !== inventory.legacy.links) {
    failures.push(
      `expected ${inventory.legacy.links} legacy links, found ${legacy.linkUrls.length}`,
    );
  }
  if (legacy.listItems !== inventory.legacy.listItems) {
    failures.push(
      `expected ${inventory.legacy.listItems} legacy list items, found ${legacy.listItems}`,
    );
  }
  const migratedComparison = comparisonText(flatten(normalizedJob));
  const missingContent = [...legacy.listItemText, ...legacy.benefitText].filter(
    (item) => !migratedComparison.includes(comparisonText(item)),
  );
  if (missingContent.length > 0) {
    failures.push(
      `missing normalized list or benefit content: ${missingContent.slice(0, 3).join(" | ")}`,
    );
  }

  if (snapshot.snapshotHash !== inventory.render.snapshotHash) {
    failures.push(
      "immutable snapshot hash does not match reviewed render evidence",
    );
  }
  if (!sameTextList(rendered.headings, inventory.render.headings)) {
    failures.push("immutable rendered headings do not match reviewed evidence");
  }
  const expectedMailto = createApplyMailto(
    { ...publicSite, contactEmail: normalizedJob.application.value },
    rendererJob(normalizedJob, inventory.assets),
  );
  if (
    expectedMailto !== inventory.render.applicationMailto ||
    !rendered.links.includes(inventory.render.applicationMailto)
  ) {
    failures.push(
      "immutable application mailto does not match reviewed fallback behavior",
    );
  }
  for (const link of inventory.render.contentLinks) {
    if (!rendered.links.includes(link)) {
      failures.push(`immutable rendered link is missing: ${link}`);
    }
  }
  for (const [role, mediaUrl] of Object.entries(inventory.render.media)) {
    if (!evidence.renderedHtml.includes(mediaUrl)) {
      failures.push(
        `immutable ${role} media URL is missing from rendered output`,
      );
    }
  }
  if (
    inventory.assets.some((asset) =>
      evidence.renderedHtml.includes(asset.source),
    )
  ) {
    failures.push(
      "rendered immutable output still contains a source asset path",
    );
  }

  return {
    valid: failures.length === 0,
    failures,
    rows: [
      {
        slug: normalizedJob.slug,
        headings: legacy.headings.length,
        listItems: legacy.listItems,
        links: legacy.linkUrls.length,
        retainedItems: legacy.listItemText.length + legacy.benefitText.length,
        status: normalizedJob.status,
      },
    ],
    normalizations: inventory.normalizations,
    snapshotHash: snapshot.snapshotHash,
  };
}

/** @param {unknown} value @returns {ReviewedInventory} */
function validateInventory(value) {
  const inventory = requireObject(
    value,
    "Reviewed Ablearn inventory must be an object.",
  );
  assertOnlyKeys(
    inventory,
    [
      "schemaVersion",
      "authority",
      "migration",
      "assets",
      "job",
      "legacy",
      "render",
      "normalizations",
    ],
    "Reviewed Ablearn inventory contains an unsupported field.",
  );
  if (inventory["schemaVersion"] !== 3) {
    throw new AblearnMigrationEvidenceError(
      "Reviewed Ablearn inventory schema is unsupported.",
    );
  }
  if (
    requireText(
      inventory["authority"],
      "Reviewed inventory authority is invalid.",
    ) !== inventoryAuthority
  ) {
    throw new AblearnMigrationEvidenceError(
      "Reviewed inventory authority is invalid.",
    );
  }
  const migration = parseMigrationIdentity(inventory["migration"]);
  const assets = parseReviewedAssets(inventory["assets"]);
  const job = parseNormalizedJob(inventory["job"]);
  const legacy = parseLegacyEvidence(inventory["legacy"]);
  const render = parseRenderEvidence(inventory["render"]);
  const normalizations = requireTextArray(
    inventory["normalizations"],
    "Normalization evidence is invalid.",
  );
  if (normalizations.length === 0) {
    throw new AblearnMigrationEvidenceError(
      "Normalization evidence is missing.",
    );
  }
  return { migration, assets, job, legacy, render, normalizations };
}

/** @param {unknown} value @returns {MigrationIdentity} */
function parseMigrationIdentity(value) {
  const migration = requireObject(value, "Migration identity is missing.");
  assertOnlyKeys(
    migration,
    ["companyId", "jobId", "revisionId", "createdAt"],
    "Migration identity contains an unsupported field.",
  );
  return {
    companyId: requireUuid(
      migration["companyId"],
      "Migration company ID is invalid.",
    ),
    jobId: requireUuid(migration["jobId"], "Migration job ID is invalid."),
    revisionId: requireUuid(
      migration["revisionId"],
      "Migration revision ID is invalid.",
    ),
    createdAt: requireIsoTimestamp(
      migration["createdAt"],
      "Migration creation timestamp is invalid.",
    ),
  };
}

/** @param {unknown} value @returns {ReviewedAsset[]} */
function parseReviewedAssets(value) {
  const assets = requireArray(value, "Reviewed assets are missing.").map(
    (item) => {
      const asset = requireObject(item, "Reviewed asset is invalid.");
      assertOnlyKeys(
        asset,
        ["role", "assetId", "source", "mimeType", "byteLength", "sha256"],
        "Reviewed asset contains an unsupported field.",
      );
      return {
        role: requireAssetRole(
          asset["role"],
          "Reviewed asset role is invalid.",
        ),
        assetId: requireUuid(asset["assetId"], "Reviewed asset ID is invalid."),
        source: requireAssetSource(
          asset["source"],
          "Reviewed asset source is invalid.",
        ),
        mimeType: requireMimeType(
          asset["mimeType"],
          "Reviewed asset MIME is invalid.",
        ),
        byteLength: requirePositiveInteger(
          asset["byteLength"],
          "Reviewed asset byte length is invalid.",
        ),
        sha256: requireHash(asset["sha256"], "Reviewed asset hash is invalid."),
      };
    },
  );
  const requiredRoles = new Set([
    "company-logo",
    "company-map",
    "company-document",
  ]);
  if (
    assets.length !== requiredRoles.size ||
    new Set(assets.map((asset) => asset.role)).size !== assets.length ||
    new Set(assets.map((asset) => asset.assetId)).size !== assets.length ||
    new Set(assets.map((asset) => asset.source)).size !== assets.length ||
    assets.some((asset) => !requiredRoles.has(asset.role))
  ) {
    throw new AblearnMigrationEvidenceError(
      "Reviewed asset identities must be unique and complete.",
    );
  }
  return assets;
}

/** @param {unknown} value @returns {NormalizedJob} */
function parseNormalizedJob(value) {
  const job = requireObject(value, "Reviewed job content is missing.");
  assertOnlyKeys(
    job,
    [
      "slug",
      "status",
      "datePosted",
      "publisherAuthorization",
      "title",
      "category",
      "company",
      "employment",
      "location",
      "mapQuery",
      "remote",
      "experience",
      "tags",
      "sections",
      "documents",
      "application",
    ],
    "Reviewed normalized job contains an unsupported field.",
  );
  const status = job["status"];
  if (status !== "open" && status !== "closed") {
    throw new AblearnMigrationEvidenceError("Reviewed job status is invalid.");
  }
  const remote = job["remote"];
  if (remote !== "onsite" && remote !== "hybrid" && remote !== "remote") {
    throw new AblearnMigrationEvidenceError(
      "Reviewed job remote mode is invalid.",
    );
  }
  return {
    slug: requireSlug(job["slug"], "Reviewed job slug is invalid."),
    status,
    datePosted: requireDate(job["datePosted"], "Reviewed job date is invalid."),
    publisherAuthorization: parsePublisherAuthorization(
      job["publisherAuthorization"],
    ),
    title: requireText(job["title"], "Reviewed job title is invalid."),
    category: requireText(job["category"], "Reviewed job category is invalid."),
    company: parseNormalizedCompany(job["company"]),
    employment: requireText(
      job["employment"],
      "Reviewed job employment is invalid.",
    ),
    location: requireText(job["location"], "Reviewed job location is invalid."),
    mapQuery: requireText(
      job["mapQuery"],
      "Reviewed job map query is invalid.",
    ),
    remote,
    experience: requireText(
      job["experience"],
      "Reviewed job experience is invalid.",
    ),
    tags: requireTextArray(job["tags"], "Reviewed job tags are invalid."),
    sections: parseNormalizedSections(job["sections"]),
    documents: parseNormalizedDocuments(job["documents"]),
    application: parseApplicationEvidence(job["application"]),
  };
}

/** @param {unknown} value @returns {PublisherAuthorization} */
function parsePublisherAuthorization(value) {
  const authorization = requireObject(
    value,
    "Reviewed publisher authorization is invalid.",
  );
  assertOnlyKeys(
    authorization,
    ["authorized", "scope", "attestedAt"],
    "Reviewed publisher authorization contains an unsupported field.",
  );
  if (
    authorization["authorized"] !== true ||
    authorization["scope"] !== "published-job"
  ) {
    throw new AblearnMigrationEvidenceError(
      "Reviewed publisher authorization is invalid.",
    );
  }
  return {
    authorized: true,
    scope: "published-job",
    attestedAt: requireIsoTimestamp(
      authorization["attestedAt"],
      "Reviewed publisher authorization timestamp is invalid.",
    ),
  };
}

/** @param {unknown} value @returns {NormalizedCompany} */
function parseNormalizedCompany(value) {
  const company = requireObject(value, "Reviewed company is invalid.");
  assertOnlyKeys(
    company,
    ["name", "website", "summary"],
    "Reviewed company contains an unsupported field.",
  );
  return {
    name: requireText(company["name"], "Reviewed company name is invalid."),
    website: requireHttpsUrl(
      company["website"],
      "Reviewed company website is invalid.",
    ),
    summary: requireText(
      company["summary"],
      "Reviewed company summary is invalid.",
    ),
  };
}

/** @param {unknown} value @returns {NormalizedSections} */
function parseNormalizedSections(value) {
  const sections = requireObject(value, "Reviewed job sections are invalid.");
  const textSectionNames = [
    "company",
    "responsibilities",
    "qualifications",
    "preferred",
    "benefits",
    "conditions",
    "process",
    "notes",
  ];
  assertOnlyKeys(
    sections,
    ["stats", "company", "news", ...textSectionNames.slice(1)],
    "Reviewed job sections contain an unsupported field.",
  );
  const company = requireTextArray(
    sections["company"],
    "Reviewed company section is invalid.",
  );
  const responsibilities = requireTextArray(
    sections["responsibilities"],
    "Reviewed responsibilities section is invalid.",
  );
  const qualifications = requireTextArray(
    sections["qualifications"],
    "Reviewed qualifications section is invalid.",
  );
  const preferred = requireTextArray(
    sections["preferred"],
    "Reviewed preferred section is invalid.",
  );
  const benefits = requireTextArray(
    sections["benefits"],
    "Reviewed benefits section is invalid.",
  );
  const conditions = requireTextArray(
    sections["conditions"],
    "Reviewed conditions section is invalid.",
  );
  const process = requireTextArray(
    sections["process"],
    "Reviewed process section is invalid.",
  );
  const notes = requireTextArray(
    sections["notes"],
    "Reviewed notes section is invalid.",
  );
  return {
    stats: parseStats(sections["stats"]),
    company,
    news: parseLinks(sections["news"]),
    responsibilities,
    qualifications,
    preferred,
    benefits,
    conditions,
    process,
    notes,
  };
}

/** @param {unknown} value @returns {JobStat[]} */
function parseStats(value) {
  return requireArray(value, "Reviewed stats are invalid.").map((item) => {
    const stat = requireObject(item, "Reviewed stat is invalid.");
    assertOnlyKeys(stat, ["label", "value"], "Reviewed stat is invalid.");
    return {
      label: requireText(stat["label"], "Reviewed stat label is invalid."),
      value: requireText(stat["value"], "Reviewed stat value is invalid."),
    };
  });
}

/** @param {unknown} value @returns {JobLink[]} */
function parseLinks(value) {
  return requireArray(value, "Reviewed links are invalid.").map((item) => {
    const link = requireObject(item, "Reviewed link is invalid.");
    assertOnlyKeys(link, ["label", "url"], "Reviewed link is invalid.");
    return {
      label: requireText(link["label"], "Reviewed link label is invalid."),
      url: requireHttpsUrl(link["url"], "Reviewed link URL is invalid."),
    };
  });
}

/** @param {unknown} value @returns {NormalizedDocument[]} */
function parseNormalizedDocuments(value) {
  const documents = requireArray(value, "Reviewed documents are invalid.").map(
    (item) => {
      const document = requireObject(item, "Reviewed document is invalid.");
      assertOnlyKeys(
        document,
        ["label", "assetRole"],
        "Reviewed document is invalid.",
      );
      return {
        label: requireText(
          document["label"],
          "Reviewed document label is invalid.",
        ),
        assetRole: requireAssetRole(
          document["assetRole"],
          "Reviewed document asset role is invalid.",
        ),
      };
    },
  );
  if (
    documents.length === 0 ||
    documents.some((document) => document.assetRole !== "company-document")
  ) {
    throw new AblearnMigrationEvidenceError(
      "Reviewed documents must reference the company document asset.",
    );
  }
  return documents;
}

/** @param {unknown} value @returns {ApplicationEvidence} */
function parseApplicationEvidence(value) {
  const application = requireObject(
    value,
    "Reviewed application evidence is missing.",
  );
  assertOnlyKeys(
    application,
    ["kind", "value", "provenance"],
    "Reviewed application evidence contains an unsupported field.",
  );
  if (application["kind"] !== "email") {
    throw new AblearnMigrationEvidenceError(
      "Reviewed application kind is invalid.",
    );
  }
  const provenance = requireText(
    application["provenance"],
    "Reviewed application provenance is invalid.",
  );
  if (provenance !== applicationProvenance) {
    throw new AblearnMigrationEvidenceError(
      "Reviewed application provenance is invalid.",
    );
  }
  return {
    kind: "email",
    value: requireEmail(
      application["value"],
      "Reviewed application email is invalid.",
    ),
    provenance,
  };
}

/** @param {unknown} value @returns {ReviewedInventory["legacy"]} */
function parseLegacyEvidence(value) {
  const legacy = requireObject(value, "Legacy evidence is missing.");
  assertOnlyKeys(
    legacy,
    ["headings", "links", "listItems"],
    "Legacy evidence contains an unsupported field.",
  );
  return {
    headings: requireTextArray(
      legacy["headings"],
      "Legacy headings are invalid.",
    ),
    links: requirePositiveInteger(
      legacy["links"],
      "Legacy link count is invalid.",
    ),
    listItems: requirePositiveInteger(
      legacy["listItems"],
      "Legacy list-item count is invalid.",
    ),
  };
}

/** @param {unknown} value @returns {ReviewedInventory["render"]} */
function parseRenderEvidence(value) {
  const render = requireObject(value, "Render evidence is missing.");
  assertOnlyKeys(
    render,
    ["snapshotHash", "headings", "applicationMailto", "media", "contentLinks"],
    "Render evidence contains an unsupported field.",
  );
  const media = requireObject(
    render["media"],
    "Rendered media evidence is missing.",
  );
  assertOnlyKeys(
    media,
    ["company-logo", "company-map", "company-document"],
    "Rendered media evidence contains an unsupported field.",
  );
  return {
    snapshotHash: requireHash(
      render["snapshotHash"],
      "Snapshot hash is invalid.",
    ),
    headings: requireTextArray(
      render["headings"],
      "Rendered headings are invalid.",
    ),
    applicationMailto: requireMailto(
      render["applicationMailto"],
      "Rendered application mailto is invalid.",
    ),
    media: {
      "company-logo": requireMediaUrl(
        media["company-logo"],
        "Rendered company logo URL is invalid.",
      ),
      "company-map": requireMediaUrl(
        media["company-map"],
        "Rendered company map URL is invalid.",
      ),
      "company-document": requireMediaUrl(
        media["company-document"],
        "Rendered company document URL is invalid.",
      ),
    },
    contentLinks: requireTextArray(
      render["contentLinks"],
      "Rendered links are invalid.",
    ),
  };
}

/**
 * Derives the mutable D1 payload from the validated normalized fixture. The source
 * asset paths never enter D1 JSON; documents refer to immutable asset identities.
 *
 * @param {NormalizedJob} job
 * @param {ReviewedInventory} inventory
 * @returns {MigrationDraft}
 */
function migrationDraft(job, inventory) {
  /** @type {Record<AssetRole, ReviewedAsset>} */
  const assetsByRole = {
    "company-logo": reviewedAssetForRole(inventory.assets, "company-logo"),
    "company-map": reviewedAssetForRole(inventory.assets, "company-map"),
    "company-document": reviewedAssetForRole(
      inventory.assets,
      "company-document",
    ),
  };
  return {
    draftJson: {
      schemaVersion: 1,
      status: job.status,
      datePosted: job.datePosted,
      publisherAuthorization: job.publisherAuthorization,
      title: job.title,
      category: job.category,
      employment: job.employment,
      location: job.location,
      mapQuery: job.mapQuery,
      remote: job.remote,
      experience: job.experience,
      tags: job.tags,
      sections: job.sections,
      documents: job.documents.map((document) => ({
        label: document.label,
        assetId: assetsByRole[document.assetRole].assetId,
      })),
    },
    companySnapshotJson: job.company,
    applicationJson: job.application,
  };
}

/**
 * Builds a full renderer DTO for the mailto helper from validated, immutable evidence.
 * The value exists only to exercise the shared mailto contract; rendering uses the
 * snapshot built from the same reviewed DTO.
 *
 * @param {NormalizedJob} job
 * @param {ReviewedAsset[]} assets
 * @returns {RendererJob}
 */
function rendererJob(job, assets) {
  const logo = reviewedAssetForRole(assets, "company-logo");
  return {
    schemaVersion: 1,
    id: job.slug,
    slug: job.slug,
    status: job.status,
    datePosted: job.datePosted,
    publisherAuthorization: job.publisherAuthorization,
    title: job.title,
    category: job.category,
    company: {
      ...job.company,
      logo: `/media/${logo.assetId}`,
    },
    employment: job.employment,
    location: job.location,
    mapQuery: job.mapQuery,
    remote: job.remote,
    experience: job.experience,
    tags: job.tags,
    sections: job.sections,
    documents: job.documents.map((document) => ({
      label: document.label,
      url: `/media/${reviewedAssetForRole(assets, document.assetRole).assetId}`,
    })),
  };
}

/** @param {ReviewedAsset[]} assets @param {AssetRole} role */
function reviewedAssetForRole(assets, role) {
  const asset = assets.find((candidate) => candidate.role === role);
  if (!asset) {
    throw new AblearnMigrationEvidenceError(
      `Reviewed ${role} asset is missing.`,
    );
  }
  return asset;
}

/** @param {string[]} left @param {string[]} right */
function sameTextList(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} message @returns {Record<string, unknown>} */
function requireObject(value, message) {
  if (!isRecord(value)) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return value;
}

/** @param {unknown} value @param {string} message @returns {unknown[]} */
function requireArray(value, message) {
  if (!Array.isArray(value)) throw new AblearnMigrationEvidenceError(message);
  return value;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireText(value, message) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return value;
}

/** @param {unknown} value @param {string} message @returns {string[]} */
function requireTextArray(value, message) {
  const values = requireArray(value, message).map((item) =>
    requireText(item, message),
  );
  if (values.length === 0) throw new AblearnMigrationEvidenceError(message);
  return values;
}

/** @param {unknown} value @param {string} message @returns {number} */
function requirePositiveInteger(value, message) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return value;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireHash(value, message) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return value;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireUuid(value, message) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  ) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return value;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireIsoTimestamp(value, message) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return value;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireDate(value, message) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
  ) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return value;
}

/** @param {unknown} value @param {string} message @returns {AssetRole} */
function requireAssetRole(value, message) {
  if (
    value !== "company-logo" &&
    value !== "company-map" &&
    value !== "company-document"
  ) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return value;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireAssetSource(value, message) {
  const source = requireText(value, message);
  if (
    !/^src\/assets\/jobs\/ablearn\/[a-z0-9-]+\.(?:png|jpg|pdf)$/u.test(source)
  ) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return source;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireMimeType(value, message) {
  if (
    value !== "image/png" &&
    value !== "image/jpeg" &&
    value !== "application/pdf"
  ) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return value;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireSlug(value, message) {
  const slug = requireText(value, message);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return slug;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireHttpsUrl(value, message) {
  const url = requireText(value, message);
  try {
    if (new URL(url).protocol !== "https:") throw new Error();
  } catch {
    throw new AblearnMigrationEvidenceError(message);
  }
  return url;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireEmail(value, message) {
  const email = requireText(value, message);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email)) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return email;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireMailto(value, message) {
  const mailto = requireText(value, message);
  if (!mailto.startsWith("mailto:")) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return mailto;
}

/** @param {unknown} value @param {string} message @returns {string} */
function requireMediaUrl(value, message) {
  const url = requireText(value, message);
  if (!/^\/media\/[0-9a-f-]{36}$/u.test(url)) {
    throw new AblearnMigrationEvidenceError(message);
  }
  return url;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} message */
function assertOnlyKeys(value, allowed, message) {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new AblearnMigrationEvidenceError(message);
  }
}

if (isDirectExecution()) {
  const result = await auditAblearnMigration();
  for (const row of result.rows) {
    console.log(
      `${row.slug}: ${row.status}; ${row.headings} headings, ${row.listItems} list items, ${row.links} links, ${row.retainedItems} retained content items.`,
    );
  }
  for (const normalization of result.normalizations) {
    console.log(`Normalization: ${normalization}`);
  }
  if (!result.valid) {
    for (const failure of result.failures) console.error(failure);
    process.exitCode = 1;
  }
}
