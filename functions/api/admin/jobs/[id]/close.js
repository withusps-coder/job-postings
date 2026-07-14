import { d1Statement } from "../../../../_lib/db.js";
import { buildCloseRevision, finalizeClose } from "../../../../_lib/publish.js";
import {
  failureFrozenInput,
  failureTerminal,
  isRecord,
  readFrozenRevision,
  requiredInteger,
  requiredString,
  runPublicationMutation,
  successTerminal,
} from "./publish.js";

/**
 * Closes the current active revision without reading or changing the mutable draft.
 *
 * @param {EventContext<import("./publish.js").AdminPublicationEnvironment, "id", import("./publish.js").AdminContextData>} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  return runPublicationMutation(context, {
    operation: "close",
    expectedFields: ["expectedGeneration", "closedState"],
    parseIntent: parseCloseIntent,
    fingerprintInput: (intent) => intent,
    prepare: prepareClose,
    finalize: finalizeCloseMutation,
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
async function prepareClose(database, jobId, intent, retryOf, now) {
  const closeIntent = parseCloseIntent(intent);
  const source = await readCurrentActiveSource(database, jobId);
  if (source.kind === "job_missing")
    return failureFrozenInput(closeIntent, retryOf, "JOB_NOT_FOUND");
  if (source.kind === "no_active_revision")
    return failureFrozenInput(closeIntent, retryOf, "NO_ACTIVE_REVISION");
  if (source.revision.status !== "open")
    return failureFrozenInput(closeIntent, retryOf, "ALREADY_CLOSED");

  try {
    const closedAt = new Date(now).toISOString();
    const revision = await buildCloseRevision({
      id: crypto.randomUUID(),
      jobId,
      revisionNumber: source.activeGeneration + 1,
      baseGeneration: source.activeGeneration,
      source: asActiveSource(source.revision),
      closedState: closeIntent.closedState,
      closedAt,
      createdAt: now,
    });

    return {
      ...closeIntent,
      ...(retryOf === undefined ? {} : { retryOf }),
      sourceRevisionId: source.revision.id,
      sourceSnapshotHash: source.revision.snapshotHash,
      sourceAssetManifestJson: source.revision.assetManifestJson,
      snapshotHash: revision.snapshotHash,
      closedAt,
      source: source.revision,
      revision,
    };
  } catch {
    return failureFrozenInput(closeIntent, retryOf, "CLOSE_INPUT_INVALID");
  }
}

/**
 * @param {D1Database} database
 * @param {import("../../../../_lib/operations.js").PendingOperation} operation
 * @param {import("./publish.js").PublicationFrozenInput} frozenInput
 * @param {number} now
 * @param {string} correlationId
 */
async function finalizeCloseMutation(
  database,
  operation,
  frozenInput,
  now,
  correlationId,
) {
  const intent = parseCloseIntent(frozenInput);
  const source = readFrozenSource(frozenInput);
  const revision = readFrozenRevision(frozenInput);
  const sourceRevisionId = requiredString(frozenInput["sourceRevisionId"]);
  const sourceSnapshotHash = requiredString(frozenInput["sourceSnapshotHash"]);
  const sourceAssetManifestJson = requiredString(
    frozenInput["sourceAssetManifestJson"],
  );
  const snapshotHash = requiredString(frozenInput["snapshotHash"]);
  const closedAt = requiredString(frozenInput["closedAt"]);

  /** @type {unknown} */
  let snapshot;
  try {
    snapshot = JSON.parse(revision.snapshotJson);
  } catch {
    throw new TypeError("Frozen close snapshot is invalid.");
  }
  if (
    !isRecord(snapshot) ||
    source.revisionId !== sourceRevisionId ||
    source.snapshotHash !== sourceSnapshotHash ||
    source.assetManifestJson !== sourceAssetManifestJson ||
    revision.snapshotHash !== snapshotHash ||
    revision.status !== "closed" ||
    snapshot["status"] !== "closed" ||
    snapshot["closedState"] !== intent.closedState ||
    snapshot["closedAt"] !== closedAt
  ) {
    throw new TypeError("Frozen close input does not match its source.");
  }

  return finalizeClose(database, {
    operation,
    jobId: operation.scopeId,
    expectedGeneration: intent.expectedGeneration,
    source,
    revision,
    terminal: successTerminal(
      "CLOSED",
      "The job was closed.",
      revision,
      correlationId,
    ),
    now,
    failureForError: (code) => failureTerminal(code, correlationId),
  });
}

/**
 * Reads only immutable active-revision rows and their immutable asset bindings.
 * No draft or draft-asset table is referenced by this close path.
 *
 * @param {D1Database} database
 * @param {string} jobId
 * @returns {Promise<CurrentActiveSource>}
 */
async function readCurrentActiveSource(database, jobId) {
  const job = await d1Statement(
    database,
    `SELECT
       jobs.active_revision_id,
       jobs.active_generation,
       revisions.id,
       revisions.revision_number,
       revisions.base_generation,
       revisions.status,
       revisions.snapshot_json,
       revisions.snapshot_hash,
       revisions.asset_manifest_json,
       revisions.parent_revision_id,
       revisions.rollback_source_revision_id,
       revisions.created_at
     FROM jobs
     LEFT JOIN job_revisions AS revisions ON revisions.id = jobs.active_revision_id
     WHERE jobs.id = ?`,
    [jobId],
  ).first();

  if (job === null) return { kind: "job_missing" };
  if (!isCurrentActiveRevisionD1Row(job))
    throw new TypeError("Invalid active revision row.");
  if (job["active_revision_id"] === null) return { kind: "no_active_revision" };

  const revisionId = requiredString(job["id"]);
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

  const status = job["status"];
  if (status !== "open" && status !== "closed")
    throw new TypeError("Invalid active revision status.");
  const parentRevisionId = job["parent_revision_id"];
  const rollbackSourceRevisionId = job["rollback_source_revision_id"];
  return {
    kind: "active",
    activeGeneration: requiredInteger(job["active_generation"], 0),
    revision: {
      id: revisionId,
      jobId,
      revisionNumber: requiredInteger(job["revision_number"], 1),
      baseGeneration: requiredInteger(job["base_generation"], 0),
      status,
      snapshotJson: requiredString(job["snapshot_json"]),
      snapshotHash: requiredHash(job["snapshot_hash"]),
      assetManifestJson: requiredString(job["asset_manifest_json"]),
      parentRevisionId:
        parentRevisionId === null ? null : requiredString(parentRevisionId),
      rollbackSourceRevisionId:
        rollbackSourceRevisionId === null
          ? null
          : requiredString(rollbackSourceRevisionId),
      createdAt: requiredInteger(job["created_at"], 1),
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

/**
 * @param {Record<string, unknown>} row
 * @returns {row is CurrentActiveRevisionD1Row}
 */
function isCurrentActiveRevisionD1Row(row) {
  return (
    Object.hasOwn(row, "active_revision_id") &&
    Object.hasOwn(row, "active_generation") &&
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
 * @param {import("./publish.js").PublicationFrozenInput} frozenInput
 * @returns {import("../../../../_lib/publish.js").ActiveRevisionSource}
 */
export function readFrozenSource(frozenInput) {
  if (!isRecord(frozenInput["source"]))
    throw new TypeError("Missing frozen source.");
  const revision = readFrozenRevision({ revision: frozenInput["source"] });
  return asActiveSource(revision);
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
 * @returns {CloseIntent}
 */
function parseCloseIntent(body) {
  const closedState = requiredString(body["closedState"]);
  if (closedState.trim().length === 0 || closedState.length > 512)
    throw new TypeError("Invalid closed state.");
  return {
    expectedGeneration: requiredInteger(body["expectedGeneration"], 0),
    closedState,
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
 * @typedef {{ expectedGeneration: number, closedState: string }} CloseIntent
 * @typedef {Record<string, unknown> & { active_revision_id: unknown, active_generation: unknown, id: unknown, revision_number: unknown, base_generation: unknown, status: unknown, snapshot_json: unknown, snapshot_hash: unknown, asset_manifest_json: unknown, parent_revision_id: unknown, rollback_source_revision_id: unknown, created_at: unknown }} CurrentActiveRevisionD1Row
 * @typedef {Record<string, unknown> & { asset_id: unknown, role: unknown, ordinal: unknown, detected_mime: unknown, byte_length: unknown, sha256: unknown }} RevisionAssetD1Row
 * @typedef {{ kind: "job_missing" } | { kind: "no_active_revision" } | { kind: "active", activeGeneration: number, revision: import("./publish.js").FrozenRevision }} CurrentActiveSource
 */
