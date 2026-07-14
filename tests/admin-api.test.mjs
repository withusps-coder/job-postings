import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import { SqliteD1, asD1 } from "./helpers/sqlite-d1.mjs";

import { onRequestPost as createCompany } from "../functions/api/admin/companies/index.js";
import { onRequestPost as createJob } from "../functions/api/admin/jobs/index.js";
import { onRequestPatch as updateDraft } from "../functions/api/admin/jobs/[id]/draft.js";
/** @typedef {Parameters<typeof createCompany>[0]} AdminMutationContext */
const administrator = {
  subject: "administrator@example.test",
  email: "administrator@example.test",
  issuedAt: 1_700_000_000,
  expiresAt: 1_700_003_600,
};
const adminSecurity = {
  environment: /** @type {"staging"} */ ("staging"),
  canonicalHost: "admin.example.test",
  canonicalOrigin: "https://admin.example.test",
  issuer: "https://access.example.test",
  audience: "careers-admin",
  administratorEmail: administrator.email,
  jwksUrl: new URL("https://access.example.test/cdn-cgi/access/certs"),
};

/** @param {number} sequence */
function uuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

/**
 * Builds the post-middleware event context passed to the production handlers.
 * Middleware authentication and CSRF enforcement have their own boundary tests;
 * this fixture supplies only verified middleware output to exercise transport,
 * idempotency, and D1 behavior in the route handlers themselves.
 *
 * @param {SqliteD1} database
 * @param {string} path
 * @param {"POST" | "PATCH"} method
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [params]
 */
function adminMutationContext(database, path, method, body, params = {}) {
  const idempotencyKey = body["idempotencyKey"];
  if (typeof idempotencyKey !== "string") {
    throw new TypeError("Mutation fixture requires an idempotency key.");
  }
  return /** @type {AdminMutationContext} */ (
    /** @type {unknown} */ ({
      request: new Request(`https://admin.example.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
      functionPath: path,
      waitUntil(/** @type {Promise<unknown>} */ promise) {
        void promise;
      },
      passThroughOnException() {},
      async next() {
        return new Response(null, { status: 404 });
      },
      env: { DB: asD1(database) },
      params,
      data: { admin: administrator, adminSecurity },
    })
  );
}

/** @param {number} key */
function companyRequest(key) {
  return {
    name: "Step Up Partners",
    website: "https://stepup.example.test",
    summary: "Executive search for product and commercial leaders.",
    idempotencyKey: uuid(key),
  };
}

/** @param {string} companyId @param {number} key */
function jobRequest(companyId, key) {
  return {
    slug: "product-lead",
    companyId,
    draft: { status: "open", title: "Product Lead" },
    application: {
      kind: "email",
      value: "apply@stepup.example.test",
      provenance: "Company careers inbox",
    },
    idempotencyKey: uuid(key),
  };
}

/**
 * @param {SqliteD1} database
 * @param {number} companyKey
 * @param {number} jobKey
 */
async function createCompanyAndJob(database, companyKey, jobKey) {
  const companyResponse = await createCompany(
    adminMutationContext(
      database,
      "/api/admin/companies",
      "POST",
      companyRequest(companyKey),
    ),
  );
  assert.equal(companyResponse.status, 201);
  const companyBody = await companyResponse.json();
  assert.equal(companyBody.code, "COMPANY_CREATED");
  assert.match(companyBody.company.id, /^[0-9a-f-]{36}$/u);
  assert.equal(companyBody.company.name, "Step Up Partners");
  assert.equal(companyBody.company.version, 1);

  const jobResponse = await createJob(
    adminMutationContext(
      database,
      "/api/admin/jobs",
      "POST",
      jobRequest(companyBody.company.id, jobKey),
    ),
  );
  assert.equal(jobResponse.status, 201);
  const jobBody = await jobResponse.json();
  assert.equal(jobBody.code, "JOB_CREATED");
  assert.match(jobBody.job.id, /^[0-9a-f-]{36}$/u);
  assert.equal(jobBody.job.slug, "product-lead");
  assert.equal(jobBody.job.activeGeneration, 0);
  assert.deepEqual(jobBody.draft, {
    version: 1,
    companyId: companyBody.company.id,
  });

  return { company: companyBody.company, job: jobBody.job };
}

test("company and job creation handlers persist a mutable first draft", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());

  const { company, job } = await createCompanyAndJob(database, 1, 2);

  assert.match(company.id, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(
    database.one(
      `SELECT name, normalized_name, company_json, version
       FROM companies WHERE id = ?`,
      [company.id],
    ),
    {
      name: "Step Up Partners",
      normalized_name: "step up partners",
      company_json: JSON.stringify({
        name: "Step Up Partners",
        summary: "Executive search for product and commercial leaders.",
        website: "https://stepup.example.test/",
      }),
      version: 1,
    },
  );
  assert.deepEqual(
    database.one(
      `SELECT jobs.slug, jobs.active_revision_id, jobs.active_generation,
              drafts.company_id, drafts.version, drafts.draft_json,
              drafts.company_snapshot_json, drafts.application_json
       FROM jobs
       JOIN job_drafts AS drafts ON drafts.job_id = jobs.id
       WHERE jobs.id = ?`,
      [job.id],
    ),
    {
      slug: "product-lead",
      active_revision_id: null,
      active_generation: 0,
      company_id: company.id,
      version: 1,
      draft_json: JSON.stringify({ status: "open", title: "Product Lead" }),
      company_snapshot_json: JSON.stringify({
        name: "Step Up Partners",
        summary: "Executive search for product and commercial leaders.",
        website: "https://stepup.example.test/",
      }),
      application_json: JSON.stringify({
        kind: "email",
        provenance: "Company careers inbox",
        value: "apply@stepup.example.test",
      }),
    },
  );
  assert.deepEqual(
    database.one(
      "SELECT COUNT(*) AS count FROM job_revisions WHERE job_id = ?",
      [job.id],
    ),
    { count: 0 },
  );
  assert.deepEqual(
    database.one(
      `SELECT state, terminal_code
       FROM mutation_operations
       WHERE operation = ?`,
      ["create_company"],
    ),
    {
      state: "succeeded",
      terminal_code: "COMPANY_CREATED",
    },
  );
  assert.deepEqual(
    database.one(
      `SELECT state, terminal_code
       FROM mutation_operations
       WHERE operation = ?`,
      ["create_job"],
    ),
    {
      state: "succeeded",
      terminal_code: "JOB_CREATED",
    },
  );
});

test("company creation replays an exact terminal response and rejects a changed fingerprint", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());

  const request = companyRequest(11);
  const first = await createCompany(
    adminMutationContext(database, "/api/admin/companies", "POST", request),
  );
  const firstText = await first.text();
  assert.equal(first.status, 201);

  const replay = await createCompany(
    adminMutationContext(database, "/api/admin/companies", "POST", request),
  );
  assert.equal(replay.status, 201);
  assert.equal(await replay.text(), firstText);

  const differentRequest = {
    ...request,
    name: "Different Company",
  };
  const mismatch = await createCompany(
    adminMutationContext(
      database,
      "/api/admin/companies",
      "POST",
      differentRequest,
    ),
  );
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, "IDEMPOTENCY_KEY_REUSED");
  assert.deepEqual(database.one("SELECT COUNT(*) AS count FROM companies"), {
    count: 1,
  });
  assert.deepEqual(
    database.one("SELECT COUNT(*) AS count FROM mutation_operations"),
    { count: 1 },
  );
});

test("draft handler rejects a stale CAS and retries only through a fresh operation key", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());
  const { job } = await createCompanyAndJob(database, 21, 22);

  const firstUpdate = {
    expectedDraftVersion: 1,
    draft: { status: "open", title: "Updated Product Lead" },
    idempotencyKey: uuid(23),
  };
  const firstResponse = await updateDraft(
    adminMutationContext(
      database,
      `/api/admin/jobs/${job.id}/draft`,
      "PATCH",
      firstUpdate,
      { id: job.id },
    ),
  );
  assert.equal(firstResponse.status, 200);
  assert.equal((await firstResponse.json()).code, "DRAFT_UPDATED");

  const staleRequest = {
    expectedDraftVersion: 1,
    draft: { status: "open", title: "Stale Product Lead" },
    idempotencyKey: uuid(24),
  };
  const staleResponse = await updateDraft(
    adminMutationContext(
      database,
      `/api/admin/jobs/${job.id}/draft`,
      "PATCH",
      staleRequest,
      { id: job.id },
    ),
  );
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).code, "DRAFT_VERSION_CONFLICT");
  assert.deepEqual(
    database.one(
      "SELECT version, draft_json FROM job_drafts WHERE job_id = ?",
      [job.id],
    ),
    {
      version: 2,
      draft_json: JSON.stringify({
        status: "open",
        title: "Updated Product Lead",
      }),
    },
  );

  const failedOperation = database.one(
    `SELECT id, state, terminal_code
     FROM mutation_operations
     WHERE idempotency_key = ?`,
    [staleRequest.idempotencyKey],
  );
  if (failedOperation === null) {
    throw new Error("Expected stale draft operation to be persisted.");
  }
  assert.deepEqual(failedOperation, {
    id: failedOperation["id"],
    state: "failed",
    terminal_code: "DRAFT_VERSION_CONFLICT",
  });

  const retryRequest = {
    expectedDraftVersion: 2,
    draft: { status: "open", title: "Rebased Product Lead" },
    idempotencyKey: uuid(25),
    retryOf: failedOperation["id"],
  };
  const retryResponse = await updateDraft(
    adminMutationContext(
      database,
      `/api/admin/jobs/${job.id}/draft`,
      "PATCH",
      retryRequest,
      { id: job.id },
    ),
  );
  assert.equal(retryResponse.status, 200);
  assert.equal((await retryResponse.json()).code, "DRAFT_UPDATED");
  assert.deepEqual(
    database.one(
      `SELECT version, draft_json
       FROM job_drafts WHERE job_id = ?`,
      [job.id],
    ),
    {
      version: 3,
      draft_json: JSON.stringify({
        status: "open",
        title: "Rebased Product Lead",
      }),
    },
  );
  assert.deepEqual(
    database.one(
      `SELECT idempotency_key, retry_of, state, terminal_code
       FROM mutation_operations
       WHERE idempotency_key = ?`,
      [retryRequest.idempotencyKey],
    ),
    {
      idempotency_key: retryRequest.idempotencyKey,
      retry_of: failedOperation.id,
      state: "succeeded",
      terminal_code: "DRAFT_UPDATED",
    },
  );
});

test("the historical generic operation retry route is absent", async () => {
  await assert.rejects(
    () =>
      access(
        new URL(
          "../functions/api/admin/operations/[id]/retry.js",
          import.meta.url,
        ),
      ),
    /** @param {unknown} error */ (error) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT",
  );
});
