import { d1Statement } from "./db.js";

export const MAXIMUM_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAXIMUM_PDF_BYTES = 20 * 1024 * 1024;
export const MAXIMUM_MEDIA_BYTES = MAXIMUM_PDF_BYTES;

const supportedMediaTypes = Object.freeze({
  "image/png": { extension: "png", maximumBytes: MAXIMUM_IMAGE_BYTES },
  "image/jpeg": { extension: "jpg", maximumBytes: MAXIMUM_IMAGE_BYTES },
  "image/webp": { extension: "webp", maximumBytes: MAXIMUM_IMAGE_BYTES },
  "application/pdf": { extension: "pdf", maximumBytes: MAXIMUM_PDF_BYTES },
});

const opaqueNotFoundHeaders = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
});

/** Stable, non-sensitive validation or R2 reconciliation failure. */
export class MediaError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   */
  constructor(code, status) {
    super(code);
    this.name = "MediaError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Fully verifies upload bytes before they are eligible for an R2 write.
 * Client MIME, length, and digest are declarations only; returned metadata is
 * always derived from the bytes.
 *
 * @param {Uint8Array} bytes
 * @param {{ mimeType: string, byteLength: number, sha256: string }} declared
 * @returns {Promise<VerifiedMedia>}
 */
export async function verifyMediaBytes(bytes, declared) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new MediaError("MEDIA_BYTES_INVALID", 422);
  }
  if (bytes.byteLength > MAXIMUM_MEDIA_BYTES) {
    throw new MediaError("BODY_TOO_LARGE", 413);
  }
  if (!isDeclaredMediaMetadata(declared)) {
    throw new MediaError("MEDIA_DECLARATION_INVALID", 422);
  }

  const detectedMime = detectMediaMime(bytes);
  if (!detectedMime) throw new MediaError("UNSUPPORTED_MEDIA_TYPE", 415);
  const mediaType = supportedMediaTypes[detectedMime];
  if (!mediaType || bytes.byteLength > mediaType.maximumBytes) {
    throw new MediaError("BODY_TOO_LARGE", 413);
  }
  if (declared.mimeType !== detectedMime) {
    throw new MediaError("MEDIA_MIME_MISMATCH", 415);
  }
  if (declared.byteLength !== bytes.byteLength) {
    throw new MediaError("MEDIA_LENGTH_MISMATCH", 422);
  }

  const sha256 = await sha256Hex(bytes);
  if (declared.sha256 !== sha256) {
    throw new MediaError("MEDIA_SHA256_MISMATCH", 422);
  }

  return Object.freeze({
    bytes,
    sha256,
    byteLength: bytes.byteLength,
    mimeType: detectedMime,
    extension: mediaType.extension,
  });
}

/**
 * Produces an operation-derived, immutable R2 final key. This must never be
 * used with an unconditional PUT or as a mutable logical asset path.
 *
 * @param {string} operationId
 * @param {VerifiedMedia} media
 * @returns {string}
 */
export function createImmutableMediaKey(operationId, media) {
  if (!isUuid(operationId) || !/^[0-9a-f]{64}$/u.test(media.sha256)) {
    throw new TypeError("Invalid immutable media identity");
  }
  return `uploads/${operationId}/${media.sha256}.${media.extension}`;
}

/**
 * Writes verified bytes with R2's create-only primitive, then HEAD-verifies
 * every immutable identity field. A conditional conflict is reconciled only
 * when the existing bytes have the exact expected metadata.
 *
 * @param {R2Bucket} bucket
 * @param {string} key
 * @param {VerifiedMedia} media
 * @returns {Promise<VerifiedR2Object>}
 */
export async function putImmutableMedia(bucket, key, media) {
  const created = await bucket.put(key, media.bytes, {
    httpMetadata: {
      contentType: media.mimeType,
    },
    customMetadata: {
      sha256: media.sha256,
      byteLength: String(media.byteLength),
      detectedMime: media.mimeType,
    },
    onlyIf: new Headers({ "If-None-Match": "*" }),
  });

  const headed = await bucket.head(key);
  if (!headed || !matchesR2MediaObject(headed, key, media)) {
    throw new MediaError("R2_KEY_INTEGRITY_CONFLICT", 409);
  }
  if (created !== null && created.etag !== headed.etag) {
    throw new MediaError("R2_KEY_INTEGRITY_CONFLICT", 409);
  }

  return {
    etag: headed.etag,
    key,
  };
}

/**
 * HEAD-reconciles a pre-existing immutable object. It deliberately has no
 * write fallback: a missing or mismatched object is a terminal integrity
 * conflict, never an opportunity to overwrite it.
 *
 * @param {R2Bucket} bucket
 * @param {string} key
 * @param {VerifiedMedia} media
 * @returns {Promise<VerifiedR2Object>}
 */
export async function reconcileImmutableMedia(bucket, key, media) {
  const headed = await bucket.head(key);
  if (!headed || !matchesR2MediaObject(headed, key, media)) {
    throw new MediaError("R2_KEY_INTEGRITY_CONFLICT", 409);
  }
  return { etag: headed.etag, key };
}

/**
 * Reads an asset eligible only through a live, non-detached draft reference.
 * This is intentionally separate from public retained-revision eligibility.
 *
 * @param {D1Database} database
 * @param {string} assetId
 * @returns {Promise<StoredMediaAsset | null>}
 */
export async function readDraftMediaAsset(database, assetId) {
  const row = await d1Statement(
    database,
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
         FROM draft_asset_refs
         JOIN job_drafts ON job_drafts.job_id = draft_asset_refs.job_id
         WHERE draft_asset_refs.asset_id = assets.id
           AND draft_asset_refs.detached_at IS NULL
       )`,
    [assetId],
  ).first();
  return row === null ? null : mapStoredMediaAsset(row);
}

/**
 * Serves an already-authorized immutable R2 object. It rechecks exact R2
 * metadata before GET so a binding/configuration mistake cannot turn R2 into
 * a public bucket fallback.
 *
 * @param {{ request: Request, bucket: R2Bucket, asset: StoredMediaAsset, cacheControl: string }} input
 * @returns {Promise<Response>}
 */
export async function serveStoredMedia(input) {
  const { request, bucket, asset, cacheControl } = input;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: {
        allow: "GET, HEAD",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const head = await bucket.head(asset.r2Key);
  if (!head || !matchesStoredAsset(head, asset)) {
    throw new MediaError("R2_OBJECT_UNAVAILABLE", 404);
  }

  const etag = formatEtag(asset.etag);
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: mediaHeaders(asset, cacheControl, 0, etag),
    });
  }

  let range;
  try {
    range = parseSingleByteRange(
      request.headers.get("range"),
      asset.byteLength,
    );
  } catch (error) {
    if (!(error instanceof RangeRequestError)) throw error;
    const headers = mediaHeaders(asset, "no-store", 0, etag);
    headers.set("content-range", `bytes */${asset.byteLength}`);
    return new Response(null, { status: 416, headers });
  }

  const responseLength = range ? range.length : asset.byteLength;
  const headers = mediaHeaders(asset, cacheControl, responseLength, etag);
  if (range) {
    headers.set(
      "content-range",
      `bytes ${range.start}-${range.end}/${asset.byteLength}`,
    );
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const object = range
    ? await bucket.get(asset.r2Key, {
        range: { offset: range.start, length: range.length },
      })
    : await bucket.get(asset.r2Key);
  if (!object || !matchesStoredAsset(object, asset)) {
    throw new MediaError("R2_OBJECT_UNAVAILABLE", 404);
  }

  return new Response(object.body, {
    status: range ? 206 : 200,
    headers,
  });
}

/** @returns {Response} */
export function opaqueMediaNotFound() {
  return new Response(null, { status: 404, headers: opaqueNotFoundHeaders });
}

/** @returns {Response} */
export function mediaUnavailable() {
  return new Response(null, { status: 503, headers: opaqueNotFoundHeaders });
}

/**
 * @param {string | null} header
 * @param {number} totalLength
 * @returns {{ start: number, end: number, length: number } | null}
 */
export function parseSingleByteRange(header, totalLength) {
  if (header === null) return null;
  if (!Number.isSafeInteger(totalLength) || totalLength <= 0) {
    throw new RangeRequestError();
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) throw new RangeRequestError();

  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) throw new RangeRequestError();

  if (!startText) {
    const suffixLength = parseBytePosition(endText);
    if (suffixLength === null || suffixLength === 0)
      throw new RangeRequestError();
    const length = Math.min(suffixLength, totalLength);
    return { start: totalLength - length, end: totalLength - 1, length };
  }

  const start = parseBytePosition(startText);
  if (start === null || start >= totalLength) throw new RangeRequestError();
  const requestedEnd = endText ? parseBytePosition(endText) : totalLength - 1;
  if (requestedEnd === null || requestedEnd < start)
    throw new RangeRequestError();
  const end = Math.min(requestedEnd, totalLength - 1);
  return { start, end, length: end - start + 1 };
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", toBufferSource(bytes));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * @param {Uint8Array} bytes
 * @returns {keyof typeof supportedMediaTypes | null}
 */
function detectMediaMime(bytes) {
  if (isPng(bytes)) return "image/png";
  if (isJpeg(bytes)) return "image/jpeg";
  if (isWebp(bytes)) return "image/webp";
  if (isPdf(bytes)) return "application/pdf";
  return null;
}

/** @param {Uint8Array} bytes */
function isPng(bytes) {
  if (
    bytes.byteLength < 45 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return false;
  }

  let offset = 8;
  let firstChunk = true;
  while (offset + 12 <= bytes.byteLength) {
    const dataLength = readUint32BigEndian(bytes, offset);
    const dataStart = offset + 8;
    const nextOffset = dataStart + dataLength + 4;
    if (nextOffset > bytes.byteLength) return false;
    const chunkIsIhdr =
      bytes[offset + 4] === 0x49 &&
      bytes[offset + 5] === 0x48 &&
      bytes[offset + 6] === 0x44 &&
      bytes[offset + 7] === 0x52;
    if (firstChunk && (!chunkIsIhdr || dataLength !== 13)) return false;
    const chunkIsIend =
      bytes[offset + 4] === 0x49 &&
      bytes[offset + 5] === 0x45 &&
      bytes[offset + 6] === 0x4e &&
      bytes[offset + 7] === 0x44;
    if (chunkIsIend) return dataLength === 0 && nextOffset === bytes.byteLength;
    firstChunk = false;
    offset = nextOffset;
  }
  return false;
}

/** @param {Uint8Array} bytes */
function isJpeg(bytes) {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.byteLength - 2] === 0xff &&
    bytes[bytes.byteLength - 1] === 0xd9
  );
}

/** @param {Uint8Array} bytes */
function isWebp(bytes) {
  return (
    bytes.byteLength >= 12 &&
    asciiAt(bytes, 0, "RIFF") &&
    readUint32LittleEndian(bytes, 4) === bytes.byteLength - 8 &&
    asciiAt(bytes, 8, "WEBP")
  );
}

/** @param {Uint8Array} bytes */
function isPdf(bytes) {
  if (bytes.byteLength < 10 || !asciiAt(bytes, 0, "%PDF-")) return false;
  const start = Math.max(0, bytes.byteLength - 1024);
  let eofStart = -1;
  for (let index = start; index + 5 <= bytes.byteLength; index += 1) {
    if (asciiAt(bytes, index, "%%EOF")) eofStart = index;
  }
  if (eofStart < 0) return false;
  for (let index = eofStart + 5; index < bytes.byteLength; index += 1) {
    if (!isPdfWhitespace(bytes[index])) return false;
  }
  return true;
}

/** @param {Uint8Array} bytes @param {number} offset @param {string} text */
function asciiAt(bytes, offset, text) {
  if (offset + text.length > bytes.byteLength) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** @param {number | undefined} value */
function isPdfWhitespace(value) {
  return (
    value === 0 ||
    value === 9 ||
    value === 10 ||
    value === 12 ||
    value === 13 ||
    value === 32
  );
}

/** @param {Uint8Array} bytes @param {number} offset */
function readUint32BigEndian(bytes, offset) {
  return (
    (bytes[offset] ?? 0) * 2 ** 24 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

/** @param {Uint8Array} bytes @param {number} offset */
function readUint32LittleEndian(bytes, offset) {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    (bytes[offset + 3] ?? 0) * 2 ** 24
  );
}

/**
 * @param {R2Object} object
 * @param {string} key
 * @param {VerifiedMedia} media
 */
function matchesR2MediaObject(object, key, media) {
  const customMetadata = object.customMetadata;
  return (
    object.key === key &&
    object.size === media.byteLength &&
    object.httpMetadata?.contentType === media.mimeType &&
    customMetadata?.["sha256"] === media.sha256 &&
    customMetadata?.["byteLength"] === String(media.byteLength) &&
    customMetadata?.["detectedMime"] === media.mimeType &&
    typeof object.etag === "string" &&
    object.etag.length > 0
  );
}

/**
 * @param {R2Object | R2ObjectBody} object
 * @param {StoredMediaAsset} asset
 */
function matchesStoredAsset(object, asset) {
  const customMetadata = object.customMetadata;
  return (
    object.key === asset.r2Key &&
    object.size === asset.byteLength &&
    object.etag === asset.etag &&
    object.httpMetadata?.contentType === asset.detectedMime &&
    customMetadata?.["sha256"] === asset.sha256 &&
    customMetadata?.["byteLength"] === String(asset.byteLength) &&
    customMetadata?.["detectedMime"] === asset.detectedMime
  );
}

/**
 * @param {StoredMediaAsset} asset
 * @param {string} cacheControl
 * @param {number} contentLength
 * @param {string} etag
 */
function mediaHeaders(asset, cacheControl, contentLength, etag) {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": cacheControl,
    "content-length": String(contentLength),
    "content-security-policy":
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    "content-type": asset.detectedMime,
    etag,
    "x-content-type-options": "nosniff",
  });
  if (asset.detectedMime === "application/pdf") {
    headers.set(
      "content-disposition",
      `attachment; filename="${safeFilename(asset.assetId)}.pdf"`,
    );
  }
  return headers;
}

/** @param {string} value */
function safeFilename(value) {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128) || "download";
}

/** @param {string} etag */
function formatEtag(etag) {
  if (!/^[\x21\x23-\x7e]+$/u.test(etag)) {
    throw new MediaError("R2_OBJECT_UNAVAILABLE", 404);
  }
  return `"${etag.replaceAll('"', "")}"`;
}

/** @param {string | null} header @param {string} etag */
function ifNoneMatchMatches(header, etag) {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//u, "") === etag;
  });
}

/** @param {string | undefined} value */
function parseBytePosition(value) {
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

class RangeRequestError extends Error {}

/** @param {unknown} value @returns {value is { mimeType: keyof typeof supportedMediaTypes, byteLength: number, sha256: string }} */
function isDeclaredMediaMetadata(value) {
  if (value === null || typeof value !== "object") return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof record["mimeType"] === "string" &&
    Object.hasOwn(supportedMediaTypes, record["mimeType"]) &&
    typeof record["byteLength"] === "number" &&
    Number.isSafeInteger(record["byteLength"]) &&
    record["byteLength"] > 0 &&
    typeof record["sha256"] === "string" &&
    /^[0-9a-f]{64}$/u.test(record["sha256"])
  );
}

/** @param {string} value */
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
}

/** @param {Record<string, unknown>} row @returns {StoredMediaAsset} */
function mapStoredMediaAsset(row) {
  const assetId = requiredString(row, "asset_id");
  const r2Key = requiredString(row, "r2_key");
  const sha256 = requiredString(row, "sha256");
  const byteLength = requiredPositiveInteger(row, "byte_length");
  const detectedMime = requiredMime(row["detected_mime"]);
  const etag = requiredString(row, "etag");
  return { assetId, r2Key, sha256, byteLength, detectedMime, etag };
}

/** @param {Record<string, unknown>} row @param {string} key */
function requiredString(row, key) {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MediaError("MEDIA_ROW_INVALID", 503);
  }
  return value;
}

/** @param {Record<string, unknown>} row @param {string} key */
function requiredPositiveInteger(row, key) {
  const value = row[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAXIMUM_MEDIA_BYTES
  ) {
    throw new MediaError("MEDIA_ROW_INVALID", 503);
  }
  return value;
}

/** @param {unknown} value @returns {keyof typeof supportedMediaTypes} */
function requiredMime(value) {
  if (typeof value !== "string" || !Object.hasOwn(supportedMediaTypes, value)) {
    throw new MediaError("MEDIA_ROW_INVALID", 503);
  }
  return /** @type {keyof typeof supportedMediaTypes} */ (value);
}

/** @param {Uint8Array} bytes */
function toBufferSource(bytes) {
  return /** @type {BufferSource} */ (bytes);
}

/**
 * @typedef {{ bytes: Uint8Array, sha256: string, byteLength: number, mimeType: keyof typeof supportedMediaTypes, extension: string }} VerifiedMedia
 * @typedef {{ etag: string, key: string }} VerifiedR2Object
 * @typedef {{ assetId: string, r2Key: string, sha256: string, byteLength: number, detectedMime: string, etag: string }} StoredMediaAsset
 */
