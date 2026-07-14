/** @typedef {{ assetId: string, role: string, ordinal: number, mediaUrl: string, mimeType: string, byteLength: number, sha256: string }} SnapshotAsset */
/** @typedef {{ snapshot: Record<string, unknown>, snapshotJson: string, snapshotHash: string, assetManifestJson: string, assets: SnapshotAsset[] }} RevisionSnapshot */

const applicationKinds = new Set(["email", "url"]);
const assetRoles = new Set(["company-logo", "company-hero", "company-map"]);
const hexPattern = /^[0-9a-f]{64}$/;
const rolePattern = /^[a-z][a-z0-9-]{0,63}$/;

/** A stable, public-safe error for invalid immutable snapshot input. */
export class SnapshotError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

/**
 * Canonicalizes a JSON-compatible value so frozen operation input and revision hashes
 * never depend on object insertion order.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  const serialized = JSON.stringify(canonicalize(value));
  if (typeof serialized !== "string") {
    throw new SnapshotError(
      "SNAPSHOT_JSON_INVALID",
      "Snapshot JSON contains an unsupported value.",
    );
  }
  return serialized;
}

/**
 * Computes the lowercase SHA-256 digest used by immutable snapshots and operation input.
 *
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Builds the complete renderer-visible immutable revision payload. `draftJson` is the
 * mutable content source only; company/application values are copied from their draft
 * snapshots and assets are exposed only through immutable `/media/:id` URLs.
 *
 * @param {{
 *   job: { id: string, slug: string },
 *   draft: { draftJson: string | Record<string, unknown>, companySnapshotJson: string | Record<string, unknown>, applicationJson: string | Record<string, unknown> },
 *   assets: readonly { assetId: string, role: string, ordinal: number, mimeType: string, byteLength: number, sha256: string }[],
 *   closedAt?: string
 * }} input
 * @returns {Promise<RevisionSnapshot>}
 */
export async function buildRevisionSnapshot(input) {
  const job = requireObject(input.job, "SNAPSHOT_JOB_INVALID");
  const jobId = requireString(job["id"], "SNAPSHOT_JOB_ID_INVALID");
  const slug = requireString(job["slug"], "SNAPSHOT_JOB_SLUG_INVALID");
  const draft = requireObject(input.draft, "SNAPSHOT_DRAFT_INVALID");
  const content = cloneObject(
    draft["draftJson"],
    "SNAPSHOT_DRAFT_JSON_INVALID",
  );
  const company = cloneObject(
    draft["companySnapshotJson"],
    "SNAPSHOT_COMPANY_INVALID",
  );
  const application = cloneObject(
    draft["applicationJson"],
    "SNAPSHOT_APPLICATION_INVALID",
  );
  const assets = normalizeAssets(input.assets);

  validateApplication(application);
  validateStatus(content, input.closedAt);

  const companyWithMedia = attachCompanyMedia(company, assets);
  const snapshot = {
    ...content,
    snapshotSchemaVersion: 1,
    id: jobId,
    slug,
    company: companyWithMedia,
    application,
    assets,
  };
  const snapshotJson = canonicalJson(snapshot);
  const assetManifestJson = canonicalJson(
    assets.map(({ assetId, role, ordinal }) => ({ assetId, role, ordinal })),
  );

  return {
    snapshot,
    snapshotJson,
    snapshotHash: await sha256Hex(snapshotJson),
    assetManifestJson,
    assets,
  };
}

/**
 * Returns a closed copy of an active immutable snapshot without reading drafts or
 * mutable company state. The source object is cloned before changes are applied.
 *
 * @param {{ snapshot: string | Record<string, unknown>, closedState: string, closedAt: string }} input
 * @returns {Promise<{ snapshot: Record<string, unknown>, snapshotJson: string, snapshotHash: string }>}
 */
export async function buildClosedSnapshot(input) {
  const source = cloneObject(input.snapshot, "CLOSE_SOURCE_SNAPSHOT_INVALID");
  if (source["status"] !== "open") {
    throw new SnapshotError(
      "ALREADY_CLOSED",
      "Only an open active revision can be closed.",
    );
  }

  const closedState = requireString(input.closedState, "CLOSE_STATE_INVALID");
  const closedAt = requireIsoTimestamp(input.closedAt, "CLOSE_TIME_INVALID");
  const snapshot = {
    ...source,
    status: "closed",
    closedState,
    closedAt,
  };
  const snapshotJson = canonicalJson(snapshot);
  return {
    snapshot,
    snapshotJson,
    snapshotHash: await sha256Hex(snapshotJson),
  };
}

/**
 * Parses a persisted immutable snapshot and rejects malformed database values with a
 * stable error code suitable for a branded 503 response.
 *
 * @param {string} snapshotJson
 * @returns {Record<string, unknown>}
 */
export function parseRevisionSnapshot(snapshotJson) {
  return parseObject(snapshotJson, "SNAPSHOT_PERSISTED_INVALID");
}

/**
 * @param {readonly { assetId: string, role: string, ordinal: number, mimeType: string, byteLength: number, sha256: string }[]} input
 * @returns {SnapshotAsset[]}
 */
function normalizeAssets(input) {
  if (!Array.isArray(input)) {
    throw new SnapshotError(
      "SNAPSHOT_ASSETS_INVALID",
      "Snapshot assets must be an array.",
    );
  }

  /** @type {SnapshotAsset[]} */
  const assets = [];
  const bindings = new Set();
  for (const item of input) {
    const asset = requireObject(item, "SNAPSHOT_ASSET_INVALID");
    const assetId = requireString(
      asset["assetId"],
      "SNAPSHOT_ASSET_ID_INVALID",
    );
    const role = requireString(asset["role"], "SNAPSHOT_ASSET_ROLE_INVALID");
    const ordinal = requireOrdinal(asset["ordinal"]);
    const mimeType = requireString(
      asset["mimeType"],
      "SNAPSHOT_ASSET_MIME_INVALID",
    );
    const byteLength = requirePositiveInteger(
      asset["byteLength"],
      "SNAPSHOT_ASSET_LENGTH_INVALID",
    );
    const sha256 = requireString(
      asset["sha256"],
      "SNAPSHOT_ASSET_HASH_INVALID",
    );
    const binding = `${role}:${ordinal}`;

    if (!rolePattern.test(role) || !hexPattern.test(sha256)) {
      throw new SnapshotError(
        "SNAPSHOT_ASSET_INVALID",
        "Snapshot asset metadata is invalid.",
      );
    }
    if (bindings.has(binding)) {
      throw new SnapshotError(
        "SNAPSHOT_ASSET_DUPLICATE_BINDING",
        "Snapshot asset roles must be unique.",
      );
    }
    bindings.add(binding);
    assets.push({
      assetId,
      role,
      ordinal,
      mediaUrl: `/media/${encodeURIComponent(assetId)}`,
      mimeType,
      byteLength,
      sha256,
    });
  }

  return assets.sort(
    (left, right) =>
      left.role.localeCompare(right.role) || left.ordinal - right.ordinal,
  );
}

/**
 * @param {Record<string, unknown>} company
 * @param {SnapshotAsset[]} assets
 * @returns {Record<string, unknown>}
 */
function attachCompanyMedia(company, assets) {
  /** @type {Record<string, unknown>} */
  const media = {};
  for (const asset of assets) {
    if (!assetRoles.has(asset.role)) {
      continue;
    }
    const key =
      asset.role === "company-logo"
        ? "logo"
        : asset.role === "company-hero"
          ? "hero"
          : "map";
    media[key] = {
      assetId: asset.assetId,
      mediaUrl: asset.mediaUrl,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
    };
  }
  return { ...company, media };
}

/** @param {Record<string, unknown>} application */
function validateApplication(application) {
  const kind = requireString(application["kind"], "APPLICATION_KIND_INVALID");
  const value = requireString(
    application["value"],
    "APPLICATION_VALUE_INVALID",
  );
  requireString(application["provenance"], "APPLICATION_PROVENANCE_INVALID");

  if (!applicationKinds.has(kind)) {
    throw new SnapshotError(
      "APPLICATION_KIND_INVALID",
      "Application kind must be email or url.",
    );
  }
  if (kind === "url" && !/^https:\/\/[^\s<>]+$/u.test(value)) {
    throw new SnapshotError(
      "APPLICATION_URL_INVALID",
      "Application URL must use HTTPS.",
    );
  }
  if (kind === "email" && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value)) {
    throw new SnapshotError(
      "APPLICATION_EMAIL_INVALID",
      "Application email is invalid.",
    );
  }
}

/**
 * @param {Record<string, unknown>} content
 * @param {string | undefined} closedAt
 */
function validateStatus(content, closedAt) {
  const status = requireString(content["status"], "SNAPSHOT_STATUS_INVALID");
  if (status !== "open" && status !== "closed") {
    throw new SnapshotError(
      "SNAPSHOT_STATUS_INVALID",
      "Snapshot status must be open or closed.",
    );
  }
  if (status === "closed") {
    requireString(content["closedState"], "CLOSE_STATE_INVALID");
    if (closedAt !== undefined) {
      content["closedAt"] = requireIsoTimestamp(closedAt, "CLOSE_TIME_INVALID");
    } else {
      requireIsoTimestamp(content["closedAt"], "CLOSE_TIME_INVALID");
    }
  } else if (closedAt !== undefined) {
    throw new SnapshotError(
      "CLOSE_TIME_INVALID",
      "Open snapshots cannot have a closed timestamp.",
    );
  }
}

/** @param {unknown} value @returns {unknown} */
function canonicalize(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SnapshotError(
        "SNAPSHOT_JSON_INVALID",
        "Snapshot JSON contains a non-finite number.",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const object = {};
    for (const key of Object.keys(value).sort()) {
      object[key] = canonicalize(
        /** @type {Record<string, unknown>} */ (value)[key],
      );
    }
    return object;
  }
  throw new SnapshotError(
    "SNAPSHOT_JSON_INVALID",
    "Snapshot JSON contains an unsupported value.",
  );
}

/**
 * @param {unknown} value
 * @param {string} code
 * @returns {Record<string, unknown>}
 */
function parseObject(value, code) {
  if (typeof value === "string") {
    try {
      return requireObject(JSON.parse(value), code);
    } catch (error) {
      if (error instanceof SnapshotError) {
        throw error;
      }
      throw new SnapshotError(code, "Snapshot JSON must contain an object.");
    }
  }
  return requireObject(value, code);
}
/**
 * Returns an independent, canonical JSON object so later caller mutation cannot
 * change a constructed revision snapshot.
 *
 * @param {unknown} value
 * @param {string} code
 * @returns {Record<string, unknown>}
 */
function cloneObject(value, code) {
  return parseObject(canonicalJson(parseObject(value, code)), code);
}

/**
 * @param {unknown} value
 * @param {string} code
 * @returns {Record<string, unknown>}
 */
function requireObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SnapshotError(code, "A JSON object is required.");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} code
 * @returns {string}
 */
function requireString(value, code) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SnapshotError(code, "A non-empty string is required.");
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function requireOrdinal(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SnapshotError(
      "SNAPSHOT_ASSET_ORDINAL_INVALID",
      "Asset ordinal must be a non-negative integer.",
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @returns {number}
 */
function requirePositiveInteger(value, code) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new SnapshotError(code, "A positive integer is required.");
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @returns {string}
 */
function requireIsoTimestamp(value, code) {
  const timestamp = requireString(value, code);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(timestamp)) {
    throw new SnapshotError(code, "Timestamp must be an ISO-8601 UTC string.");
  }
  return timestamp;
}
