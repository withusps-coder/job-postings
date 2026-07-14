import { d1Statement } from "../../../../_lib/db.js";
import {
  buildRollbackRevision,
  finalizeRollback,
} from "../../../../_lib/publish.js";
import { readFrozenSource } from "./close.js";
import {
  failureFrozenInput,
  failureTerminal,
  readFrozenRevision,
  requiredInteger,
  requiredString,
  runPublicationMutation,
  successTerminal,
} from "./publish.js";

/**
 * Repoints a job through a new immutable copy of a retained source revision.
 *
 * @param {EventContext<import("./publish.js").AdminPublicationEnvironment, "id", import("./publish.js").AdminContextData>} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  return runPublicationMutation(context, {
    operation: "rollback",
    expectedFields: ["expectedGeneration", "sourceRevisionId"],
    parseIntent: parseRollbackIntent,
    fingerprintInput: (intent) => intent,
    prepare: prepareRollback,
    finalize: finalizeRollbackMutation,
  });
}

/**
 * @param {D1Database} database
 * @param {string} jobId
 * @param {Record<string, unknown>} intent
 * @param {string | undefined} retryOf
 * @param {number} now
 * @returns {Promise<Record<string, unknown>>}
 */
async function prepareRollback(database, jobId, intent, retryOf, now) {
  const rollbackIntent = parseRollbackIntent(intent);
  const state = await readRollbackState(
    database,
    jobId,
    rollbackIntent.sourceRevisionId,
  );
  if (state.kind === "job_missing")
    return failureFrozenInput(rollbackIntent, retryOf, "JOB_NOT_FOUND");
  if (state.kind === "no_active_revision")
    return failureFrozenInput(rollbackIntent, retryOf, "NO_ACTIVE_REVISION");
  if (state.kind === "source_missing")
    return failureFrozenInput(
      rollbackIntent,
      retryOf,
      "ROLLBACK_SOURCE_NOT_FOUND",
    );

  try {
    const revision = buildRollbackRevision({
      id: crypto.randomUUID(),
      jobId,
      revisionNumber: state.activeGeneration + 1,
      baseGeneration: state.activeGeneration,
      source: asActiveSource(state.source),
      parentRevisionId: state.activeRevisionId,
      createdAt: now,
    });

    return {
      ...rollbackIntent,
      ...(retryOf === undefined ? {} : { retryOf }),
      sourceRevisionId: state.source.id,
      sourceSnapshotHash: state.source.snapshotHash,
      sourceAssetManifestJson: state.source.assetManifestJson,
      source: state.source,
      revision,
    };
  } catch {
    return failureFrozenInput(
      rollbackIntent,
      retryOf,
      "ROLLBACK_INPUT_INVALID",
    );
  }
}

/**
 * @param {D1Database} database
 * @param {import("../../../../_lib/operations.js").PendingOperation} operation
 * @param {import("./publish.js").PublicationFrozenInput} frozenInput
 * @param {number} now
 * @param {string} correlationId
 */
async function finalizeRollbackMutation(
  database,
  operation,
  frozenInput,
  now,
  correlationId,
) {
  const intent = parseRollbackIntent(frozenInput);
  const source = readFrozenSource(frozenInput);
  const revision = readFrozenRevision(frozenInput);
  const sourceRevisionId = requiredString(frozenInput["sourceRevisionId"]);
  const sourceSnapshotHash = requiredHash(frozenInput["sourceSnapshotHash"]);
  const sourceAssetManifestJson = requiredString(
    frozenInput["sourceAssetManifestJson"],
  );

  if (
    source.revisionId !== sourceRevisionId ||
    source.snapshotHash !== sourceSnapshotHash ||
    source.assetManifestJson !== sourceAssetManifestJson ||
    source.revisionId !== intent.sourceRevisionId ||
    revision.rollbackSourceRevisionId !== source.revisionId ||
    revision.snapshotJson !== source.snapshotJson ||
    revision.snapshotHash !== source.snapshotHash ||
    revision.assetManifestJson !== source.assetManifestJson ||
    revision.status !== source.status
  ) {
    throw new TypeError("Frozen rollback input does not match its source.");
  }

  return finalizeRollback(database, {
    operation,
    jobId: operation.scopeId,
    expectedGeneration: intent.expectedGeneration,
    source,
    revision,
    terminal: successTerminal(
      "ROLLED_BACK",
      "The job was rolled back.",
      revision,
      correlationId,
    ),
    now,
    failureForError: (code) => failureTerminal(code, correlationId),
  });
}

/**
 * Reads the active pointer and immutable source revision independently of all drafts.
 *
 * @param {D1Database} database
 * @param {string} jobId
 * @param {string} sourceRevisionId
 * @returns {Promise<RollbackState>}
 */
async function readRollbackState(database, jobId, sourceRevisionId) {
  const job = await d1Statement(
    database,
    "SELECT active_revision_id, active_generation FROM jobs WHERE id = ?",
    [jobId],
  ).first();
  if (job === null) return { kind: "job_missing" };
  if (!isActivePointerD1Row(job))
    throw new TypeError("Invalid active pointer row.");
  if (job["active_revision_id"] === null) return { kind: "no_active_revision" };

  const source = await d1Statement(
    database,
    `SELECT
       id,
       revision_number,
       base_generation,
       status,
       snapshot_json,
       snapshot_hash,
       asset_manifest_json,
       parent_revision_id,
       rollback_source_revision_id,
       created_at
     FROM job_revisions
     WHERE id = ? AND job_id = ?`,
    [sourceRevisionId, jobId],
  ).first();
  if (source === null) return { kind: "source_missing" };
  if (!isRollbackSourceD1Row(source))
    throw new TypeError("Invalid rollback source row.");

  const revisionId = requiredString(source["id"]);
  const bindings = await d1Statement(
    database,
    `SELECT
       revision_assets.asset_id,
       revision_assets.role,
       revision_assets.ordinal,
       assets.detected_mime,
       assets.byte_length,
       assets.sha256
     FROM revision_assets
     JOIN assets ON assets.id = revision_assets.asset_id
     WHERE revision_assets.revision_id = ?
     ORDER BY revision_assets.role ASC, revision_assets.ordinal ASC`,
    [revisionId],
  ).all();

  const status = source["status"];
  if (status !== "open" && status !== "closed")
    throw new TypeError("Invalid rollback source status.");
  const parentRevisionId = source["parent_revision_id"];
  const rollbackSourceRevisionId = source["rollback_source_revision_id"];
  return {
    kind: "ready",
    activeRevisionId: requiredString(job["active_revision_id"]),
    activeGeneration: requiredInteger(job["active_generation"], 0),
    source: {
      id: revisionId,
      jobId,
      revisionNumber: requiredInteger(source["revision_number"], 1),
      baseGeneration: requiredInteger(source["base_generation"], 0),
      status,
      snapshotJson: requiredString(source["snapshot_json"]),
      snapshotHash: requiredHash(source["snapshot_hash"]),
      assetManifestJson: requiredString(source["asset_manifest_json"]),
      parentRevisionId:
        parentRevisionId === null ? null : requiredString(parentRevisionId),
      rollbackSourceRevisionId:
        rollbackSourceRevisionId === null
          ? null
          : requiredString(rollbackSourceRevisionId),
      createdAt: requiredInteger(source["created_at"], 1),
      assets: bindings.results.map(readRevisionAsset),
    },
  };
}
/**
 * @param {Record<string, unknown>} row
 * @returns {import("./publish.js").FrozenAsset}
 */
function readRevisionAsset(row) {
  if (!isRevisionAssetD1Row(row))
    throw new TypeError("Invalid revision asset row.");
  return {
    assetId: requiredString(row["asset_id"]),
    role: requiredString(row["role"]),
    ordinal: requiredInteger(row["ordinal"], 0),
    mimeType: requiredMimeType(row["detected_mime"]),
    byteLength: requiredInteger(row["byte_length"], 1),
    sha256: requiredHash(row["sha256"]),
  };
}

/** @param {Record<string, unknown>} row @returns {row is RevisionAssetD1Row} */
function isRevisionAssetD1Row(row) {
  return (
    Object.hasOwn(row, "asset_id") &&
    Object.hasOwn(row, "role") &&
    Object.hasOwn(row, "ordinal") &&
    Object.hasOwn(row, "detected_mime") &&
    Object.hasOwn(row, "byte_length") &&
    Object.hasOwn(row, "sha256")
  );
}

/** @param {Record<string, unknown>} row @returns {row is ActivePointerD1Row} */
function isActivePointerD1Row(row) {
  return (
    Object.hasOwn(row, "active_revision_id") &&
    Object.hasOwn(row, "active_generation")
  );
}

/** @param {Record<string, unknown>} row @returns {row is RollbackSourceD1Row} */
function isRollbackSourceD1Row(row) {
  return (
    Object.hasOwn(row, "id") &&
    Object.hasOwn(row, "revision_number") &&
    Object.hasOwn(row, "base_generation") &&
    Object.hasOwn(row, "status") &&
    Object.hasOwn(row, "snapshot_json") &&
    Object.hasOwn(row, "snapshot_hash") &&
    Object.hasOwn(row, "asset_manifest_json") &&
    Object.hasOwn(row, "parent_revision_id") &&
    Object.hasOwn(row, "rollback_source_revision_id") &&
    Object.hasOwn(row, "created_at")
  );
}

/**
 * @param {import("./publish.js").FrozenRevision} revision
 * @returns {import("../../../../_lib/publish.js").ActiveRevisionSource}
 */
function asActiveSource(revision) {
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
 * @param {import("./publish.js").PublicationRequestBody} body
 * @returns {RollbackIntent}
 */
function parseRollbackIntent(body) {
  const sourceRevisionId = requiredString(body["sourceRevisionId"]);
  if (sourceRevisionId.length > 128)
    throw new TypeError("Invalid source revision identifier.");
  return {
    expectedGeneration: requiredInteger(body["expectedGeneration"], 0),
    sourceRevisionId,
  };
}

/** @param {unknown} value @returns {string} */
function requiredHash(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new TypeError("Invalid hash.");
  return value;
}

/** @param {unknown} value @returns {"image/png" | "image/jpeg" | "image/webp" | "application/pdf"} */
function requiredMimeType(value) {
  if (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "application/pdf"
  ) {
    return value;
  }
  throw new TypeError("Invalid asset MIME type.");
}

/**
 * @typedef {{ expectedGeneration: number, sourceRevisionId: string }} RollbackIntent
 * @typedef {Record<string, unknown> & { active_revision_id: unknown, active_generation: unknown }} ActivePointerD1Row
 * @typedef {Record<string, unknown> & { id: unknown, revision_number: unknown, base_generation: unknown, status: unknown, snapshot_json: unknown, snapshot_hash: unknown, asset_manifest_json: unknown, parent_revision_id: unknown, rollback_source_revision_id: unknown, created_at: unknown }} RollbackSourceD1Row
 * @typedef {Record<string, unknown> & { asset_id: unknown, role: unknown, ordinal: unknown, detected_mime: unknown, byte_length: unknown, sha256: unknown }} RevisionAssetD1Row
 * @typedef {{ kind: "job_missing" } | { kind: "no_active_revision" } | { kind: "source_missing" } | { kind: "ready", activeRevisionId: string, activeGeneration: number, source: import("./publish.js").FrozenRevision }} RollbackState
 */
