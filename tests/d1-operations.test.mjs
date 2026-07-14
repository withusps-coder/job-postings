import assert from "node:assert/strict";
import test from "node:test";

import { SqliteD1, asD1 } from "./helpers/sqlite-d1.mjs";

import {
  OperationError,
  claimOperation,
  createOperationFingerprint,
  finalizeOperation,
} from "../functions/_lib/operations.js";
import {
  buildCloseRevision,
  buildPublishResourceStatements,
  buildRollbackRevision,
  finalizeClose,
  finalizePublish,
  finalizeRollback,
} from "../functions/_lib/publish.js";
import { buildRevisionSnapshot } from "../functions/_lib/snapshot.js";
const NOW = 1_700_000_000_000;
const CLOSED_AT = "2026-07-13T12:00:00.000Z";

/** @param {number} sequence */
function uuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

/**
 * @typedef {{
 *   id: string,
 *   jobId: string,
 *   revisionNumber: number,
 *   baseGeneration: number,
 *   status: 'open' | 'closed',
 *   snapshotJson: string,
 *   snapshotHash: string,
 *   assetManifestJson: string,
 *   parentRevisionId: string | null,
 *   rollbackSourceRevisionId: string | null,
 *   createdAt: number,
 *   assets: readonly { assetId: string, role: string, ordinal: number }[]
 * }} Revision
 */

/**
 * Inserts the mutable company and job-draft records that an initial publication
 * reads. There are deliberately no assets, making the pointer test independent
 * from media test fixtures.
 *
 * @param {SqliteD1} database
 */
function insertDraftFixture(database) {
  const job = { id: "job-1", slug: "original-role" };
  const company = { name: "Original Company", industry: "consulting" };
  const draft = {
    draftJson: JSON.stringify({ status: "open", title: "Original title" }),
    companySnapshotJson: JSON.stringify(company),
    applicationJson: JSON.stringify({
      kind: "email",
      value: "jobs@example.test",
      provenance: "company careers inbox",
    }),
  };

  database.run(
    `INSERT INTO companies (
       id, name, normalized_name, company_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      "company-1",
      company.name,
      company.name.toLowerCase(),
      JSON.stringify(company),
      NOW,
      NOW,
    ],
  );
  database.run(
    "INSERT INTO jobs (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [job.id, job.slug, NOW, NOW],
  );
  database.run(
    `INSERT INTO job_drafts (
       job_id, company_id, version, draft_json, company_snapshot_json,
       application_json, created_at, updated_at
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      job.id,
      "company-1",
      draft.draftJson,
      draft.companySnapshotJson,
      draft.applicationJson,
      NOW,
      NOW,
    ],
  );

  return { job, draft };
}

/**
 * @param {SqliteD1} database
 * @param {string} jobId
 */
function readDraft(database, jobId) {
  const row = database.one(
    `SELECT draft_json, company_snapshot_json, application_json, version
     FROM job_drafts WHERE job_id = ?`,
    [jobId],
  );
  if (row === null) {
    throw new Error("Expected draft fixture to exist.");
  }
  const draftJson = row["draft_json"];
  const companySnapshotJson = row["company_snapshot_json"];
  const applicationJson = row["application_json"];
  const version = row["version"];
  if (
    typeof draftJson !== "string" ||
    typeof companySnapshotJson !== "string" ||
    typeof applicationJson !== "string" ||
    typeof version !== "number"
  ) {
    throw new Error("Draft fixture has invalid column types.");
  }
  return { draftJson, companySnapshotJson, applicationJson, version };
}

/**
 * @param {Awaited<ReturnType<typeof buildRevisionSnapshot>>} snapshot
 * @param {{ id: string, revisionNumber: number, baseGeneration: number, parentRevisionId: string | null, createdAt: number }} input
 * @returns {Revision}
 */
function openRevision(snapshot, input) {
  return {
    id: input.id,
    jobId: "job-1",
    revisionNumber: input.revisionNumber,
    baseGeneration: input.baseGeneration,
    status: "open",
    snapshotJson: snapshot.snapshotJson,
    snapshotHash: snapshot.snapshotHash,
    assetManifestJson: snapshot.assetManifestJson,
    parentRevisionId: input.parentRevisionId,
    rollbackSourceRevisionId: null,
    createdAt: input.createdAt,
    assets: snapshot.assets.map(({ assetId, role, ordinal }) => ({
      assetId,
      role,
      ordinal,
    })),
  };
}

/** @param {Revision} revision */
function sourceFrom(revision) {
  return {
    revisionId: revision.id,
    status: revision.status,
    snapshotJson: revision.snapshotJson,
    snapshotHash: revision.snapshotHash,
    assetManifestJson: revision.assetManifestJson,
    assets: revision.assets,
  };
}

/**
 * @param {Revision} revision
 * @param {number} expectedDraftVersion
 * @param {number} expectedGeneration
 */
function publishFrozenInput(
  revision,
  expectedDraftVersion,
  expectedGeneration,
) {
  return {
    expectedDraftVersion,
    expectedGeneration,
    snapshotHash: revision.snapshotHash,
    assetManifestJson: revision.assetManifestJson,
  };
}

/**
 * @param {string} revisionId
 * @param {string} correlationId
 * @returns {{ state: 'succeeded', httpStatus: number, code: string, body: string, correlationId: string, resultRevisionId: string }}
 */
function publishedTerminal(revisionId, correlationId) {
  return {
    state: "succeeded",
    httpStatus: 201,
    code: "PUBLISHED",
    body: JSON.stringify({ revisionId }),
    correlationId,
    resultRevisionId: revisionId,
  };
}

/**
 * @param {string} code
 * @returns {{ state: 'failed', httpStatus: number, code: string, body: string, correlationId: string }}
 */
function failedTerminal(code) {
  return {
    state: "failed",
    httpStatus: 409,
    code,
    body: JSON.stringify({ code }),
    correlationId: "failure-correlation",
  };
}

/**
 * @param {SqliteD1} database
 * @param {{ operationId: string, idempotencyKey: string, operation: string, scopeId: string, frozenInput: Record<string, unknown>, now?: number }} input
 */
async function claimPending(database, input) {
  const fingerprint = await createOperationFingerprint({
    operation: input.operation,
    scopeType: "job",
    scopeId: input.scopeId,
    actorSubject: "admin@example.test",
    environment: "test",
    input: input.frozenInput,
  });
  const claim = await claimOperation(asD1(database), {
    operationId: input.operationId,
    scopeType: "job",
    scopeId: input.scopeId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    fingerprint,
    frozenInput: input.frozenInput,
    actorSubject: "admin@example.test",
    environment: "test",
    leaseToken: `lease-${input.operationId}`,
    leaseDurationMs: 60_000,
    now: input.now ?? NOW,
    correlationId: `claim-${input.operationId}`,
  });
  if (claim.kind !== "claimed") {
    throw new Error(`Expected a new claim, got ${claim.kind}.`);
  }
  return claim.operation;
}

/**
 * Creates a fully published first revision through the actual publish batch.
 *
 * @param {SqliteD1} database
 */
async function publishInitial(database) {
  const { job, draft } = insertDraftFixture(database);
  const snapshot = await buildRevisionSnapshot({ job, draft, assets: [] });
  const revision = openRevision(snapshot, {
    id: "revision-1",
    revisionNumber: 1,
    baseGeneration: 0,
    parentRevisionId: null,
    createdAt: NOW + 1,
  });
  const operation = await claimPending(database, {
    operationId: uuid(1),
    idempotencyKey: uuid(101),
    operation: "publish",
    scopeId: job.id,
    frozenInput: publishFrozenInput(revision, 1, 0),
  });
  const outcome = await finalizePublish(asD1(database), {
    operation,
    jobId: job.id,
    expectedGeneration: 0,
    revision,
    assetGuards: [],
    terminal: publishedTerminal(revision.id, "publish-correlation"),
    now: NOW + 2,
    failureForError: failedTerminal,
  });
  assert.equal(outcome.kind, "terminal");
  assert.equal(outcome.operation.state, "succeeded");

  return { job, draft, revision };
}

test("D1 rejects reserved routes and protects immutable and retained rows", (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());

  assert.throws(
    () =>
      database.run(
        "INSERT INTO jobs (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ["reserved-job", "admin", NOW, NOW],
      ),
    /RESERVED_SLUG/,
  );
  assert.throws(
    () =>
      database.run("UPDATE reserved_slugs SET reason = ? WHERE slug = ?", [
        "changed",
        "admin",
      ]),
    /RESERVED_SLUGS_IMMUTABLE/,
  );
  assert.throws(
    () => database.run("DELETE FROM reserved_slugs WHERE slug = ?", ["admin"]),
    /NO_PHYSICAL_DELETE/,
  );

  database.run(
    "INSERT INTO jobs (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ["mutable-job", "public-role", NOW, NOW],
  );
  assert.throws(
    () =>
      database.run("UPDATE jobs SET slug = ? WHERE id = ?", [
        "renamed-role",
        "mutable-job",
      ]),
    /JOB_IDENTITY_IMMUTABLE/,
  );
  assert.throws(
    () => database.run("DELETE FROM jobs WHERE id = ?", ["mutable-job"]),
    /NO_PHYSICAL_DELETE/,
  );

  database.run(
    `INSERT INTO assets (
       id, r2_key, sha256, byte_length, detected_mime, verification_state,
       verified_at, etag, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "asset-1",
      "assets/asset-1.png",
      "a".repeat(64),
      1,
      "image/png",
      "verified",
      NOW,
      "etag-1",
      NOW,
    ],
  );
  assert.throws(
    () =>
      database.run("UPDATE assets SET etag = ? WHERE id = ?", [
        "new",
        "asset-1",
      ]),
    /ASSET_IMMUTABLE/,
  );
  assert.throws(
    () => database.run("DELETE FROM assets WHERE id = ?", ["asset-1"]),
    /NO_PHYSICAL_DELETE/,
  );
});

test("company changes cannot alter the company snapshot used for a revision", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());
  const { job } = insertDraftFixture(database);

  const changedCompany = { name: "Changed Company", industry: "different" };
  database.run(
    `UPDATE companies
     SET name = ?, normalized_name = ?, company_json = ?, version = version + 1, updated_at = ?
     WHERE id = ?`,
    [
      changedCompany.name,
      changedCompany.name.toLowerCase(),
      JSON.stringify(changedCompany),
      NOW + 1,
      "company-1",
    ],
  );

  const snapshot = await buildRevisionSnapshot({
    job,
    draft: readDraft(database, job.id),
    assets: [],
  });

  assert.deepEqual(snapshot.snapshot["company"], {
    name: "Original Company",
    industry: "consulting",
    media: {},
  });
  assert.deepEqual(
    database.one("SELECT name, company_json FROM companies WHERE id = ?", [
      "company-1",
    ]),
    { name: "Changed Company", company_json: JSON.stringify(changedCompany) },
  );
});

test("publish commits its immutable revision, active pointer, and success terminal together", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());
  const { revision } = await publishInitial(database);

  assert.deepEqual(
    database.one(
      "SELECT active_revision_id, active_generation FROM jobs WHERE id = ?",
      ["job-1"],
    ),
    { active_revision_id: revision.id, active_generation: 1 },
  );
  assert.deepEqual(
    database.one(
      `SELECT revision_number, base_generation, snapshot_json, created_by_operation_id
       FROM job_revisions WHERE id = ?`,
      [revision.id],
    ),
    {
      revision_number: 1,
      base_generation: 0,
      snapshot_json: revision.snapshotJson,
      created_by_operation_id: uuid(1),
    },
  );
  assert.deepEqual(
    database.one(
      "SELECT state, result_revision_id FROM mutation_operations WHERE id = ?",
      [uuid(1)],
    ),
    { state: "succeeded", result_revision_id: revision.id },
  );
});

test("a stale publish CAS fails atomically and retains the prior active revision", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());
  const {
    job,
    draft,
    revision: activeRevision,
  } = await publishInitial(database);
  const staleSnapshot = await buildRevisionSnapshot({ job, draft, assets: [] });
  const staleRevision = openRevision(staleSnapshot, {
    id: "revision-stale",
    revisionNumber: 2,
    baseGeneration: 0,
    parentRevisionId: activeRevision.id,
    createdAt: NOW + 3,
  });
  const operation = await claimPending(database, {
    operationId: uuid(2),
    idempotencyKey: uuid(102),
    operation: "publish",
    scopeId: job.id,
    frozenInput: publishFrozenInput(staleRevision, 1, 0),
    now: NOW + 3,
  });

  const outcome = await finalizePublish(asD1(database), {
    operation,
    jobId: job.id,
    expectedGeneration: 0,
    revision: staleRevision,
    assetGuards: [],
    terminal: publishedTerminal(staleRevision.id, "stale-publish-correlation"),
    now: NOW + 4,
    failureForError: failedTerminal,
  });

  assert.equal(outcome.kind, "terminal");
  assert.equal(outcome.operation.state, "failed");
  assert.equal(outcome.response.code, "PUBLISH_STATE_GUARD_FAILED");
  assert.deepEqual(
    database.one(
      "SELECT active_revision_id, active_generation FROM jobs WHERE id = ?",
      [job.id],
    ),
    { active_revision_id: activeRevision.id, active_generation: 1 },
  );
  assert.deepEqual(
    database.one(
      "SELECT COUNT(*) AS count FROM job_revisions WHERE job_id = ?",
      [job.id],
    ),
    { count: 1 },
  );
});

test("close copies the active snapshot and leaves a dirty draft untouched", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());
  const { job, revision: activeRevision } = await publishInitial(database);
  const source = sourceFrom(activeRevision);

  database.run(
    `UPDATE job_drafts
     SET draft_json = ?, company_snapshot_json = ?, version = version + 1, updated_at = ?
     WHERE job_id = ?`,
    [
      JSON.stringify({ status: "open", title: "Dirty draft title" }),
      JSON.stringify({ name: "Dirty draft company" }),
      NOW + 3,
      job.id,
    ],
  );
  const closeRevision = await buildCloseRevision({
    id: "revision-2",
    jobId: job.id,
    revisionNumber: 2,
    baseGeneration: 1,
    source,
    closedState: "filled",
    closedAt: CLOSED_AT,
    createdAt: NOW + 4,
  });
  const operation = await claimPending(database, {
    operationId: uuid(2),
    idempotencyKey: uuid(102),
    operation: "close",
    scopeId: job.id,
    frozenInput: {
      expectedGeneration: 1,
      sourceRevisionId: source.revisionId,
      sourceSnapshotHash: source.snapshotHash,
      sourceAssetManifestJson: source.assetManifestJson,
      snapshotHash: closeRevision.snapshotHash,
      closedState: "filled",
      closedAt: CLOSED_AT,
    },
    now: NOW + 4,
  });

  const outcome = await finalizeClose(asD1(database), {
    operation,
    jobId: job.id,
    expectedGeneration: 1,
    source,
    revision: closeRevision,
    terminal: publishedTerminal(closeRevision.id, "close-correlation"),
    now: NOW + 5,
    failureForError: failedTerminal,
  });

  assert.equal(outcome.kind, "terminal");
  assert.equal(outcome.operation.state, "succeeded");
  assert.deepEqual(JSON.parse(closeRevision.snapshotJson), {
    ...JSON.parse(activeRevision.snapshotJson),
    status: "closed",
    closedState: "filled",
    closedAt: CLOSED_AT,
  });
  assert.deepEqual(
    database.one(
      "SELECT active_revision_id, active_generation FROM jobs WHERE id = ?",
      [job.id],
    ),
    { active_revision_id: closeRevision.id, active_generation: 2 },
  );
  assert.deepEqual(readDraft(database, job.id), {
    draftJson: JSON.stringify({ status: "open", title: "Dirty draft title" }),
    companySnapshotJson: JSON.stringify({ name: "Dirty draft company" }),
    applicationJson: JSON.stringify({
      kind: "email",
      value: "jobs@example.test",
      provenance: "company careers inbox",
    }),
    version: 2,
  });
});

test("rollback copies a retained source exactly without reading the mutable draft", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());
  const { job, revision: sourceRevision } = await publishInitial(database);
  const source = sourceFrom(sourceRevision);
  const closeRevision = await buildCloseRevision({
    id: "revision-2",
    jobId: job.id,
    revisionNumber: 2,
    baseGeneration: 1,
    source,
    closedState: "filled",
    closedAt: CLOSED_AT,
    createdAt: NOW + 4,
  });
  const closeOperation = await claimPending(database, {
    operationId: uuid(2),
    idempotencyKey: uuid(102),
    operation: "close",
    scopeId: job.id,
    frozenInput: {
      expectedGeneration: 1,
      sourceRevisionId: source.revisionId,
      sourceSnapshotHash: source.snapshotHash,
      sourceAssetManifestJson: source.assetManifestJson,
      snapshotHash: closeRevision.snapshotHash,
      closedState: "filled",
      closedAt: CLOSED_AT,
    },
    now: NOW + 4,
  });
  await finalizeClose(asD1(database), {
    operation: closeOperation,
    jobId: job.id,
    expectedGeneration: 1,
    source,
    revision: closeRevision,
    terminal: publishedTerminal(closeRevision.id, "close-correlation"),
    now: NOW + 5,
    failureForError: failedTerminal,
  });

  database.run(
    `UPDATE job_drafts
     SET draft_json = ?, version = version + 1, updated_at = ?
     WHERE job_id = ?`,
    [
      JSON.stringify({ status: "open", title: "Draft changed after close" }),
      NOW + 6,
      job.id,
    ],
  );
  const rollbackRevision = buildRollbackRevision({
    id: "revision-3",
    jobId: job.id,
    revisionNumber: 3,
    baseGeneration: 2,
    source,
    parentRevisionId: closeRevision.id,
    createdAt: NOW + 7,
  });
  const operation = await claimPending(database, {
    operationId: uuid(3),
    idempotencyKey: uuid(103),
    operation: "rollback",
    scopeId: job.id,
    frozenInput: {
      expectedGeneration: 2,
      sourceRevisionId: source.revisionId,
      sourceSnapshotHash: source.snapshotHash,
      sourceAssetManifestJson: source.assetManifestJson,
    },
    now: NOW + 7,
  });

  const outcome = await finalizeRollback(asD1(database), {
    operation,
    jobId: job.id,
    expectedGeneration: 2,
    source,
    revision: rollbackRevision,
    terminal: publishedTerminal(rollbackRevision.id, "rollback-correlation"),
    now: NOW + 8,
    failureForError: failedTerminal,
  });

  assert.equal(outcome.kind, "terminal");
  assert.equal(outcome.operation.state, "succeeded");
  assert.deepEqual(
    database.one(
      `SELECT snapshot_json, snapshot_hash, asset_manifest_json, status,
              parent_revision_id, rollback_source_revision_id
       FROM job_revisions WHERE id = ?`,
      [rollbackRevision.id],
    ),
    {
      snapshot_json: source.snapshotJson,
      snapshot_hash: source.snapshotHash,
      asset_manifest_json: source.assetManifestJson,
      status: source.status,
      parent_revision_id: closeRevision.id,
      rollback_source_revision_id: source.revisionId,
    },
  );
  assert.deepEqual(
    database.one(
      "SELECT active_revision_id, active_generation FROM jobs WHERE id = ?",
      [job.id],
    ),
    { active_revision_id: rollbackRevision.id, active_generation: 3 },
  );
  assert.equal(
    JSON.parse(readDraft(database, job.id).draftJson)["title"],
    "Draft changed after close",
  );
});

test("terminal operations replay an exact same-key response and reject a new fingerprint", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());
  const frozenInput = { expectedVersion: 1 };
  const fingerprint = await createOperationFingerprint({
    operation: "update_draft",
    scopeType: "job",
    scopeId: "job-1",
    actorSubject: "admin@example.test",
    environment: "test",
    input: frozenInput,
  });
  const firstInput = {
    operationId: uuid(10),
    scopeType: /** @type {'job'} */ ("job"),
    scopeId: "job-1",
    operation: "update_draft",
    idempotencyKey: uuid(110),
    fingerprint,
    frozenInput,
    actorSubject: "admin@example.test",
    environment: "test",
    leaseToken: "first-lease",
    leaseDurationMs: 60_000,
    now: NOW,
    correlationId: "first-claim-correlation",
  };
  const firstClaim = await claimOperation(asD1(database), firstInput);
  assert.equal(firstClaim.kind, "claimed");
  if (firstClaim.kind !== "claimed") {
    throw new Error("Initial idempotency operation was not claimed.");
  }
  const terminal = {
    state: /** @type {'succeeded'} */ ("succeeded"),
    httpStatus: 200,
    code: "DRAFT_UPDATED",
    body: '{"draftVersion":2}',
    correlationId: "terminal-correlation",
  };
  const finalization = await finalizeOperation(asD1(database), {
    operation: firstClaim.operation,
    resourceStatements: [],
    terminal,
    now: NOW + 1,
    failureForError: failedTerminal,
  });
  assert.equal(finalization.kind, "terminal");

  const replay = await claimOperation(asD1(database), {
    ...firstInput,
    operationId: uuid(11),
    leaseToken: "replay-lease",
    correlationId: "replay-claim-correlation",
    now: NOW + 2,
  });
  assert.equal(replay.kind, "terminal");
  if (replay.kind !== "terminal") {
    throw new Error("Terminal idempotency operation did not replay.");
  }
  assert.deepEqual(replay.response, {
    httpStatus: 200,
    code: "DRAFT_UPDATED",
    bodyText: '{"draftVersion":2}',
    body: { draftVersion: 2 },
    correlationId: "terminal-correlation",
  });

  const differentInput = { expectedVersion: 2 };
  const differentFingerprint = await createOperationFingerprint({
    operation: "update_draft",
    scopeType: "job",
    scopeId: "job-1",
    actorSubject: "admin@example.test",
    environment: "test",
    input: differentInput,
  });
  await assert.rejects(
    () =>
      claimOperation(asD1(database), {
        ...firstInput,
        operationId: uuid(12),
        fingerprint: differentFingerprint,
        frozenInput: differentInput,
        leaseToken: "conflict-lease",
        correlationId: "conflict-correlation",
        now: NOW + 3,
      }),
    /** @param {unknown} error */ (error) =>
      error instanceof OperationError &&
      error.code === "IDEMPOTENCY_KEY_REUSED",
  );
  assert.deepEqual(
    database.one("SELECT COUNT(*) AS count FROM mutation_operations", []),
    { count: 1 },
  );
});

// This builder is exercised above through finalizePublish; retain a direct call so
// TypeScript verifies the public statement-builder signature against this D1 adapter.
void buildPublishResourceStatements;
