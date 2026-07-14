import { d1Statement, readDraftByJobId } from "../../../../_lib/db.js";
import { readBoundedBody } from "../../../../_lib/csrf.js";
import {
  adminError,
  adminJson,
  createCorrelationId,
} from "../../../../_lib/errors.js";
import {
  buildRevisionSnapshot,
  SnapshotError,
} from "../../../../_lib/snapshot.js";

const maximumBodyBytes = 256 * 1024;
/**
 * @typedef {null | boolean | number | string | unknown[] | Record<string, unknown>} JsonValue
 * @typedef {Record<string, JsonValue>} JsonObject
 * @typedef {JsonObject & { status: "open" | "closed" }} DraftContent
 * @typedef {JsonObject & { name: string, website: string, summary: string }} CompanySnapshot
 * @typedef {JsonObject & { kind: "email" | "url", value: string, provenance: string }} Application
 * @typedef {{ expectedDraftVersion: number, draft?: DraftContent, companySnapshot?: CompanySnapshot, application?: Application }} PreviewRequest
 * @typedef {{ assetId: string, role: string, ordinal: number, mimeType: string, byteLength: number, sha256: string }} PreviewAsset
 */

/**
 * Validates and renders a candidate revision without writing D1, claiming an
 * operation, or exposing a draft asset through the public media route.
 *
 * @param {EventContext<{ DB: D1Database }, string, import("../../_middleware.js").AdminMiddlewareData>} context
 */
export async function onRequestPost(context) {
  const correlationId = createCorrelationId();
  if (!context.data.admin) return adminError("ACCESS_INVALID", correlationId);
  if (!context.env.DB) return adminError("ADMIN_UNAVAILABLE", correlationId);
  if (!isJsonRequest(context.request))
    return previewResponse(415, "UNSUPPORTED_MEDIA_TYPE", correlationId);

  try {
    const jobId = requiredUuid(context.params["id"], "DRAFT_NOT_FOUND", 404);
    const request = parsePreviewRequest(
      await readJson(context.request, maximumBodyBytes),
    );
    const persisted = await readDraftByJobId(context.env.DB, jobId);
    if (!persisted)
      return previewResponse(404, "DRAFT_NOT_FOUND", correlationId);
    if (persisted.draftVersion !== request.expectedDraftVersion) {
      return previewResponse(409, "DRAFT_VERSION_CONFLICT", correlationId);
    }

    const draft = validateRenderableDraft(
      request.draft ?? parseStoredObject(persisted.draftJson),
    );
    const companySnapshot = validatedCompanySnapshot(
      request.companySnapshot ??
        parseStoredObject(persisted.companySnapshotJson),
    );
    const application = validatedApplication(
      request.application ?? parseStoredObject(persisted.applicationJson),
    );
    const assets = await readPreviewAssets(context.env.DB, jobId);
    const revision = await buildRevisionSnapshot({
      job: { id: persisted.jobId, slug: persisted.slug },
      draft: {
        draftJson: draft,
        companySnapshotJson: companySnapshot,
        applicationJson: application,
      },
      assets,
    });
    const snapshot = withProtectedMediaUrls(revision.snapshot);
    const privateAssets = assets.map((asset) => ({
      ...asset,
      contentUrl: `/api/admin/assets/${encodeURIComponent(asset.assetId)}/content`,
    }));
    return adminJson({
      preview: {
        job: {
          id: persisted.jobId,
          slug: persisted.slug,
          draftVersion: persisted.draftVersion,
        },
        snapshot,
        assets: privateAssets,
        html: renderPreviewHtml(snapshot, privateAssets),
      },
    });
  } catch (error) {
    if (error instanceof PreviewApiError)
      return previewResponse(error.status, error.code, correlationId);
    if (error instanceof SnapshotError)
      return previewResponse(422, "PREVIEW_INVALID", correlationId);
    if (error instanceof RangeError)
      return previewResponse(413, "BODY_TOO_LARGE", correlationId);
    return adminError("ADMIN_UNAVAILABLE", correlationId);
  }
}

/** @param {unknown} value @returns {PreviewRequest} */
function parsePreviewRequest(value) {
  const body = requireObject(value);
  assertOnlyKeys(body, [
    "expectedDraftVersion",
    "draft",
    "companySnapshot",
    "application",
  ]);
  const expectedDraftVersion = requiredPositiveInteger(
    body["expectedDraftVersion"],
    "DRAFT_VERSION_INVALID",
  );
  return {
    expectedDraftVersion,
    ...(Object.hasOwn(body, "draft")
      ? { draft: validatedDraft(body["draft"]) }
      : {}),
    ...(Object.hasOwn(body, "companySnapshot")
      ? { companySnapshot: validatedCompanySnapshot(body["companySnapshot"]) }
      : {}),
    ...(Object.hasOwn(body, "application")
      ? { application: validatedApplication(body["application"]) }
      : {}),
  };
}

/** @param {D1Database} database @param {string} jobId @returns {Promise<PreviewAsset[]>} */
async function readPreviewAssets(database, jobId) {
  const result = await d1Statement(
    database,
    `SELECT refs.asset_id, refs.role, refs.ordinal, assets.detected_mime,
            assets.byte_length, assets.sha256
     FROM draft_asset_refs AS refs
     JOIN assets ON assets.id = refs.asset_id
     WHERE refs.job_id = ? AND refs.detached_at IS NULL
     ORDER BY refs.role ASC, refs.ordinal ASC`,
    [jobId],
  ).all();
  return result.results.map(parsePreviewAssetRow);
}

/**
 * @param {Record<string, unknown>} row
 * @returns {PreviewAsset}
 */
function parsePreviewAssetRow(row) {
  const assetId = requiredUuid(row["asset_id"], "DRAFT_ASSET_ROW_INVALID", 503);
  const role = row["role"];
  const ordinal = row["ordinal"];
  const mimeType = row["detected_mime"];
  const byteLength = row["byte_length"];
  const sha256 = row["sha256"];
  if (
    typeof role !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(role) ||
    !isNonNegativeInteger(ordinal) ||
    !isDraftAssetMime(mimeType) ||
    !isPositiveInteger(byteLength) ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(sha256)
  ) {
    throw new PreviewApiError("DRAFT_ASSET_ROW_INVALID", 503);
  }
  return { assetId, role, ordinal, mimeType, byteLength, sha256 };
}

/** @param {Record<string, unknown>} snapshot @returns {Record<string, unknown>} */
function withProtectedMediaUrls(snapshot) {
  const assets = Array.isArray(snapshot["assets"])
    ? snapshot["assets"].map(protectedAsset)
    : [];
  const company = requireObject(snapshot["company"]);
  const companyMedia = company["media"];
  const media =
    companyMedia &&
    typeof companyMedia === "object" &&
    !Array.isArray(companyMedia)
      ? Object.fromEntries(
          Object.entries(
            /** @type {Record<string, unknown>} */ (companyMedia),
          ).map(([role, value]) => [role, protectedMedia(value)]),
        )
      : {};
  return { ...snapshot, assets, company: { ...company, media } };
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function protectedAsset(value) {
  const asset = requireObject(value);
  const assetId = requiredUuid(asset["assetId"], "PREVIEW_INVALID", 422);
  return {
    ...asset,
    mediaUrl: `/api/admin/assets/${encodeURIComponent(assetId)}/content`,
  };
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function protectedMedia(value) {
  const media = requireObject(value);
  const assetId = requiredUuid(media["assetId"], "PREVIEW_INVALID", 422);
  return {
    ...media,
    mediaUrl: `/api/admin/assets/${encodeURIComponent(assetId)}/content`,
  };
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {readonly { assetId: string, role: string, contentUrl: string }[]} assets
 */
function renderPreviewHtml(snapshot, assets) {
  const company = requireObject(snapshot["company"]);
  const title =
    typeof snapshot["title"] === "string"
      ? snapshot["title"]
      : "Untitled draft";
  const summary =
    typeof company["summary"] === "string" ? company["summary"] : "";
  const status =
    typeof snapshot["status"] === "string" ? snapshot["status"] : "";
  const sectionText = renderSections(snapshot["sections"]);
  const assetLinks = assets
    .map(
      (asset) =>
        `<li><a href="${escapeHtml(asset.contentUrl)}">${escapeHtml(asset.role)}</a></li>`,
    )
    .join("");
  return `<article data-admin-preview="true"><p>${escapeHtml(status)}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(summary)}</p>${sectionText}<ul>${assetLinks}</ul></article>`;
}

/** @param {unknown} value */
function renderSections(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "";
  return Object.entries(/** @type {Record<string, unknown>} */ (value))
    .flatMap(([heading, items]) => {
      if (!Array.isArray(items)) return [];
      const list = items
        .filter(isString)
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("");
      return list
        ? [`<section><h2>${escapeHtml(heading)}</h2><ul>${list}</ul></section>`]
        : [];
    })
    .join("");
}

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** @param {unknown} value @returns {DraftContent} */
function validateRenderableDraft(value) {
  const draft = validatedDraft(value);
  const datePosted = requiredText(draft["datePosted"], 10, "PREVIEW_INVALID");
  for (const field of [
    "title",
    "category",
    "employment",
    "location",
    "experience",
  ]) {
    requiredText(draft[field], 2_000, "PREVIEW_INVALID");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(datePosted))
    throw new PreviewApiError("PREVIEW_INVALID", 422);
  const remote = draft["remote"];
  if (remote !== "onsite" && remote !== "hybrid" && remote !== "remote") {
    throw new PreviewApiError("PREVIEW_INVALID", 422);
  }
  const authorization = requireObject(draft["publisherAuthorization"]);
  if (
    authorization["authorized"] !== true ||
    authorization["scope"] !== "published-job" ||
    !isIsoTimestamp(authorization["attestedAt"])
  ) {
    throw new PreviewApiError("PREVIEW_INVALID", 422);
  }
  const tags = draft["tags"];
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > 40)
    throw new PreviewApiError("PREVIEW_INVALID", 422);
  for (const tag of tags) requiredText(tag, 2_000, "PREVIEW_INVALID");
  const sections = requireObject(draft["sections"]);
  for (const requiredSection of ["responsibilities", "qualifications"]) {
    const values = sections[requiredSection];
    if (!Array.isArray(values) || values.length === 0 || values.length > 40)
      throw new PreviewApiError("PREVIEW_INVALID", 422);
    for (const item of values) requiredText(item, 2_000, "PREVIEW_INVALID");
  }
  if (draft["status"] === "closed") {
    requiredText(draft["closedState"], 2_000, "PREVIEW_INVALID");
    if (!isIsoTimestamp(draft["closedAt"]))
      throw new PreviewApiError("PREVIEW_INVALID", 422);
  }
  return draft;
}

/** @param {unknown} value @returns {DraftContent} */
function validatedDraft(value) {
  const draft = requireObject(value);
  validateJsonValue(draft, 0);
  if (draft["status"] !== "open" && draft["status"] !== "closed")
    throw new PreviewApiError("DRAFT_STATUS_INVALID", 422);
  return /** @type {DraftContent} */ (draft);
}

/** @param {unknown} value @returns {CompanySnapshot} */
function validatedCompanySnapshot(value) {
  const company = requireObject(value);
  if (
    Object.keys(company).some(
      (key) => !["name", "website", "summary"].includes(key),
    )
  )
    throw new PreviewApiError("COMPANY_SNAPSHOT_INVALID", 422);
  return {
    name: requiredText(company["name"], 200, "COMPANY_SNAPSHOT_INVALID"),
    website: requiredHttpsUrl(company["website"], "COMPANY_SNAPSHOT_INVALID"),
    summary: requiredText(
      company["summary"],
      2_000,
      "COMPANY_SNAPSHOT_INVALID",
    ),
  };
}

/** @param {unknown} value @returns {Application} */
function validatedApplication(value) {
  const application = requireObject(value);
  if (
    Object.keys(application).some(
      (key) => !["kind", "value", "provenance"].includes(key),
    )
  )
    throw new PreviewApiError("APPLICATION_INVALID", 422);
  const kind = application["kind"];
  const valueText = application["value"];
  const provenance = application["provenance"];
  if (kind !== "email" && kind !== "url")
    throw new PreviewApiError("APPLICATION_KIND_INVALID", 422);
  if (
    typeof provenance !== "string" ||
    provenance.trim().length === 0 ||
    provenance.length > 2_000 ||
    /[<>]/u.test(provenance)
  ) {
    throw new PreviewApiError("APPLICATION_PROVENANCE_INVALID", 422);
  }
  if (kind === "email") {
    if (
      typeof valueText !== "string" ||
      valueText.length > 320 ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(valueText)
    ) {
      throw new PreviewApiError("APPLICATION_EMAIL_INVALID", 422);
    }
    return {
      kind,
      value: valueText,
      provenance: provenance.trim(),
    };
  }
  return {
    kind,
    value: requiredHttpsUrl(valueText, "APPLICATION_URL_INVALID"),
    provenance: provenance.trim(),
  };
}

/** @param {unknown} value @param {number} depth */
function validateJsonValue(value, depth) {
  if (depth > 12) throw new PreviewApiError("DRAFT_TOO_COMPLEX", 422);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 16_000)
      throw new PreviewApiError("DRAFT_TOO_COMPLEX", 422);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new PreviewApiError("DRAFT_INVALID", 422);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) throw new PreviewApiError("DRAFT_TOO_COMPLEX", 422);
    for (const item of value) validateJsonValue(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const object = /** @type {Record<string, unknown>} */ (value);
    const entries = Object.entries(object);
    if (entries.length > 100)
      throw new PreviewApiError("DRAFT_TOO_COMPLEX", 422);
    for (const [key, nested] of entries) {
      if (key.length === 0 || key.length > 100)
        throw new PreviewApiError("DRAFT_INVALID", 422);
      if (
        ["url", "website", "officialStartingApplicationUrl"].includes(key) &&
        typeof nested === "string"
      ) {
        requiredHttpsUrl(nested, "DRAFT_URL_INVALID");
      }
      validateJsonValue(nested, depth + 1);
    }
    return;
  }
  throw new PreviewApiError("DRAFT_INVALID", 422);
}

/** @param {Request} request @param {number} maximumBytes */
async function readJson(request, maximumBytes) {
  const bytes = await readBoundedBody(request, maximumBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PreviewApiError("INVALID_REQUEST", 400);
  }
}

/** @param {string} value @returns {JsonObject} */
function parseStoredObject(value) {
  try {
    return /** @type {JsonObject} */ (requireObject(JSON.parse(value)));
  } catch {
    throw new PreviewApiError("DRAFT_ROW_INVALID", 503);
  }
}

/** @param {number} status @param {string} code @param {string} correlationId */
function previewResponse(status, code, correlationId) {
  return adminJson(
    { code, message: previewMessage(code), correlationId },
    status,
  );
}

/** @param {string} code */
function previewMessage(code) {
  if (code === "DRAFT_NOT_FOUND") return "The requested draft was not found.";
  if (code === "DRAFT_VERSION_CONFLICT")
    return "The draft changed before this preview was rendered.";
  if (
    code === "PREVIEW_INVALID" ||
    code.startsWith("DRAFT_") ||
    code.startsWith("APPLICATION_") ||
    code.startsWith("COMPANY_")
  ) {
    return "The preview candidate is not valid for publication.";
  }
  return "The preview could not be rendered.";
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function requireObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new PreviewApiError("INVALID_REQUEST", 400);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} object @param {readonly string[]} allowed */
function assertOnlyKeys(object, allowed) {
  if (Object.keys(object).some((key) => !allowed.includes(key)))
    throw new PreviewApiError("INVALID_REQUEST", 400);
}

/** @param {unknown} value @param {number} maximumLength @param {string} code */
function requiredText(value, maximumLength, code) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[<>]/u.test(value)
  )
    throw new PreviewApiError(code, 422);
  return value.trim();
}

/** @param {unknown} value @param {string} code */
function requiredHttpsUrl(value, code) {
  if (
    typeof value !== "string" ||
    value.length > 2_048 ||
    /[<>\s]/u.test(value) ||
    !URL.canParse(value)
  )
    throw new PreviewApiError(code, 422);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username ||
    url.password
  )
    throw new PreviewApiError(code, 422);
  return url.toString();
}

/** @param {unknown} value @param {string} code @returns {number} */
function requiredPositiveInteger(value, code) {
  if (!isPositiveInteger(value)) throw new PreviewApiError(code, 422);
  return value;
}

/** @param {unknown} value @returns {value is number} */
function isPositiveInteger(value) {
  return isSafeInteger(value) && value > 0;
}

/** @param {unknown} value @returns {value is number} */
function isNonNegativeInteger(value) {
  return isSafeInteger(value) && value >= 0;
}

/** @param {unknown} value @returns {value is number} */
function isSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** @param {unknown} value @returns {value is string} */
function isDraftAssetMime(value) {
  return (
    typeof value === "string" &&
    ["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(value)
  );
}

/** @param {unknown} value @param {string} code @param {number} status @returns {string} */
function requiredUuid(value, code, status) {
  if (!isUuid(value)) throw new PreviewApiError(code, status);
  return value;
}

/** @param {unknown} value @returns {value is string} */
function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

/** @param {unknown} value */
function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  );
}

/** @param {unknown} value @returns {value is string} */
function isString(value) {
  return typeof value === "string";
}
/** @param {Request} request */
function isJsonRequest(request) {
  return (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "application/json"
  );
}

class PreviewApiError extends Error {
  /** @param {string} code @param {number} status */
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
