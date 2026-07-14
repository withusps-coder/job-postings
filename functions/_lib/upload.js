import { d1Statement } from "./db.js";
import {
  MAXIMUM_MEDIA_BYTES,
  MediaError,
  reconcileImmutableMedia,
  verifyMediaBytes,
} from "./media.js";

const rolePattern = /^[a-z][a-z0-9-]{0,63}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Stable parse or immutable-reference error for asset mutations. */
export class AssetMutationError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   */
  constructor(code, status) {
    super(code);
    this.name = "AssetMutationError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Parses the bounded multipart upload body. Callers must pass the exact bytes
 * returned by readBoundedBody; this function does not consume the original
 * request stream and therefore cannot bypass its size fence.
 *
 * @param {Request} request
 * @param {Uint8Array} body
 * @returns {Promise<ParsedAssetUpload>}
 */
export async function parseAssetUpload(request, body) {
  if (body.byteLength > MAXIMUM_MEDIA_BYTES) {
    throw new AssetMutationError("BODY_TOO_LARGE", 413);
  }
  const contentType = request.headers.get("content-type");
  if (!contentType || !isMultipartContentType(contentType)) {
    throw new AssetMutationError("UNSUPPORTED_MEDIA_TYPE", 415);
  }

  let form;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: /** @type {BodyInit} */ (body),
    }).formData();
  } catch {
    throw new AssetMutationError("MULTIPART_INVALID", 400);
  }

  const permittedFields = new Set([
    "file",
    "role",
    "expectedDraftVersion",
    "sha256",
    "mimeType",
    "byteLength",
    "idempotencyKey",
    "retryOf",
  ]);
  for (const [name] of form.entries()) {
    if (!permittedFields.has(name)) {
      throw new AssetMutationError("MULTIPART_FIELD_INVALID", 422);
    }
  }

  const file = requiredSingleFile(form, "file");
  if (file.size === 0 || file.size > MAXIMUM_MEDIA_BYTES) {
    throw new AssetMutationError("BODY_TOO_LARGE", 413);
  }
  const role = requiredRole(requiredSingleText(form, "role"));
  const expectedDraftVersion = requiredPositiveInteger(
    requiredSingleText(form, "expectedDraftVersion"),
    "expectedDraftVersion",
  );
  const declared = {
    sha256: requiredSha256(requiredSingleText(form, "sha256")),
    mimeType: requiredSingleText(form, "mimeType"),
    byteLength: requiredPositiveInteger(
      requiredSingleText(form, "byteLength"),
      "byteLength",
    ),
  };
  const idempotencyKey = requiredUuid(
    requiredSingleText(form, "idempotencyKey"),
    "idempotencyKey",
  );
  const retryOf = optionalUuid(optionalSingleText(form, "retryOf"), "retryOf");

  const bytes = new Uint8Array(await file.arrayBuffer());
  let media;
  try {
    media = await verifyMediaBytes(bytes, declared);
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new AssetMutationError("MEDIA_VERIFICATION_UNAVAILABLE", 503);
  }

  return {
    role,
    expectedDraftVersion,
    idempotencyKey,
    ...(retryOf ? { retryOf } : {}),
    media,
  };
}

/**
 * Parses the bounded JSON body accepted by the detach endpoint. Detach is a
 * reference-state transition only: it never deletes R2 bytes or an asset row.
 *
 * @param {Uint8Array} bytes
 * @returns {ParsedAssetDetach}
 */
export function parseAssetDetach(bytes) {
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AssetMutationError("INVALID_REQUEST", 400);
  }
  if (
    !isPlainObject(body) ||
    !hasOnlyKeys(body, [
      "assetId",
      "role",
      "expectedDraftVersion",
      "idempotencyKey",
      "retryOf",
    ])
  ) {
    throw new AssetMutationError("INVALID_REQUEST", 400);
  }

  const retryOf = optionalUuidValue(body["retryOf"], "retryOf");
  return {
    assetId: requiredUuidValue(body["assetId"], "assetId"),
    role: requiredRole(body["role"]),
    expectedDraftVersion: requiredPositiveInteger(
      body["expectedDraftVersion"],
      "expectedDraftVersion",
    ),
    idempotencyKey: requiredUuidValue(body["idempotencyKey"], "idempotencyKey"),
    ...(retryOf ? { retryOf } : {}),
  };
}

/**
 * Loads a verified, immutable asset by its digest so identical bytes may reuse
 * their existing immutable R2 key rather than mutate or replace an object.
 *
 * @param {D1Database} database
 * @param {string} sha256
 * @returns {Promise<ExistingMediaAsset | null>}
 */
export async function readVerifiedAssetBySha256(database, sha256) {
  const row = await d1Statement(
    database,
    `SELECT id, r2_key, sha256, byte_length, detected_mime, etag
     FROM assets
     WHERE sha256 = ? AND verification_state = 'verified'`,
    [sha256],
  ).first();
  return row === null ? null : mapExistingMediaAsset(row);
}

/**
 * Finds the next immutable ordinal for a role. Historical detached references
 * are retained, so a replacement always receives a fresh ordinal.
 *
 * @param {D1Database} database
 * @param {string} jobId
 * @param {string} role
 * @returns {Promise<number>}
 */
export async function readNextDraftAssetOrdinal(database, jobId, role) {
  const row = await d1Statement(
    database,
    `SELECT COALESCE(MAX(ordinal) + 1, 0) AS next_ordinal
     FROM draft_asset_refs
     WHERE job_id = ? AND role = ?`,
    [jobId, role],
  ).first();
  const nextOrdinal = row?.["next_ordinal"];
  if (
    typeof nextOrdinal !== "number" ||
    !Number.isSafeInteger(nextOrdinal) ||
    nextOrdinal < 0
  ) {
    throw new AssetMutationError("DRAFT_ASSET_ORDINAL_UNAVAILABLE", 503);
  }
  return nextOrdinal;
}

/**
 * Checks an active reference before the detach batch. The batch still has the
 * draft-version fence, so this read cannot authorize a stale mutation.
 *
 * @param {D1Database} database
 * @param {{ jobId: string, assetId: string, role: string }} input
 * @returns {Promise<boolean>}
 */
export async function hasActiveDraftAssetRef(database, input) {
  const row = await d1Statement(
    database,
    `SELECT 1 AS present
     FROM draft_asset_refs
     WHERE job_id = ? AND asset_id = ? AND role = ? AND detached_at IS NULL`,
    [input.jobId, input.assetId, input.role],
  ).first();
  return row !== null;
}

/**
 * Reconciles the stored existing asset with private R2 before it is reused.
 * No upload path is permitted to use an existing R2 key without this exact
 * metadata check.
 *
 * @param {R2Bucket} bucket
 * @param {ExistingMediaAsset} asset
 * @param {import("./media.js").VerifiedMedia} media
 * @returns {Promise<void>}
 */
export async function verifyExistingAssetInR2(bucket, asset, media) {
  if (
    asset.sha256 !== media.sha256 ||
    asset.byteLength !== media.byteLength ||
    asset.detectedMime !== media.mimeType
  ) {
    throw new AssetMutationError("ASSET_INTEGRITY_CONFLICT", 409);
  }
  const reconciled = await reconcileImmutableMedia(bucket, asset.r2Key, media);
  if (reconciled.etag !== asset.etag) {
    throw new AssetMutationError("ASSET_INTEGRITY_CONFLICT", 409);
  }
}

/**
 * Creates the guarded, immutable D1 writes for attaching an asset. The caller
 * must put these after finalizeOperation's lease guard by passing them as
 * resourceStatements. The version update deliberately triggers the D1
 * DRAFT_VERSION_INVALID guard on a stale expected version.
 *
 * @param {D1Database} database
 * @param {{ jobId: string, expectedDraftVersion: number, asset: ExistingMediaAsset, role: string, ordinal: number, now: number, createAsset: boolean, operationId: string }} input
 * @returns {D1PreparedStatement[]}
 */
export function createAttachAssetStatements(database, input) {
  const statements = [];
  if (input.createAsset) {
    statements.push(
      d1Statement(
        database,
        `INSERT INTO assets (
           id, r2_key, sha256, byte_length, detected_mime, verification_state,
           verified_at, etag, created_by_operation_id, created_at
         ) VALUES (?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?)`,
        [
          input.asset.id,
          input.asset.r2Key,
          input.asset.sha256,
          input.asset.byteLength,
          input.asset.detectedMime,
          input.now,
          input.asset.etag,
          input.operationId,
          input.now,
        ],
      ),
    );
  }

  statements.push(
    d1Statement(
      database,
      `UPDATE job_drafts
       SET version = version + CASE WHEN version = ? THEN 1 ELSE 0 END,
           updated_at = ?
       WHERE job_id = ?`,
      [input.expectedDraftVersion, input.now, input.jobId],
    ),
    d1Statement(
      database,
      `INSERT INTO draft_asset_refs (
         job_id, asset_id, role, ordinal, attached_at, detached_at
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
      [input.jobId, input.asset.id, input.role, input.ordinal, input.now],
    ),
  );
  return statements;
}

/**
 * Creates the guarded D1 transition for a detach. It changes only
 * draft_asset_refs.detached_at and never invokes an R2 deletion API.
 *
 * @param {D1Database} database
 * @param {{ jobId: string, assetId: string, role: string, expectedDraftVersion: number, now: number }} input
 * @returns {D1PreparedStatement[]}
 */
export function createDetachAssetStatements(database, input) {
  return [
    d1Statement(
      database,
      `UPDATE job_drafts
       SET version = version + CASE
         WHEN version = ? AND EXISTS (
           SELECT 1
           FROM draft_asset_refs
           WHERE job_id = ? AND asset_id = ? AND role = ? AND detached_at IS NULL
         ) THEN 1
         ELSE 0
       END,
       updated_at = ?
       WHERE job_id = ?`,
      [
        input.expectedDraftVersion,
        input.jobId,
        input.assetId,
        input.role,
        input.now,
        input.jobId,
      ],
    ),
    d1Statement(
      database,
      `UPDATE draft_asset_refs
       SET detached_at = ?
       WHERE job_id = ? AND asset_id = ? AND role = ? AND detached_at IS NULL`,
      [input.now, input.jobId, input.assetId, input.role],
    ),
  ];
}

/** @param {FormData} form @param {string} name */
function requiredSingleFile(form, name) {
  const values = form.getAll(name);
  if (values.length !== 1 || !(values[0] instanceof Blob)) {
    throw new AssetMutationError("MULTIPART_FIELD_INVALID", 422);
  }
  return values[0];
}

/** @param {FormData} form @param {string} name */
function requiredSingleText(form, name) {
  const value = optionalSingleText(form, name);
  if (value === undefined || value.length === 0 || value.length > 1024) {
    throw new AssetMutationError("MULTIPART_FIELD_INVALID", 422);
  }
  return value;
}

/** @param {FormData} form @param {string} name */
function optionalSingleText(form, name) {
  const values = form.getAll(name);
  if (values.length === 0) return undefined;
  if (
    values.length !== 1 ||
    typeof values[0] !== "string" ||
    values[0].length > 1024
  ) {
    throw new AssetMutationError("MULTIPART_FIELD_INVALID", 422);
  }
  return values[0];
}

/** @param {unknown} value */
function requiredRole(value) {
  if (typeof value !== "string" || !rolePattern.test(value)) {
    throw new AssetMutationError("ASSET_ROLE_INVALID", 422);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requiredPositiveInteger(value, field) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^[1-9]\d*$/u.test(String(value))
  ) {
    throw new AssetMutationError(`${field.toUpperCase()}_INVALID`, 422);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAXIMUM_MEDIA_BYTES
  ) {
    throw new AssetMutationError(`${field.toUpperCase()}_INVALID`, 422);
  }
  return parsed;
}

/** @param {string} value */
function requiredSha256(value) {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new AssetMutationError("MEDIA_SHA256_INVALID", 422);
  }
  return value;
}

/** @param {string} value @param {string} field */
function requiredUuid(value, field) {
  if (!uuidPattern.test(value))
    throw new AssetMutationError(`${field.toUpperCase()}_INVALID`, 400);
  return value;
}

/** @param {unknown} value @param {string} field */
function requiredUuidValue(value, field) {
  if (typeof value !== "string")
    throw new AssetMutationError(`${field.toUpperCase()}_INVALID`, 400);
  return requiredUuid(value, field);
}

/** @param {string | undefined} value @param {string} field */
function optionalUuid(value, field) {
  if (value === undefined || value === "") return undefined;
  return requiredUuid(value, field);
}

/** @param {unknown} value @param {string} field */
function optionalUuidValue(value, field) {
  if (value === undefined) return undefined;
  return requiredUuidValue(value, field);
}

/** @param {string} contentType */
function isMultipartContentType(contentType) {
  const [mediaType, ...parameters] = contentType.split(";");
  return (
    mediaType?.trim().toLowerCase() === "multipart/form-data" &&
    parameters.some((parameter) =>
      /^\s*boundary=(?:[^\s;]+|"[^"]+")\s*$/u.test(parameter),
    )
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed */
function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** @param {Record<string, unknown>} row @returns {ExistingMediaAsset} */
function mapExistingMediaAsset(row) {
  const id = requiredRowString(row, "id");
  const r2Key = requiredRowString(row, "r2_key");
  const sha256 = requiredSha256(requiredRowString(row, "sha256"));
  const byteLength = requiredRowPositiveInteger(row, "byte_length");
  const detectedMime = requiredRowMime(row["detected_mime"]);
  const etag = requiredRowString(row, "etag");
  return { id, r2Key, sha256, byteLength, detectedMime, etag };
}

/** @param {Record<string, unknown>} row @param {string} key */
function requiredRowString(row, key) {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AssetMutationError("ASSET_ROW_INVALID", 503);
  }
  return value;
}

/** @param {Record<string, unknown>} row @param {string} key */
function requiredRowPositiveInteger(row, key) {
  const value = row[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAXIMUM_MEDIA_BYTES
  ) {
    throw new AssetMutationError("ASSET_ROW_INVALID", 503);
  }
  return value;
}

/** @param {unknown} value @returns {'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf'} */
function requiredRowMime(value) {
  if (
    value !== "image/png" &&
    value !== "image/jpeg" &&
    value !== "image/webp" &&
    value !== "application/pdf"
  ) {
    throw new AssetMutationError("ASSET_ROW_INVALID", 503);
  }
  return value;
}

/**
 * @typedef {{ role: string, expectedDraftVersion: number, idempotencyKey: string, retryOf?: string, media: import("./media.js").VerifiedMedia }} ParsedAssetUpload
 * @typedef {{ assetId: string, role: string, expectedDraftVersion: number, idempotencyKey: string, retryOf?: string }} ParsedAssetDetach
 * @typedef {{ id: string, r2Key: string, sha256: string, byteLength: number, detectedMime: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf', etag: string }} ExistingMediaAsset
 */
