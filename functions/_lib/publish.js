import { d1Statement } from "./db.js";
import { createAssetGuardStatements, finalizeOperation } from "./operations.js";
import { buildClosedSnapshot, canonicalJson } from "./snapshot.js";

const hashPattern = /^[0-9a-f]{64}$/u;
const revisionStatuses = new Set(["open", "closed"]);
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A stable public-safe error for invalid publication batch input. */
export class PublicationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "PublicationError";
    this.code = code;
  }
}

/**
 * Builds only the resource statements for a publish transition. Pass these statements
 * to `finalizeOperation`; it prepends the lease guard and appends durable terminal
 * storage in one D1 batch.
 *
 * The migration verifies persisted draft version/generation, asset metadata/reference,
 * revision bindings, and the active-pointer transition. No affected-row count decides
 * whether publication succeeded.
 *
 * @param {D1Database} database
 * @param {{
 *   operation: import('./operations.js').PendingOperation,
 *   jobId: string,
 *   expectedGeneration: number,
 *   revision: PublicationRevision,
 *   assetGuards: readonly PublicationAssetGuard[],
 *   now: number
 * }} input
 * @returns {D1PreparedStatement[]}
 */
export function buildPublishResourceStatements(database, input) {
  assertPublicationInput(input, "publish");
  return [
    ...createAssetGuardStatements(database, {
      operationId: input.operation.id,
      assets: input.assetGuards.map((asset) => ({
        ...asset,
        requireActiveDraftRef: true,
        createdAt: input.now,
      })),
    }),
    createRevisionInsertStatement(database, input.operation.id, input.revision),
    ...createRevisionAssetStatements(
      database,
      input.revision.id,
      input.revision.assets,
    ),
    createPointerStatement(
      database,
      input.jobId,
      input.revision.id,
      input.expectedGeneration,
      input.now,
    ),
  ];
}

/**
 * Runs the complete publish operation batch with terminal replay/lease recovery.
 * `failureForError` must return a public-safe JSON terminal response and must never
 * include a raw D1 error.
 *
 * @param {D1Database} database
 * @param {{
 *   operation: import('./operations.js').PendingOperation,
 *   jobId: string,
 *   expectedGeneration: number,
 *   revision: PublicationRevision,
 *   assetGuards: readonly PublicationAssetGuard[],
 *   terminal: import('./operations.js').TerminalOperation,
 *   now: number,
 *   failureForError: (code: string) => import('./operations.js').TerminalOperation
 * }} input
 */
export function finalizePublish(database, input) {
  return finalizeOperation(database, {
    operation: input.operation,
    resourceStatements: buildPublishResourceStatements(database, input),
    terminal: input.terminal,
    now: input.now,
    failureForError: input.failureForError,
  });
}

/**
 * Builds a closed revision from the active source snapshot. This performs no draft or
 * company read. Callers must put the returned snapshot hash in the frozen close input
 * before claiming the durable operation.
 *
 * @param {{
 *   id: string,
 *   jobId: string,
 *   revisionNumber: number,
 *   baseGeneration: number,
 *   source: ActiveRevisionSource,
 *   closedState: string,
 *   closedAt: string,
 *   createdAt: number
 * }} input
 * @returns {Promise<PublicationRevision>}
 */
export async function buildCloseRevision(input) {
  assertSource(input.source, "CLOSE_SOURCE_INVALID");
  assertRevisionIdentity(
    input.id,
    input.revisionNumber,
    input.baseGeneration,
    input.createdAt,
  );
  const closed = await buildClosedSnapshot({
    snapshot: input.source.snapshotJson,
    closedState: input.closedState,
    closedAt: input.closedAt,
  });
  return {
    id: input.id,
    jobId: input.jobId,
    revisionNumber: input.revisionNumber,
    baseGeneration: input.baseGeneration,
    status: "closed",
    snapshotJson: closed.snapshotJson,
    snapshotHash: closed.snapshotHash,
    assetManifestJson: input.source.assetManifestJson,
    parentRevisionId: input.source.revisionId,
    rollbackSourceRevisionId: null,
    createdAt: input.createdAt,
    assets: input.source.assets,
  };
}

/**
 * Builds resource statements for close. Revision asset bindings are copied directly
 * from the frozen active source, so a dirty draft cannot affect a close transition.
 *
 * @param {D1Database} database
 * @param {{
 *   operation: import('./operations.js').PendingOperation,
 *   jobId: string,
 *   expectedGeneration: number,
 *   source: ActiveRevisionSource,
 *   revision: PublicationRevision,
 *   now: number
 * }} input
 * @returns {D1PreparedStatement[]}
 */
export function buildCloseResourceStatements(database, input) {
  assertPublicationInput(input, "close");
  assertSource(input.source, "CLOSE_SOURCE_INVALID");
  if (
    input.revision.status !== "closed" ||
    input.revision.parentRevisionId !== input.source.revisionId ||
    input.revision.rollbackSourceRevisionId !== null ||
    input.revision.assetManifestJson !== input.source.assetManifestJson
  ) {
    throw new PublicationError(
      "CLOSE_REVISION_INVALID",
      "Closed revision does not match its active source.",
    );
  }
  return [
    createRevisionInsertStatement(database, input.operation.id, input.revision),
    d1Statement(
      database,
      `INSERT INTO revision_assets (revision_id, asset_id, role, ordinal)
       SELECT ?, asset_id, role, ordinal
       FROM revision_assets
       WHERE revision_id = ?
       ORDER BY role ASC, ordinal ASC`,
      [input.revision.id, input.source.revisionId],
    ),
    createPointerStatement(
      database,
      input.jobId,
      input.revision.id,
      input.expectedGeneration,
      input.now,
    ),
  ];
}

/**
 * Runs the complete close batch with the same durable terminal replay semantics as
 * publish. Its resource builder has no draft reads or draft asset guards.
 *
 * @param {D1Database} database
 * @param {{
 *   operation: import('./operations.js').PendingOperation,
 *   jobId: string,
 *   expectedGeneration: number,
 *   source: ActiveRevisionSource,
 *   revision: PublicationRevision,
 *   terminal: import('./operations.js').TerminalOperation,
 *   now: number,
 *   failureForError: (code: string) => import('./operations.js').TerminalOperation
 * }} input
 */
export function finalizeClose(database, input) {
  return finalizeOperation(database, {
    operation: input.operation,
    resourceStatements: buildCloseResourceStatements(database, input),
    terminal: input.terminal,
    now: input.now,
    failureForError: input.failureForError,
  });
}

/**
 * Creates a byte-for-byte rollback copy of a retained source revision. No draft,
 * company, or mutable asset read participates in this operation.
 *
 * @param {{
 *   id: string,
 *   jobId: string,
 *   revisionNumber: number,
 *   baseGeneration: number,
 *   source: ActiveRevisionSource,
 *   parentRevisionId: string | null,
 *   createdAt: number
 * }} input
 * @returns {PublicationRevision}
 */
export function buildRollbackRevision(input) {
  assertSource(input.source, "ROLLBACK_SOURCE_INVALID");
  assertRevisionIdentity(
    input.id,
    input.revisionNumber,
    input.baseGeneration,
    input.createdAt,
  );
  return {
    id: input.id,
    jobId: input.jobId,
    revisionNumber: input.revisionNumber,
    baseGeneration: input.baseGeneration,
    status: input.source.status,
    snapshotJson: input.source.snapshotJson,
    snapshotHash: input.source.snapshotHash,
    assetManifestJson: input.source.assetManifestJson,
    parentRevisionId: input.parentRevisionId,
    rollbackSourceRevisionId: input.source.revisionId,
    createdAt: input.createdAt,
    assets: input.source.assets,
  };
}

/**
 * Builds resource statements for a rollback. The source bindings are copied in D1 and
 * the migration proves the copied snapshot/hash/manifest are exact before the pointer
 * can change.
 *
 * @param {D1Database} database
 * @param {{
 *   operation: import('./operations.js').PendingOperation,
 *   jobId: string,
 *   expectedGeneration: number,
 *   source: ActiveRevisionSource,
 *   revision: PublicationRevision,
 *   now: number
 * }} input
 * @returns {D1PreparedStatement[]}
 */
export function buildRollbackResourceStatements(database, input) {
  assertPublicationInput(input, "rollback");
  assertSource(input.source, "ROLLBACK_SOURCE_INVALID");
  if (
    input.revision.parentRevisionId === undefined ||
    input.revision.rollbackSourceRevisionId !== input.source.revisionId ||
    input.revision.snapshotJson !== input.source.snapshotJson ||
    input.revision.snapshotHash !== input.source.snapshotHash ||
    input.revision.assetManifestJson !== input.source.assetManifestJson ||
    input.revision.status !== input.source.status
  ) {
    throw new PublicationError(
      "ROLLBACK_REVISION_INVALID",
      "Rollback revision does not exactly match its source.",
    );
  }
  return [
    createRevisionInsertStatement(database, input.operation.id, input.revision),
    d1Statement(
      database,
      `INSERT INTO revision_assets (revision_id, asset_id, role, ordinal)
       SELECT ?, asset_id, role, ordinal
       FROM revision_assets
       WHERE revision_id = ?
       ORDER BY role ASC, ordinal ASC`,
      [input.revision.id, input.source.revisionId],
    ),
    createPointerStatement(
      database,
      input.jobId,
      input.revision.id,
      input.expectedGeneration,
      input.now,
    ),
  ];
}

/**
 * Runs the complete rollback batch with durable operation recovery.
 *
 * @param {D1Database} database
 * @param {{
 *   operation: import('./operations.js').PendingOperation,
 *   jobId: string,
 *   expectedGeneration: number,
 *   source: ActiveRevisionSource,
 *   revision: PublicationRevision,
 *   terminal: import('./operations.js').TerminalOperation,
 *   now: number,
 *   failureForError: (code: string) => import('./operations.js').TerminalOperation
 * }} input
 */
export function finalizeRollback(database, input) {
  return finalizeOperation(database, {
    operation: input.operation,
    resourceStatements: buildRollbackResourceStatements(database, input),
    terminal: input.terminal,
    now: input.now,
    failureForError: input.failureForError,
  });
}

/**
 * @param {D1Database} database
 * @param {string} operationId
 * @param {PublicationRevision} revision
 * @returns {D1PreparedStatement}
 */
function createRevisionInsertStatement(database, operationId, revision) {
  return d1Statement(
    database,
    `INSERT INTO job_revisions (
       id, job_id, revision_number, base_generation, status, snapshot_json,
       snapshot_hash, asset_manifest_json, parent_revision_id,
       rollback_source_revision_id, created_by_operation_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      revision.id,
      revision.jobId,
      revision.revisionNumber,
      revision.baseGeneration,
      revision.status,
      revision.snapshotJson,
      revision.snapshotHash,
      revision.assetManifestJson,
      revision.parentRevisionId,
      revision.rollbackSourceRevisionId,
      operationId,
      revision.createdAt,
    ],
  );
}

/**
 * @param {D1Database} database
 * @param {string} revisionId
 * @param {readonly RevisionAssetBinding[]} assets
 * @returns {D1PreparedStatement[]}
 */
function createRevisionAssetStatements(database, revisionId, assets) {
  return assets.map((asset) =>
    d1Statement(
      database,
      "INSERT INTO revision_assets (revision_id, asset_id, role, ordinal) VALUES (?, ?, ?, ?)",
      [revisionId, asset.assetId, asset.role, asset.ordinal],
    ),
  );
}

/**
 * @param {D1Database} database
 * @param {string} jobId
 * @param {string} revisionId
 * @param {number} expectedGeneration
 * @param {number} now
 * @returns {D1PreparedStatement}
 */
function createPointerStatement(
  database,
  jobId,
  revisionId,
  expectedGeneration,
  now,
) {
  return d1Statement(
    database,
    `UPDATE jobs
     SET active_revision_id = ?, active_generation = active_generation + 1, updated_at = ?
     WHERE id = ? AND active_generation = ?`,
    [revisionId, now, jobId, expectedGeneration],
  );
}

/**
 * @param {{ operation: import('./operations.js').PendingOperation, jobId: string, expectedGeneration: number, revision: PublicationRevision, now: number }} input
 * @param {'publish' | 'close' | 'rollback'} operation
 */
function assertPublicationInput(input, operation) {
  if (
    input.operation.operation !== operation ||
    input.operation.scopeType !== "job" ||
    input.operation.scopeId !== input.jobId
  ) {
    throw new PublicationError(
      "PUBLICATION_OPERATION_INVALID",
      "Publication operation does not match its job scope.",
    );
  }
  if (
    !Number.isSafeInteger(input.expectedGeneration) ||
    input.expectedGeneration < 0 ||
    input.revision.baseGeneration !== input.expectedGeneration
  ) {
    throw new PublicationError(
      "PUBLICATION_GENERATION_INVALID",
      "Publication generation is invalid.",
    );
  }
  assertRevision(input.revision, input.jobId);
  if (!Number.isSafeInteger(input.now) || input.now <= 0) {
    throw new PublicationError(
      "PUBLICATION_TIME_INVALID",
      "Publication time is invalid.",
    );
  }
}

/**
 * @param {PublicationRevision} revision
 * @param {string} jobId
 */
function assertRevision(revision, jobId) {
  assertRevisionIdentity(
    revision.id,
    revision.revisionNumber,
    revision.baseGeneration,
    revision.createdAt,
  );
  if (
    revision.jobId !== jobId ||
    !revisionStatuses.has(revision.status) ||
    typeof revision.snapshotJson !== "string" ||
    !hashPattern.test(revision.snapshotHash) ||
    typeof revision.assetManifestJson !== "string" ||
    !Array.isArray(revision.assets)
  ) {
    throw new PublicationError(
      "PUBLICATION_REVISION_INVALID",
      "Publication revision is invalid.",
    );
  }
  let snapshot;
  let assetManifest;
  try {
    snapshot = JSON.parse(revision.snapshotJson);
    assetManifest = JSON.parse(revision.assetManifestJson);
  } catch {
    throw new PublicationError(
      "PUBLICATION_REVISION_INVALID",
      "Publication revision JSON is invalid.",
    );
  }
  if (
    !isRecord(snapshot) ||
    snapshot["status"] !== revision.status ||
    !Array.isArray(assetManifest) ||
    revision.assetManifestJson !==
      canonicalJson(
        revision.assets.map(({ assetId, role, ordinal }) => ({
          assetId,
          role,
          ordinal,
        })),
      )
  ) {
    throw new PublicationError(
      "PUBLICATION_REVISION_INVALID",
      "Publication revision does not match its asset manifest.",
    );
  }
  const bindings = new Set();
  for (const asset of revision.assets) {
    if (
      typeof asset.assetId !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(asset.role) ||
      !Number.isSafeInteger(asset.ordinal) ||
      asset.ordinal < 0
    ) {
      throw new PublicationError(
        "PUBLICATION_ASSET_INVALID",
        "Publication revision asset is invalid.",
      );
    }
    const binding = `${asset.role}:${asset.ordinal}`;
    if (bindings.has(binding)) {
      throw new PublicationError(
        "PUBLICATION_ASSET_INVALID",
        "Publication revision asset roles must be unique.",
      );
    }
    bindings.add(binding);
  }
}

/**
 * @param {string} id
 * @param {number} revisionNumber
 * @param {number} baseGeneration
 * @param {number} createdAt
 */
function assertRevisionIdentity(id, revisionNumber, baseGeneration, createdAt) {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    !Number.isSafeInteger(revisionNumber) ||
    revisionNumber < 1 ||
    !Number.isSafeInteger(baseGeneration) ||
    baseGeneration < 0 ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0
  ) {
    throw new PublicationError(
      "PUBLICATION_REVISION_INVALID",
      "Publication revision identity is invalid.",
    );
  }
}

/**
 * @param {ActiveRevisionSource} source
 * @param {string} code
 */
function assertSource(source, code) {
  if (
    typeof source.revisionId !== "string" ||
    !revisionStatuses.has(source.status) ||
    typeof source.snapshotJson !== "string" ||
    !hashPattern.test(source.snapshotHash) ||
    typeof source.assetManifestJson !== "string" ||
    !Array.isArray(source.assets)
  ) {
    throw new PublicationError(code, "Active revision source is invalid.");
  }
}

/**
 * @typedef {{ assetId: string, role: string, ordinal: number }} RevisionAssetBinding
 * @typedef {RevisionAssetBinding & { sha256: string, mimeType: string, byteLength: number }} PublicationAssetGuard
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
 *   assets: readonly RevisionAssetBinding[]
 * }} PublicationRevision
 * @typedef {{
 *   revisionId: string,
 *   status: 'open' | 'closed',
 *   snapshotJson: string,
 *   snapshotHash: string,
 *   assetManifestJson: string,
 *   assets: readonly RevisionAssetBinding[]
 * }} ActiveRevisionSource
 */
