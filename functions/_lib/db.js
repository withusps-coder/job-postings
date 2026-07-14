/** @typedef {D1Database | D1DatabaseSession} ReadableD1 */
/** @typedef {Record<string, unknown>} D1Row */

export const PRIMARY_READ_CONSTRAINT = "first-primary";

/** A stable failure used when a public read cannot be pinned to D1 primary. */
export class DatabaseError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}

/**
 * Opens a D1 first-primary session. Public content reads must use this helper rather
 * than the binding directly so a future replica configuration cannot serve stale jobs.
 *
 * @param {D1Database} database
 * @returns {D1DatabaseSession}
 */
export function primaryReadSession(database) {
  if (typeof database.withSession !== "function") {
    throw new DatabaseError(
      "D1_PRIMARY_SESSION_UNAVAILABLE",
      "D1 first-primary sessions are required.",
    );
  }
  return database.withSession(PRIMARY_READ_CONSTRAINT);
}

/**
 * Creates a parameterized D1 statement without interpolating public or admin input.
 *
 * @param {ReadableD1} database
 * @param {string} sql
 * @param {readonly unknown[]} [params]
 * @returns {D1PreparedStatement}
 */
export function d1Statement(database, sql, params = []) {
  return database.prepare(sql).bind(...params);
}

/**
 * Executes an atomic D1 batch. Callers must put lease/asset guards before resource
 * writes and terminal operation storage.
 *
 * @param {D1Database} database
 * @param {readonly D1PreparedStatement[]} statements
 * @returns {Promise<D1Result<unknown>[]>}
 */
export function executeBatch(database, statements) {
  if (statements.length === 0) {
    throw new DatabaseError(
      "D1_BATCH_EMPTY",
      "An empty D1 batch cannot enforce a transition.",
    );
  }
  return database.batch([...statements]);
}

/**
 * Reads the active immutable snapshot for a root job slug from D1 primary.
 * Mutable companies, drafts, and source JSON are intentionally absent from this query.
 *
 * @param {D1Database} database
 * @param {string} slug
 * @returns {Promise<ActiveRevisionRow | null>}
 */
export async function readActiveRevisionBySlug(database, slug) {
  const session = primaryReadSession(database);
  const result = await d1Statement(
    session,
    `SELECT
       jobs.id AS job_id,
       jobs.slug,
       jobs.active_generation,
       revisions.id AS revision_id,
       revisions.revision_number,
       revisions.status,
       revisions.snapshot_json,
       revisions.snapshot_hash,
       revisions.asset_manifest_json,
       revisions.created_at AS revision_created_at
     FROM jobs
     JOIN job_revisions AS revisions ON revisions.id = jobs.active_revision_id
     WHERE jobs.slug = ?`,
    [slug],
  ).first();
  return result === null ? null : mapActiveRevision(result);
}

/**
 * Reads active open-list snapshots from D1 primary. The returned snapshots are the
 * only allowed source for public list and sitemap output.
 *
 * @param {D1Database} database
 * @param {{ limit?: number, offset?: number }} [page]
 * @returns {Promise<ActiveRevisionRow[]>}
 */
export async function readActiveOpenRevisions(database, page = {}) {
  const limit = boundedPageValue(page.limit, 100, "D1_PAGE_LIMIT_INVALID");
  const offset = boundedPageValue(page.offset, 0, "D1_PAGE_OFFSET_INVALID");
  const session = primaryReadSession(database);
  const result = await d1Statement(
    session,
    `SELECT
       jobs.id AS job_id,
       jobs.slug,
       jobs.active_generation,
       revisions.id AS revision_id,
       revisions.revision_number,
       revisions.status,
       revisions.snapshot_json,
       revisions.snapshot_hash,
       revisions.asset_manifest_json,
       revisions.created_at AS revision_created_at
     FROM jobs
     JOIN job_revisions AS revisions ON revisions.id = jobs.active_revision_id
     WHERE revisions.status = 'open'
     ORDER BY revisions.created_at DESC, jobs.slug ASC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  ).all();
  return result.results.map(mapActiveRevision);
}

/**
 * Reads ordered immutable bindings for a retained revision from D1 primary.
 *
 * @param {D1Database} database
 * @param {string} revisionId
 * @returns {Promise<RevisionAssetRow[]>}
 */
export async function readRevisionAssets(database, revisionId) {
  const session = primaryReadSession(database);
  const result = await d1Statement(
    session,
    `SELECT
       revision_assets.revision_id,
       revision_assets.asset_id,
       revision_assets.role,
       revision_assets.ordinal,
       assets.r2_key,
       assets.sha256,
       assets.byte_length,
       assets.detected_mime,
       assets.etag
     FROM revision_assets
     JOIN assets ON assets.id = revision_assets.asset_id
     JOIN job_revisions AS revisions ON revisions.id = revision_assets.revision_id
     WHERE revision_assets.revision_id = ?
     ORDER BY revision_assets.role ASC, revision_assets.ordinal ASC`,
    [revisionId],
  ).all();
  return result.results.map(mapRevisionAsset);
}

/**
 * Finds a publicly eligible asset. A draft reference is deliberately insufficient;
 * eligibility requires at least one immutable retained revision binding.
 *
 * @param {D1Database} database
 * @param {string} assetId
 * @returns {Promise<PublicAssetRow | null>}
 */
export async function readPublicAsset(database, assetId) {
  const session = primaryReadSession(database);
  const result = await d1Statement(
    session,
    `SELECT
       assets.id AS asset_id,
       assets.r2_key,
       assets.sha256,
       assets.byte_length,
       assets.detected_mime,
       assets.etag
     FROM assets
     WHERE assets.id = ?
       AND assets.verification_state = 'verified'
       AND assets.detected_mime IN ('image/png', 'image/jpeg', 'image/webp', 'application/pdf')
       AND EXISTS (
         SELECT 1
         FROM revision_assets
         JOIN job_revisions ON job_revisions.id = revision_assets.revision_id
         WHERE revision_assets.asset_id = assets.id
       )`,
    [assetId],
  ).first();
  return result === null ? null : mapPublicAsset(result);
}

/**
 * Reads one mutable draft for an Access-protected handler. This is intentionally not a
 * public-read helper and must never be used for SSR list/detail/sitemap rendering.
 *
 * @param {D1Database} database
 * @param {string} jobId
 * @returns {Promise<DraftRow | null>}
 */
export async function readDraftByJobId(database, jobId) {
  const result = await d1Statement(
    database,
    `SELECT
       jobs.id AS job_id,
       jobs.slug,
       jobs.active_revision_id,
       jobs.active_generation,
       drafts.company_id,
       drafts.version AS draft_version,
       drafts.draft_json,
       drafts.company_snapshot_json,
       drafts.application_json,
       drafts.updated_at AS draft_updated_at
     FROM jobs
     JOIN job_drafts AS drafts ON drafts.job_id = jobs.id
     WHERE jobs.id = ?`,
    [jobId],
  ).first();
  return result === null ? null : mapDraft(result);
}

/**
 * Parses a JSON column while preserving a stable, non-SQL error code for callers.
 *
 * @param {unknown} value
 * @param {string} code
 * @returns {Record<string, unknown> | unknown[]}
 */
export function parseJsonColumn(value, code) {
  if (typeof value !== "string") {
    throw new DatabaseError(code, "D1 JSON column is invalid.");
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("not JSON object or array");
    }
    return /** @type {Record<string, unknown> | unknown[]} */ (parsed);
  } catch {
    throw new DatabaseError(code, "D1 JSON column is invalid.");
  }
}

/**
 * @typedef {{ jobId: string, slug: string, activeGeneration: number, revisionId: string, revisionNumber: number, status: 'open' | 'closed', snapshotJson: string, snapshotHash: string, assetManifestJson: string, revisionCreatedAt: number }} ActiveRevisionRow
 * @typedef {{ revisionId: string, assetId: string, role: string, ordinal: number, r2Key: string, sha256: string, byteLength: number, detectedMime: string, etag: string }} RevisionAssetRow
 * @typedef {{ assetId: string, r2Key: string, sha256: string, byteLength: number, detectedMime: string, etag: string }} PublicAssetRow
 * @typedef {{ jobId: string, slug: string, activeRevisionId: string | null, activeGeneration: number, companyId: string | null, draftVersion: number, draftJson: string, companySnapshotJson: string, applicationJson: string, draftUpdatedAt: number }} DraftRow
 */

/**
 * @param {D1Row} row
 * @returns {ActiveRevisionRow}
 */
function mapActiveRevision(row) {
  return {
    jobId: requiredRowString(row, "job_id"),
    slug: requiredRowString(row, "slug"),
    activeGeneration: requiredRowNumber(row, "active_generation"),
    revisionId: requiredRowString(row, "revision_id"),
    revisionNumber: requiredRowNumber(row, "revision_number"),
    status: requiredStatus(row["status"]),
    snapshotJson: requiredRowString(row, "snapshot_json"),
    snapshotHash: requiredRowString(row, "snapshot_hash"),
    assetManifestJson: requiredRowString(row, "asset_manifest_json"),
    revisionCreatedAt: requiredRowNumber(row, "revision_created_at"),
  };
}

/**
 * @param {D1Row} row
 * @returns {RevisionAssetRow}
 */
function mapRevisionAsset(row) {
  return {
    revisionId: requiredRowString(row, "revision_id"),
    assetId: requiredRowString(row, "asset_id"),
    role: requiredRowString(row, "role"),
    ordinal: requiredRowNumber(row, "ordinal"),
    r2Key: requiredRowString(row, "r2_key"),
    sha256: requiredRowString(row, "sha256"),
    byteLength: requiredRowNumber(row, "byte_length"),
    detectedMime: requiredRowString(row, "detected_mime"),
    etag: requiredRowString(row, "etag"),
  };
}

/**
 * @param {D1Row} row
 * @returns {PublicAssetRow}
 */
function mapPublicAsset(row) {
  return {
    assetId: requiredRowString(row, "asset_id"),
    r2Key: requiredRowString(row, "r2_key"),
    sha256: requiredRowString(row, "sha256"),
    byteLength: requiredRowNumber(row, "byte_length"),
    detectedMime: requiredRowString(row, "detected_mime"),
    etag: requiredRowString(row, "etag"),
  };
}

/**
 * @param {D1Row} row
 * @returns {DraftRow}
 */
function mapDraft(row) {
  const activeRevisionId = row["active_revision_id"];
  const companyId = row["company_id"];
  return {
    jobId: requiredRowString(row, "job_id"),
    slug: requiredRowString(row, "slug"),
    activeRevisionId:
      activeRevisionId === null
        ? null
        : requiredRowString(row, "active_revision_id"),
    activeGeneration: requiredRowNumber(row, "active_generation"),
    companyId: companyId === null ? null : requiredRowString(row, "company_id"),
    draftVersion: requiredRowNumber(row, "draft_version"),
    draftJson: requiredRowString(row, "draft_json"),
    companySnapshotJson: requiredRowString(row, "company_snapshot_json"),
    applicationJson: requiredRowString(row, "application_json"),
    draftUpdatedAt: requiredRowNumber(row, "draft_updated_at"),
  };
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 * @param {string} code
 */
function boundedPageValue(value, fallback, code) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 100) {
    throw new DatabaseError(code, "D1 pagination value is invalid.");
  }
  return candidate;
}

/**
 * @param {D1Row} row
 * @param {string} key
 */
function requiredRowString(row, key) {
  const value = row[key];
  if (typeof value !== "string") {
    throw new DatabaseError(
      "D1_ROW_INVALID",
      "D1 row has an invalid string column.",
    );
  }
  return value;
}

/**
 * @param {D1Row} row
 * @param {string} key
 */
function requiredRowNumber(row, key) {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DatabaseError(
      "D1_ROW_INVALID",
      "D1 row has an invalid integer column.",
    );
  }
  return value;
}

/** @param {unknown} value @returns {'open' | 'closed'} */
function requiredStatus(value) {
  if (value !== "open" && value !== "closed") {
    throw new DatabaseError(
      "D1_ROW_INVALID",
      "D1 row has an invalid revision status.",
    );
  }
  return value;
}
