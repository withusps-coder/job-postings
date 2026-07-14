import { d1Statement, readDraftByJobId } from "../functions/_lib/db.js";
import {
  createImmutableMediaKey,
  MediaError,
  putImmutableMedia,
  reconcileImmutableMedia,
} from "../functions/_lib/media.js";
import {
  claimOperation,
  createOperationFingerprint,
  finalizeOperation,
} from "../functions/_lib/operations.js";
import { finalizePublish } from "../functions/_lib/publish.js";
import { createAttachAssetStatements } from "../functions/_lib/upload.js";
import { canonicalJson } from "../functions/_lib/snapshot.js";
import {
  auditAblearnMigration,
  prepareAblearnMigration,
  readAblearnMigrationEvidence,
} from "./audit-ablearn-migration.mjs";

const mutationLeaseMilliseconds = 60_000;
/**
 * @typedef {{ operationId: string, idempotencyKey: string }} OperationDefinition
 * @typedef {import("../functions/_lib/operations.js").PendingOperation} PendingOperation
 * @typedef {import("../functions/_lib/operations.js").TerminalOperation} TerminalOperation
 * @typedef {(path: string, encoding?: "utf8") => Promise<unknown>} EvidenceFileReader
 * @typedef {{ database: D1Database, bucket: R2Bucket, environment: string, actorSubject: string, baseDirectory: string | undefined, fileReader: EvidenceFileReader | undefined, now: () => number }} MigrationInput
 * @typedef {{ id: string, r2Key: string, sha256: string, byteLength: number, detectedMime: string, etag: string }} ImportedAssetRow
 * @typedef {{ ordinal: number }} DraftAssetReferenceRow
 * @typedef {{ slug: string, activeGeneration: number, activeRevisionId: string, snapshotJson: string, snapshotHash: string, assetManifestJson: string, status: "open" | "closed" }} ActiveMigrationRow
 * @typedef {{ assetId: string, role: string, ordinal: number }} RevisionAssetBindingRow
 * @typedef {{ assetId: string, role: string, ordinal: number }} AssetManifestEntry
 */

/**
 * Fixed identities make the one-time importer replayable without deriving mutable
 * operation input from the clock. They are not runtime/public identifiers until the
 * final publish pointer batch succeeds.
 */
export const ABLEARN_MIGRATION_OPERATIONS = Object.freeze({
  seed: Object.freeze({
    operationId: "2a7269f7-a845-5b21-8640-0e1c04ade021",
    idempotencyKey: "2a7269f7-a845-5b22-8640-0e1c04ade022",
  }),
  assets: Object.freeze({
    "company-logo": Object.freeze({
      operationId: "2a7269f7-a845-5b31-8640-0e1c04ade031",
      idempotencyKey: "2a7269f7-a845-5b32-8640-0e1c04ade032",
    }),
    "company-map": Object.freeze({
      operationId: "2a7269f7-a845-5b41-8640-0e1c04ade041",
      idempotencyKey: "2a7269f7-a845-5b42-8640-0e1c04ade042",
    }),
    "company-document": Object.freeze({
      operationId: "2a7269f7-a845-5b51-8640-0e1c04ade051",
      idempotencyKey: "2a7269f7-a845-5b52-8640-0e1c04ade052",
    }),
  }),
  publish: Object.freeze({
    operationId: "2a7269f7-a845-5b61-8640-0e1c04ade061",
    idempotencyKey: "2a7269f7-a845-5b62-8640-0e1c04ade062",
  }),
});

/** A stable failure for a migration precondition or immutable evidence mismatch. */
export class AblearnMigrationError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Imports reviewed Ablearn fixture evidence into injected D1/R2 bindings. This module has
 * no credential, deployment, or production-resource lookup; an approved bound runner
 * must pass the target environment explicitly.
 *
 * A terminal rerun returns the original durable publish response. A concurrently
 * leased operation returns an in-progress response and performs no further transition.
 *
 * @param {unknown} input
 * @returns {Promise<{ httpStatus: number, code: string, bodyText: string, body: unknown, correlationId: string | null }>}
 */
export async function migrateAblearnToD1(input) {
  const migrationInput = parseMigrationInput(input);
  const audit = await auditAblearnMigration(
    migrationInput.baseDirectory,
    migrationInput.fileReader,
  );
  if (!audit.valid) {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_EVIDENCE_INVALID",
      audit.failures.join("; "),
    );
  }

  const evidence = await readAblearnMigrationEvidence(
    migrationInput.baseDirectory,
    migrationInput.fileReader,
  );
  assertPreActivationRendering(evidence);
  const plan = prepareAblearnMigration(evidence);
  const context = {
    database: migrationInput.database,
    bucket: migrationInput.bucket,
    environment: migrationInput.environment,
    actorSubject: migrationInput.actorSubject,
    now: migrationInput.now,
    createdAt: Date.parse(plan.migration.createdAt),
  };
  if (!Number.isSafeInteger(context.createdAt) || context.createdAt <= 0) {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_EVIDENCE_INVALID",
      "Migration evidence has an invalid deterministic creation time.",
    );
  }

  const seed = await seedMigration(context, plan);
  const seedResponse = terminalOrInProgress(seed, "seed");
  if (seedResponse) return seedResponse;

  for (const [index, asset] of plan.assets.entries()) {
    const outcome = await importAsset(context, plan, asset, index + 1);
    const response = terminalOrInProgress(outcome, `asset:${asset.role}`);
    if (response) return response;
  }

  await verifyImportedAssets(context, plan);
  const published = await publishMigration(context, plan);
  const publishResponse = terminalOrInProgress(published, "publish");
  if (publishResponse) return publishResponse;

  if (published.kind !== "terminal") {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_OPERATION_INVALID",
      "The publish operation did not return a terminal outcome.",
    );
  }
  await verifyActivatedMigration(context, plan);
  return published.response;
}

/**
 * Seeds the mutable D1 sources through one durable operation. No active pointer or
 * revision is created here, so failure leaves the job invisible to public runtime.
 *
 * @param {MigrationContext} context
 * @param {MigrationPlan} plan
 */
async function seedMigration(context, plan) {
  const companyJson = canonicalJson(plan.draft.companySnapshotJson);
  const frozenInput = {
    company: {
      id: plan.migration.companyId,
      normalizedName: plan.normalizedJob.company.name.trim().toLowerCase(),
      companyJson,
    },
    job: { id: plan.migration.jobId, slug: plan.normalizedJob.slug },
    draft: {
      version: 1,
      draftJson: canonicalJson(plan.draft.draftJson),
      companySnapshotJson: companyJson,
      applicationJson: canonicalJson(plan.draft.applicationJson),
    },
    sourceSnapshotHash: plan.snapshot.snapshotHash,
    createdAt: context.createdAt,
  };
  const claim = await claimMigrationOperation(context, {
    definition: ABLEARN_MIGRATION_OPERATIONS.seed,
    operation: "create_job",
    frozenInput,
  });
  if (claim.kind !== "claimed") return claim;
  const operation = pendingOperation(claim);

  const terminal = successTerminal(
    201,
    "ABLEARN_MIGRATION_SEEDED",
    {
      companyId: plan.migration.companyId,
      jobId: plan.migration.jobId,
      slug: plan.normalizedJob.slug,
      draftVersion: 1,
    },
    correlationId(),
  );
  return finalizeOperation(context.database, {
    operation,
    resourceStatements: [
      d1Statement(
        context.database,
        `INSERT INTO companies (
           id, name, normalized_name, company_json, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [
          plan.migration.companyId,
          plan.normalizedJob.company.name,
          frozenInput.company.normalizedName,
          companyJson,
          context.createdAt,
          context.createdAt,
        ],
      ),
      d1Statement(
        context.database,
        `INSERT INTO jobs (
           id, slug, active_revision_id, active_generation, created_at, updated_at
         ) VALUES (?, ?, NULL, 0, ?, ?)`,
        [
          plan.migration.jobId,
          plan.normalizedJob.slug,
          context.createdAt,
          context.createdAt,
        ],
      ),
      d1Statement(
        context.database,
        `INSERT INTO job_drafts (
           job_id, company_id, version, draft_json, company_snapshot_json,
           application_json, created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        [
          plan.migration.jobId,
          plan.migration.companyId,
          frozenInput.draft.draftJson,
          frozenInput.draft.companySnapshotJson,
          frozenInput.draft.applicationJson,
          context.createdAt,
          context.createdAt,
        ],
      ),
    ],
    terminal,
    now: currentTime(context),
    failureForError: () =>
      failureTerminal(409, "ABLEARN_MIGRATION_SEED_FAILED", correlationId()),
  });
}

/**
 * Writes one verified immutable R2 object then atomically stores the immutable asset
 * and its active draft reference in the owning upload operation.
 *
 * @param {MigrationContext} context
 * @param {MigrationPlan} plan
 * @param {MigrationPlan["assets"][number]} asset
 * @param {number} expectedDraftVersion
 */
async function importAsset(context, plan, asset, expectedDraftVersion) {
  const definition = assetOperation(asset.role);
  if (!definition) {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_ASSET_ROLE_INVALID",
      `No durable operation is defined for ${asset.role}.`,
    );
  }
  const r2Key = createImmutableMediaKey(definition.operationId, asset.media);
  const frozenInput = {
    assetId: asset.assetId,
    jobId: plan.migration.jobId,
    role: asset.role,
    ordinal: asset.ordinal,
    source: asset.source,
    r2Key,
    sha256: asset.media.sha256,
    mimeType: asset.media.mimeType,
    byteLength: asset.media.byteLength,
    expectedDraftVersion,
    createdAt: context.createdAt,
  };
  const claim = await claimMigrationOperation(context, {
    definition,
    operation: "upload_asset",
    frozenInput,
  });
  if (claim.kind !== "claimed") return claim;
  const operation = pendingOperation(claim);

  try {
    await assertDraftMatches(context.database, plan, expectedDraftVersion);
    const stored = await putImmutableMedia(context.bucket, r2Key, asset.media);
    const terminal = successTerminal(
      201,
      "ABLEARN_MIGRATION_ASSET_IMPORTED",
      {
        assetId: asset.assetId,
        role: asset.role,
        r2Key,
        sha256: asset.media.sha256,
        mimeType: asset.media.mimeType,
        byteLength: asset.media.byteLength,
      },
      correlationId(),
      { resultAssetId: asset.assetId },
    );
    const finalizedAt = currentTime(context);
    return finalizeOperation(context.database, {
      operation,
      resourceStatements: createAttachAssetStatements(context.database, {
        jobId: plan.migration.jobId,
        expectedDraftVersion,
        asset: {
          id: asset.assetId,
          r2Key: stored.key,
          sha256: asset.media.sha256,
          byteLength: asset.media.byteLength,
          detectedMime: asset.media.mimeType,
          etag: stored.etag,
        },
        role: asset.role,
        ordinal: asset.ordinal,
        now: finalizedAt,
        createAsset: true,
        operationId: definition.operationId,
      }),
      terminal,
      now: finalizedAt,
      failureForError: () =>
        failureTerminal(
          409,
          "ABLEARN_MIGRATION_ASSET_FINALIZATION_FAILED",
          correlationId(),
        ),
    });
  } catch (error) {
    const code =
      error instanceof MediaError
        ? "ABLEARN_MIGRATION_R2_INTEGRITY_FAILED"
        : "ABLEARN_MIGRATION_ASSET_SOURCE_FAILED";
    return finalizeOperation(context.database, {
      operation,
      resourceStatements: [],
      terminal: failureTerminal(409, code, correlationId()),
      now: currentTime(context),
      failureForError: () => failureTerminal(503, code, correlationId()),
    });
  }
}

/**
 * Uses the normal publish primitive so revision insertion, immutable bindings, active
 * pointer generation, and durable terminal response share one guarded D1 batch.
 *
 * @param {MigrationContext} context
 * @param {MigrationPlan} plan
 */
async function publishMigration(context, plan) {
  const expectedDraftVersion = plan.assets.length + 1;
  const frozenInput = {
    expectedDraftVersion,
    expectedGeneration: 0,
    snapshotHash: plan.snapshot.snapshotHash,
    assetManifestJson: plan.snapshot.assetManifestJson,
    revision: {
      id: plan.migration.revisionId,
      jobId: plan.migration.jobId,
      revisionNumber: 1,
      baseGeneration: 0,
      status: plan.normalizedJob.status,
      snapshotJson: plan.snapshot.snapshotJson,
      snapshotHash: plan.snapshot.snapshotHash,
      assetManifestJson: plan.snapshot.assetManifestJson,
      parentRevisionId: null,
      rollbackSourceRevisionId: null,
      createdAt: context.createdAt,
      assets: plan.snapshot.assets,
    },
  };
  const claim = await claimMigrationOperation(context, {
    definition: ABLEARN_MIGRATION_OPERATIONS.publish,
    operation: "publish",
    frozenInput,
  });
  if (claim.kind !== "claimed") return claim;
  const operation = pendingOperation(claim);
  await assertDraftMatches(context.database, plan, expectedDraftVersion);

  const terminal = successTerminal(
    200,
    "ABLEARN_MIGRATION_COMPLETED",
    {
      jobId: plan.migration.jobId,
      slug: plan.normalizedJob.slug,
      activeGeneration: 1,
      revision: {
        id: plan.migration.revisionId,
        revisionNumber: 1,
        snapshotHash: plan.snapshot.snapshotHash,
      },
    },
    correlationId(),
    { resultRevisionId: plan.migration.revisionId },
  );
  return finalizePublish(context.database, {
    operation,
    jobId: plan.migration.jobId,
    expectedGeneration: 0,
    revision: frozenInput.revision,
    assetGuards: plan.snapshot.assets,
    terminal,
    now: currentTime(context),
    failureForError: () =>
      failureTerminal(409, "ABLEARN_MIGRATION_PUBLISH_FAILED", correlationId()),
  });
}

/**
 * Source JSON must still equal the frozen seed before an asset can be attached. The
 * D1 version guard in the final batch remains authoritative against races.
 *
 * @param {D1Database} database
 * @param {MigrationPlan} plan
 * @param {number} expectedVersion
 */
async function assertDraftMatches(database, plan, expectedVersion) {
  const draft = await readDraftByJobId(database, plan.migration.jobId);
  if (
    draft === null ||
    draft.slug !== plan.normalizedJob.slug ||
    draft.companyId !== plan.migration.companyId ||
    draft.activeGeneration !== 0 ||
    draft.activeRevisionId !== null ||
    draft.draftVersion !== expectedVersion ||
    draft.draftJson !== canonicalJson(plan.draft.draftJson) ||
    draft.companySnapshotJson !==
      canonicalJson(plan.draft.companySnapshotJson) ||
    draft.applicationJson !== canonicalJson(plan.draft.applicationJson)
  ) {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_SOURCE_STATE_CONFLICT",
      "The D1 Ablearn draft no longer matches reviewed migration input.",
    );
  }
}

/**
 * @param {string} role
 * @returns {OperationDefinition}
 */
function assetOperation(role) {
  const definitions = /** @type {Record<string, OperationDefinition>} */ (
    ABLEARN_MIGRATION_OPERATIONS.assets
  );
  const definition = definitions[role];
  if (!definition) {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_ASSET_ROLE_INVALID",
      `No durable operation is defined for ${role}.`,
    );
  }
  return definition;
}
/**
 * Rechecks D1 rows and R2 HEAD metadata before the public pointer can move. This is
 * deliberately performed even when prior asset operations replay terminal outcomes.
 *
 * @param {MigrationContext} context
 * @param {MigrationPlan} plan
 */
async function verifyImportedAssets(context, plan) {
  for (const asset of plan.assets) {
    const definition = assetOperation(asset.role);
    const expectedKey = createImmutableMediaKey(
      definition.operationId,
      asset.media,
    );
    const row = parseImportedAssetRow(
      await d1Statement(
        context.database,
        `SELECT id, r2_key, sha256, byte_length, detected_mime, etag
         FROM assets WHERE id = ?`,
        [asset.assetId],
      ).first(),
    );
    if (
      !row ||
      row.id !== asset.assetId ||
      row.r2Key !== expectedKey ||
      row.sha256 !== asset.media.sha256 ||
      row.byteLength !== asset.media.byteLength ||
      row.detectedMime !== asset.media.mimeType
    ) {
      throw new AblearnMigrationError(
        "ABLEARN_MIGRATION_ASSET_STATE_INVALID",
        `D1 asset metadata is not the reviewed ${asset.role} source.`,
      );
    }
    const reconciled = await reconcileImmutableMedia(
      context.bucket,
      expectedKey,
      asset.media,
    );
    if (reconciled.etag !== row.etag) {
      throw new AblearnMigrationError(
        "ABLEARN_MIGRATION_R2_INTEGRITY_FAILED",
        `R2 ${asset.role} ETag does not match D1 immutable metadata.`,
      );
    }
    const reference = parseDraftAssetReferenceRow(
      await d1Statement(
        context.database,
        `SELECT ordinal FROM draft_asset_refs
         WHERE job_id = ? AND asset_id = ? AND role = ? AND detached_at IS NULL`,
        [plan.migration.jobId, asset.assetId, asset.role],
      ).first(),
    );
    if (!reference || reference.ordinal !== asset.ordinal) {
      throw new AblearnMigrationError(
        "ABLEARN_MIGRATION_ASSET_STATE_INVALID",
        `D1 ${asset.role} has no active reviewed draft reference.`,
      );
    }
  }
}
/**
 * Parses the asset row selected by the migration guard. Unrecognized D1 data is a
 * state conflict, never a reason to weaken the pre-activation comparison.
 *
 * @param {unknown} value
 * @returns {ImportedAssetRow | null}
 */
function parseImportedAssetRow(value) {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const r2Key = value["r2_key"];
  const sha256 = value["sha256"];
  const byteLength = value["byte_length"];
  const detectedMime = value["detected_mime"];
  const etag = value["etag"];
  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(r2Key) ||
    !isNonEmptyString(sha256) ||
    !isPositiveInteger(byteLength) ||
    !isNonEmptyString(detectedMime) ||
    !isNonEmptyString(etag)
  ) {
    return null;
  }
  return { id, r2Key, sha256, byteLength, detectedMime, etag };
}

/** @param {unknown} value @returns {DraftAssetReferenceRow | null} */
function parseDraftAssetReferenceRow(value) {
  if (!isRecord(value) || !isNonNegativeInteger(value["ordinal"])) {
    return null;
  }
  return { ordinal: value["ordinal"] };
}

/** @param {unknown} value @returns {ActiveMigrationRow | null} */
function parseActiveMigrationRow(value) {
  if (!isRecord(value)) return null;
  const slug = value["slug"];
  const activeGeneration = value["active_generation"];
  const activeRevisionId = value["active_revision_id"];
  const snapshotJson = value["snapshot_json"];
  const snapshotHash = value["snapshot_hash"];
  const assetManifestJson = value["asset_manifest_json"];
  const status = value["status"];
  if (
    !isNonEmptyString(slug) ||
    !isNonNegativeInteger(activeGeneration) ||
    !isNonEmptyString(activeRevisionId) ||
    !isNonEmptyString(snapshotJson) ||
    !isNonEmptyString(snapshotHash) ||
    !isNonEmptyString(assetManifestJson) ||
    (status !== "open" && status !== "closed")
  ) {
    return null;
  }
  return {
    slug,
    activeGeneration,
    activeRevisionId,
    snapshotJson,
    snapshotHash,
    assetManifestJson,
    status,
  };
}

/** @param {unknown} value @returns {RevisionAssetBindingRow | null} */
function parseRevisionAssetBindingRow(value) {
  if (!isRecord(value)) return null;
  const assetId = value["asset_id"];
  const role = value["role"];
  const ordinal = value["ordinal"];
  if (
    !isNonEmptyString(assetId) ||
    !isNonEmptyString(role) ||
    !isNonNegativeInteger(ordinal)
  ) {
    return null;
  }
  return { assetId, role, ordinal };
}

/**
 * @param {string} manifestJson
 * @returns {AssetManifestEntry[]}
 */
function parseAssetManifest(manifestJson) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(manifestJson);
  } catch {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_ACTIVE_STATE_INVALID",
      "The active revision asset manifest is not valid JSON.",
    );
  }
  if (!Array.isArray(value)) {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_ACTIVE_STATE_INVALID",
      "The active revision asset manifest is invalid.",
    );
  }
  /** @type {AssetManifestEntry[]} */
  const entries = [];
  for (const item of value) {
    if (!isRecord(item)) {
      throw new AblearnMigrationError(
        "ABLEARN_MIGRATION_ACTIVE_STATE_INVALID",
        "The active revision asset manifest is invalid.",
      );
    }
    const assetId = item["assetId"];
    const role = item["role"];
    const ordinal = item["ordinal"];
    if (
      !isNonEmptyString(assetId) ||
      !isNonEmptyString(role) ||
      !isNonNegativeInteger(ordinal)
    ) {
      throw new AblearnMigrationError(
        "ABLEARN_MIGRATION_ACTIVE_STATE_INVALID",
        "The active revision asset manifest is invalid.",
      );
    }
    entries.push({ assetId, role, ordinal });
  }
  return entries;
}

/** @param {unknown} value @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {unknown} value @returns {value is number} */
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** @param {unknown} value @returns {value is number} */
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {Awaited<ReturnType<typeof readAblearnMigrationEvidence>>} evidence
 */
function assertPreActivationRendering(evidence) {
  const expected = evidence.inventory.render;
  if (
    evidence.snapshot.snapshotHash !== expected.snapshotHash ||
    evidence.rendered.headings.length !== expected.headings.length ||
    evidence.rendered.headings.some(
      (heading, index) => heading !== expected.headings[index],
    ) ||
    !evidence.rendered.links.includes(expected.applicationMailto) ||
    expected.contentLinks.some(
      (link) => !evidence.rendered.links.includes(link),
    ) ||
    Object.values(expected.media).some(
      (mediaUrl) => !evidence.renderedHtml.includes(mediaUrl),
    )
  ) {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_RENDER_MISMATCH",
      "The reviewed immutable rendering does not match Ablearn migration evidence.",
    );
  }
}
/** @param {MigrationContext} context @param {MigrationPlan} plan */
async function verifyActivatedMigration(context, plan) {
  const active = parseActiveMigrationRow(
    await d1Statement(
      context.database,
      `SELECT jobs.slug, jobs.active_generation, jobs.active_revision_id,
              revisions.snapshot_json, revisions.snapshot_hash,
              revisions.asset_manifest_json, revisions.status
       FROM jobs
       JOIN job_revisions AS revisions ON revisions.id = jobs.active_revision_id
       WHERE jobs.id = ?`,
      [plan.migration.jobId],
    ).first(),
  );
  if (
    !active ||
    active.slug !== plan.normalizedJob.slug ||
    active.activeGeneration !== 1 ||
    active.activeRevisionId !== plan.migration.revisionId ||
    active.snapshotJson !== plan.snapshot.snapshotJson ||
    active.snapshotHash !== plan.snapshot.snapshotHash ||
    active.assetManifestJson !== plan.snapshot.assetManifestJson ||
    active.status !== plan.normalizedJob.status
  ) {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_ACTIVE_STATE_INVALID",
      "The active D1 revision does not match reviewed immutable migration input.",
    );
  }
  const bindings = await d1Statement(
    context.database,
    `SELECT asset_id, role, ordinal
     FROM revision_assets
     WHERE revision_id = ?
     ORDER BY role ASC, ordinal ASC`,
    [plan.migration.revisionId],
  ).all();
  /** @type {RevisionAssetBindingRow[]} */
  const actual = [];
  for (const binding of bindings.results) {
    const parsedBinding = parseRevisionAssetBindingRow(binding);
    if (!parsedBinding) {
      throw new AblearnMigrationError(
        "ABLEARN_MIGRATION_ACTIVE_STATE_INVALID",
        "The active revision has an invalid asset binding.",
      );
    }
    actual.push(parsedBinding);
  }
  const expected = parseAssetManifest(plan.snapshot.assetManifestJson);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_ACTIVE_STATE_INVALID",
      "The active revision asset bindings do not match its immutable manifest.",
    );
  }
}

/**
 * @param {MigrationContext} context
 * @param {{ definition: { operationId: string, idempotencyKey: string }, operation: string, frozenInput: Record<string, unknown> }} input
 */
async function claimMigrationOperation(context, input) {
  const fingerprint = await createOperationFingerprint({
    operation: input.operation,
    scopeType: "job",
    scopeId: contextJobId(input.frozenInput),
    actorSubject: context.actorSubject,
    environment: context.environment,
    input: input.frozenInput,
  });
  return claimOperation(context.database, {
    operationId: input.definition.operationId,
    scopeType: "job",
    scopeId: contextJobId(input.frozenInput),
    operation: input.operation,
    idempotencyKey: input.definition.idempotencyKey,
    fingerprint,
    frozenInput: input.frozenInput,
    actorSubject: context.actorSubject,
    environment: context.environment,
    leaseToken: correlationId(),
    leaseDurationMs: mutationLeaseMilliseconds,
    now: currentTime(context),
    correlationId: correlationId(),
  });
}
/**
 * @param {Awaited<ReturnType<typeof claimOperation>>} claim
 * @returns {PendingOperation}
 */
function pendingOperation(claim) {
  if (claim.kind !== "claimed") {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_OPERATION_INVALID",
      "Migration operation is not currently claimed.",
    );
  }
  return /** @type {PendingOperation} */ (claim.operation);
}

/** @param {Record<string, unknown>} frozenInput */
function contextJobId(frozenInput) {
  const job = frozenInput["job"];
  if (isRecord(job) && typeof job["id"] === "string") {
    return job["id"];
  }
  if (typeof frozenInput["jobId"] === "string") {
    return frozenInput["jobId"];
  }
  const revision = frozenInput["revision"];
  if (isRecord(revision) && typeof revision["jobId"] === "string") {
    return revision["jobId"];
  }
  throw new AblearnMigrationError(
    "ABLEARN_MIGRATION_OPERATION_INVALID",
    "Migration operation does not have a job scope.",
  );
}

/**
 * @param {Awaited<ReturnType<typeof finalizeOperation>> | Awaited<ReturnType<typeof claimOperation>>} outcome
 * @param {string} phase
 */
function terminalOrInProgress(outcome, phase) {
  if (outcome.kind === "in_progress") {
    return {
      httpStatus: 202,
      code: "ABLEARN_MIGRATION_IN_PROGRESS",
      bodyText: canonicalJson({
        phase,
        retryAfterSeconds: outcome.retryAfterSeconds,
      }),
      body: { phase, retryAfterSeconds: outcome.retryAfterSeconds },
      correlationId: null,
    };
  }
  if (outcome.kind === "terminal" && outcome.operation.state === "failed") {
    return outcome.response;
  }
  return undefined;
}

/**
 * @param {number} httpStatus
 * @param {string} code
 * @param {Record<string, unknown>} body
 * @param {string} terminalCorrelationId
 * @param {{ resultRevisionId?: string, resultAssetId?: string }} [result]
 * @returns {TerminalOperation}
 */
function successTerminal(
  httpStatus,
  code,
  body,
  terminalCorrelationId,
  result = {},
) {
  return {
    state: "succeeded",
    httpStatus,
    code,
    body: canonicalJson(body),
    correlationId: terminalCorrelationId,
    ...result,
  };
}

/** @param {number} httpStatus @param {string} code @param {string} terminalCorrelationId @returns {TerminalOperation} */
function failureTerminal(httpStatus, code, terminalCorrelationId) {
  return {
    state: "failed",
    httpStatus,
    code,
    body: canonicalJson({ code }),
    correlationId: terminalCorrelationId,
  };
}

/** @param {MigrationContext} context */
function currentTime(context) {
  const value = context.now();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AblearnMigrationError(
      "ABLEARN_MIGRATION_CLOCK_INVALID",
      "Migration clock must return a positive safe integer.",
    );
  }
  return value;
}

function correlationId() {
  return crypto.randomUUID();
}

/**
 * Validates the bound runner input before migration evidence or target resources are
 * read. The importer never discovers bindings, credentials, or an environment itself.
 *
 * @param {unknown} value
 * @returns {MigrationInput}
 */
function parseMigrationInput(value) {
  if (!isRecord(value)) {
    throw invalidBindings();
  }
  const allowed = new Set([
    "database",
    "bucket",
    "environment",
    "actorSubject",
    "baseDirectory",
    "fileReader",
    "now",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidBindings();
  }
  const database = value["database"];
  const bucket = value["bucket"];
  const environment = value["environment"];
  const actorSubject = value["actorSubject"];
  const baseDirectory = value["baseDirectory"];
  const fileReader = value["fileReader"];
  const now = value["now"];

  if (
    !isD1Database(database) ||
    !isR2Bucket(bucket) ||
    typeof environment !== "string" ||
    !environment.trim() ||
    environment.length > 80 ||
    (actorSubject !== undefined &&
      (typeof actorSubject !== "string" ||
        !actorSubject.trim() ||
        actorSubject.length > 256)) ||
    (baseDirectory !== undefined &&
      (typeof baseDirectory !== "string" || !baseDirectory.trim())) ||
    (fileReader !== undefined && typeof fileReader !== "function") ||
    (now !== undefined && !isClock(now))
  ) {
    throw invalidBindings();
  }
  return {
    database,
    bucket,
    environment,
    actorSubject: actorSubject ?? "ablearn-migration",
    baseDirectory,
    fileReader:
      typeof fileReader === "function"
        ? /** @type {EvidenceFileReader} */ (fileReader)
        : undefined,
    now: now ?? Date.now,
  };
}

/** @returns {AblearnMigrationError} */
function invalidBindings() {
  return new AblearnMigrationError(
    "ABLEARN_MIGRATION_BINDINGS_INVALID",
    "D1, R2, and an explicit target environment are required.",
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is D1Database} */
function isD1Database(value) {
  return (
    isRecord(value) &&
    typeof value["prepare"] === "function" &&
    typeof value["batch"] === "function"
  );
}

/** @param {unknown} value @returns {value is R2Bucket} */
function isR2Bucket(value) {
  return (
    isRecord(value) &&
    typeof value["put"] === "function" &&
    typeof value["head"] === "function"
  );
}

/** @param {unknown} value @returns {value is () => number} */
function isClock(value) {
  return typeof value === "function";
}

/**
 * @typedef {{ database: D1Database, bucket: R2Bucket, environment: string, actorSubject: string, now: () => number, createdAt: number }} MigrationContext
 * @typedef {ReturnType<typeof prepareAblearnMigration>} MigrationPlan
 */
