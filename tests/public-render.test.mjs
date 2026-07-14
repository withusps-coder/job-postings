import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { onRequest as renderJobBySlug } from "../functions/[slug].js";
import { onRequest as renderJobListingFromD1 } from "../functions/index.js";
import { buildRevisionSnapshot } from "../functions/_lib/snapshot.js";
import { onRequest as renderSitemap } from "../functions/sitemap.xml.js";
import {
  createApplyMailto,
  renderJobDetail,
  renderJobListing,
} from "../src/_includes/render/public-pages.js";
/**
 * @typedef {import("../src/_includes/render/types.js").Company} Company
 * @typedef {import("../src/_includes/render/types.js").Job} Job
 * @typedef {import("../src/_includes/render/types.js").Site} Site
 */

/**
 * @typedef {{ label: string, assetRole: string }} FixtureDocument
 * @typedef {{ kind: "email" | "url", value: string, provenance: string }} FixtureApplication
 * @typedef {{ role: string, assetId: string, source: string, mimeType: string, byteLength: number, sha256: string }} FixtureAsset
 * @typedef {Omit<Job, "id" | "company" | "documents"> & { company: Omit<Company, "logo">, documents: FixtureDocument[], application: FixtureApplication }} FixtureJob
 * @typedef {{
 *   authority: string,
 *   migration: { companyId: string, jobId: string, revisionId: string, createdAt: string },
 *   assets: FixtureAsset[],
 *   job: FixtureJob,
 *   render: {
 *     snapshotHash: string,
 *     applicationMailto: string,
 *     media: Record<string, string>,
 *     contentLinks: string[]
 *   }
 * }} AblearnEvidence
 * @typedef {{ title: string, description: string, datePosted: string, employmentType: string, hiringOrganization: { name: string, logo: string }, url: string }} JobPosting
 * @typedef {{ job_id: string, slug: string, active_generation: number, revision_id: string, revision_number: number, status: "open" | "closed", snapshot_json: string, snapshot_hash: string, asset_manifest_json: string, revision_created_at: number }} ActiveRevisionD1Row
 * @typedef {{ rows: readonly ActiveRevisionD1Row[], rowsBySlug: ReadonlyMap<string, ActiveRevisionD1Row> }} FirstPrimaryDatabaseInput
 * @typedef {{ sessions: string[], bindings: unknown[][] }} D1MockCalls
 */

/** @type {Site} */
const site = JSON.parse(
  await readFile(new URL("../src/_data/site.json", import.meta.url), "utf8"),
);
/** @type {AblearnEvidence} */
const ablearnEvidence = JSON.parse(
  await readFile(
    new URL("./fixtures/ablearn-migration-inventory.json", import.meta.url),
    "utf8",
  ),
);
const ablearnRevision = await buildAblearnRevision(ablearnEvidence);
const ablearnRow = activeRevisionRow(ablearnEvidence, ablearnRevision);
/** @type {Job} */
const openJob = JSON.parse(
  await readFile(
    new URL("./fixtures/data/valid-minimal.json", import.meta.url),
    "utf8",
  ),
);
/** @type {Job} */
const closedJob = JSON.parse(
  await readFile(
    new URL("./fixtures/data/valid-rich.json", import.meta.url),
    "utf8",
  ),
);

test("Given reviewed Ablearn migration evidence, when a D1 snapshot is prepared, then the fixture remains non-authoritative preservation input", () => {
  assert.match(ablearnEvidence["authority"], /non-authoritative/u);
  assert.match(
    ablearnEvidence["authority"],
    /D1 active revisions are the sole authority/u,
  );
  assert.deepEqual(
    {
      slug: ablearnEvidence["job"]["slug"],
      status: ablearnEvidence["job"]["status"],
    },
    { slug: "ablearn-strategy", status: "open" },
  );
  assert.equal(
    ablearnRevision.snapshotHash,
    ablearnEvidence["render"]["snapshotHash"],
  );
});

test("Given one active Ablearn revision on D1 primary, when the public listing Function runs, then it renders the original open listing with bounded caching", async () => {
  const { database, calls } = firstPrimaryDatabase({
    rows: [ablearnRow],
    rowsBySlug: new Map([[ablearnRow["slug"], ablearnRow]]),
  });

  const response = await renderJobListingFromD1(publicContext("/", database));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, s-maxage=10, must-revalidate",
  );
  assert.equal(
    response.headers.get("x-content-revision"),
    `list-1-r1-g3-${ablearnRevision.snapshotHash.slice(0, 12)}`,
  );
  assert.match(html, /data-job-slug="ablearn-strategy"/u);
  assert.match(html, /\[에이블런\] 사업 전략 기획/u);
  assert.match(html, /에이블런\(ABLEARN\)/u);
  assert.match(html, /사업기획/u);
  assert.match(html, /href="\/ablearn-strategy\/"/u);
  assert.doesNotMatch(html, /src\/jobs\/ablearn-strategy\.json/u);
  assert.deepEqual(calls.sessions, ["first-primary"]);
  assert.deepEqual(calls.bindings, [[100, 0]]);
});

test("Given one active Ablearn revision on D1 primary, when its detail Function runs, then original content, structured data, application route, and immutable media are rendered", async () => {
  const { database, calls } = firstPrimaryDatabase({
    rows: [ablearnRow],
    rowsBySlug: new Map([[ablearnRow["slug"], ablearnRow]]),
  });

  const response = await renderJobBySlug(
    publicContext(`/${ablearnRow["slug"]}/`, database, {
      slug: ablearnRow["slug"],
    }),
  );
  const html = await response.text();
  const structured = html.match(
    /<script type="application\/ld\+json">([^<]+)<\/script>/u,
  )?.[1];

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, s-maxage=10, must-revalidate",
  );
  assert.equal(
    response.headers.get("x-content-revision"),
    `r1-g3-${ablearnRevision.snapshotHash.slice(0, 12)}`,
  );
  assert.match(html, /\[에이블런\] 사업 전략 기획/u);
  assert.match(html, /국내 최고의 AI 전문가 Pool 보유/u);
  assert.match(html, /정부 및 기업 대상 사업 제안서 작성 및 관리/u);
  for (const mediaUrl of Object.values(ablearnEvidence["render"]["media"])) {
    assert.equal(html.includes(mediaUrl), true, mediaUrl);
  }
  for (const contentUrl of ablearnEvidence["render"]["contentLinks"]) {
    assert.equal(html.includes(contentUrl), true, contentUrl);
  }
  const apply = html.match(/data-apply-link href="([^"]+)"/u)?.[1];
  assert.equal(
    apply?.replaceAll("&amp;", "&"),
    ablearnEvidence["render"]["applicationMailto"],
  );
  assert.ok(structured);
  /** @type {JobPosting} */
  const jobPosting = JSON.parse(structured);
  assert.equal(jobPosting["title"], ablearnEvidence["job"]["title"]);
  assert.equal(
    jobPosting["description"],
    ablearnEvidence["job"]["company"]["summary"],
  );
  assert.equal(jobPosting["datePosted"], ablearnEvidence["job"]["datePosted"]);
  assert.equal(
    jobPosting["employmentType"],
    ablearnEvidence["job"]["employment"],
  );
  assert.equal(
    jobPosting["hiringOrganization"]["name"],
    ablearnEvidence["job"]["company"]["name"],
  );
  assert.equal(
    jobPosting["hiringOrganization"]["logo"],
    `https://jobs.example.test${ablearnEvidence["render"]["media"]["company-logo"]}`,
  );
  assert.equal(
    jobPosting["url"],
    "https://jobs.example.test/ablearn-strategy/",
  );
  assert.deepEqual(calls.sessions, ["first-primary"]);
  assert.deepEqual(calls.bindings, [[ablearnRow.slug]]);
});

test("Given one active Ablearn revision on D1 primary, when the sitemap Function runs, then it emits only the canonical root and open detail URLs", async () => {
  const { database, calls } = firstPrimaryDatabase({
    rows: [ablearnRow],
    rowsBySlug: new Map([[ablearnRow["slug"], ablearnRow]]),
  });

  const response = await renderSitemap(publicContext("/sitemap.xml", database));
  const xml = await response.text();

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, s-maxage=10, must-revalidate",
  );
  assert.equal(
    response.headers.get("x-content-revision"),
    `list-1-r1-g3-${ablearnRevision.snapshotHash.slice(0, 12)}`,
  );
  assert.equal((xml.match(/<url>/gu) ?? []).length, 2);
  assert.match(xml, /<loc>https:\/\/jobs\.example\.test\/<\/loc>/u);
  assert.match(
    xml,
    /<loc>https:\/\/jobs\.example\.test\/ablearn-strategy\/<\/loc>/u,
  );
  assert.match(xml, /<lastmod>2026-07-11T00:00:00\.000Z<\/lastmod>/u);
  assert.doesNotMatch(xml, /author|src\/jobs/u);
  assert.deepEqual(calls.sessions, ["first-primary"]);
  assert.deepEqual(calls.bindings, [[100, 0]]);
});

/**
 * @param {AblearnEvidence} evidence
 * @returns {Promise<Awaited<ReturnType<typeof buildRevisionSnapshot>>>}
 */
async function buildAblearnRevision(evidence) {
  const assetsByRole = new Map(
    evidence["assets"].map((asset) => [asset["role"], asset]),
  );
  const { company, application, documents, ...content } = evidence["job"];
  return buildRevisionSnapshot({
    job: {
      id: evidence["migration"]["jobId"],
      slug: evidence["job"]["slug"],
    },
    draft: {
      draftJson: {
        ...content,
        schemaVersion: 1,
        documents: documents.map((document) => ({
          label: document["label"],
          assetId: assetsByRole.get(document["assetRole"])?.["assetId"],
        })),
      },
      companySnapshotJson: company,
      applicationJson: application,
    },
    assets: evidence["assets"].map((asset) => ({
      assetId: asset["assetId"],
      role: asset["role"],
      ordinal: 0,
      mimeType: asset["mimeType"],
      byteLength: asset["byteLength"],
      sha256: asset["sha256"],
    })),
  });
}

/**
 * @param {AblearnEvidence} evidence
 * @param {Awaited<ReturnType<typeof buildRevisionSnapshot>>} revision
 * @returns {ActiveRevisionD1Row}
 */
function activeRevisionRow(evidence, revision) {
  return {
    job_id: evidence["migration"]["jobId"],
    slug: evidence["job"]["slug"],
    active_generation: 3,
    revision_id: evidence["migration"]["revisionId"],
    revision_number: 1,
    status: "open",
    snapshot_json: revision.snapshotJson,
    snapshot_hash: revision.snapshotHash,
    asset_manifest_json: revision.assetManifestJson,
    revision_created_at: Date.parse(evidence["migration"]["createdAt"]),
  };
}

/**
 * @param {FirstPrimaryDatabaseInput} input
 */
function firstPrimaryDatabase(input) {
  /** @type {D1MockCalls} */
  const calls = {
    sessions: [],
    bindings: [],
  };
  /** @type {unknown[]} */
  let boundParameters = [];

  const statement = {
    /** @param {...unknown} parameters */
    bind(...parameters) {
      boundParameters = parameters;
      calls.bindings.push(parameters);
      return statement;
    },
    all: async () => d1Result(input.rows),
    first: async () =>
      typeof boundParameters[0] === "string"
        ? (input.rowsBySlug.get(boundParameters[0]) ?? null)
        : null,
    run: async () => d1Result([]),
    raw: async () => [],
  };

  const session = {
    prepare() {
      return statement;
    },
    batch: async () => [],
    getBookmark() {
      return null;
    },
  };

  const database = {
    prepare() {
      return statement;
    },
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    /**
     * @param {D1SessionBookmark | D1SessionConstraint | undefined} constraint
     */
    withSession(constraint) {
      if (constraint) calls.sessions.push(constraint);
      return session;
    },
    dump: async () => new ArrayBuffer(0),
  };

  return { calls, database };
}

/**
 * @template T
 * @param {readonly T[]} results
 * @returns {D1Result<T>}
 */
function d1Result(results) {
  return {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    },
    results: [...results],
  };
}

/**
 * @overload
 * @param {string} path
 * @param {ReturnType<typeof firstPrimaryDatabase>["database"]} database
 * @returns {EventContext<{ DB: D1Database, PUBLIC_CANONICAL_HOST?: string }, never, unknown>}
 */
/**
 * @template {string} Parameter
 * @overload
 * @param {string} path
 * @param {ReturnType<typeof firstPrimaryDatabase>["database"]} database
 * @param {Record<Parameter, string>} params
 * @returns {EventContext<{ DB: D1Database, PUBLIC_CANONICAL_HOST?: string }, Parameter, unknown>}
 */
/**
 * @param {string} path
 * @param {ReturnType<typeof firstPrimaryDatabase>["database"]} database
 * @param {Record<string, string>} [params]
 */
function publicContext(path, database, params = {}) {
  return {
    request: new Request(`https://jobs.example.test${path}`, {
      headers: { host: "jobs.example.test" },
    }),
    functionPath: path,
    /** @param {Promise<unknown>} promise */
    waitUntil(promise) {
      void promise;
    },
    passThroughOnException() {},
    /**
     * @param {Request | string | undefined} input
     * @param {RequestInit | undefined} init
     */
    async next(input, init) {
      void input;
      void init;
      return new Response(null, { status: 404 });
    },
    env: {
      JOB_MEDIA: { fetch },
      DB: database,
      PUBLIC_CANONICAL_HOST: "jobs.example.test",
      DEPLOYMENT_ENVIRONMENT: "production",
      PUBLIC_PAGES_HOST: "project.pages.dev",
    },
    params,
    data: undefined,
  };
}

test("Given a job, when an apply link is rendered, then its confirmed Korean subject is encoded exactly", () => {
  // Given / When
  const href = createApplyMailto(site, openJob);

  // Then
  assert.equal(
    href,
    `mailto:majesty89@starting.kr?subject=${encodeURIComponent("[채용 문의] Sample Company Sample role")}`,
  );
});

test("Given open and closed jobs, when the listing renders, then useful no-script output defaults to open", () => {
  // Given / When
  const html = renderJobListing({ jobs: [closedJob, openJob], site });

  // Then
  assert.match(html, /data-job-slug="sample-minimal"/u);
  assert.doesNotMatch(html, /data-job-slug="sample-rich"/u);
  assert.match(html, /name="q"/u);
  assert.match(html, /name="category"/u);
  assert.match(html, /name="company"/u);
  assert.match(html, /data-result-count>1<\/strong>/u);
});

test("Given an authorized open job, when detail renders, then visible facts and JobPosting agree", () => {
  // Given / When
  const html = renderJobDetail({ job: openJob, site });

  // Then
  assert.match(html, /<script type="application\/ld\+json">/u);
  assert.match(html, /Sample role/u);
  assert.match(html, /A sample hiring organization\./u);
  assert.match(html, /2026-07-10/u);
  assert.match(html, /full-time/u);
  assert.match(html, /Seoul/u);
  assert.match(html, /data-apply-link/u);
});

test("Given a rich job, when detail renders, then the Greeting-style information structure is present", () => {
  const richOpenJob = structuredClone(openJob);
  richOpenJob.sections = {
    company: ["A trusted company fact."],
    news: [{ label: "Company news", url: "https://example.com/news" }],
    responsibilities: [
      "포지션 개요: Lead the role from strategy through execution.",
      "이런 분: Own outcomes and communicate clearly.",
      "First responsibility",
      "Second responsibility",
    ],
    qualifications: ["Required experience"],
    preferred: ["Preferred experience"],
    benefits: ["성장 지원: 교육비와 도서비 지원"],
    conditions: ["근무 시간: 주 5일"],
    process: ["서류 전형", "인터뷰: 직무 및 컬처핏 확인"],
    notes: ["자유 양식 이력서 제출"],
  };

  const html = renderJobDetail({ job: richOpenJob, site });

  assert.match(html, /class="detail-layout"/u);
  assert.match(html, /class="job-summary"/u);
  assert.doesNotMatch(html, /<iframe/u);
  assert.match(html, /id="section-overview"/u);
  assert.match(html, /Lead the role from strategy through execution\./u);
  assert.match(html, /id="section-responsibilities"/u);
  assert.doesNotMatch(html, /포지션 개요: Lead/u);
  assert.match(html, /class="benefit-group"/u);
  assert.match(html, /class="condition-list"/u);
  assert.doesNotMatch(html, /class="recruiter-promise"/u);
  assert.doesNotMatch(html, /class="recruiter-closing"/u);
  assert.equal((html.match(/data-apply-link/gu) ?? []).length, 1);
});

test("Given a closed job, when detail renders, then it stays readable without apply or structured data", () => {
  // Given / When
  const html = renderJobDetail({ job: closedJob, site });

  // Then
  assert.match(html, /Sample rich role/u);
  assert.match(html, /This position is closed\./u);
  assert.doesNotMatch(html, /application\/ld\+json/u);
  assert.doesNotMatch(html, /data-apply-link/u);
});

test("Given malicious text, when a public page renders, then raw HTML never crosses the boundary", () => {
  // Given
  const unsafe = structuredClone(openJob);
  unsafe.title = "<script>alert(1)</script>";

  // When
  const html = renderJobDetail({ job: unsafe, site });

  // Then
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
});
