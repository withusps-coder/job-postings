import { d1Statement, readDraftByJobId } from "../../../../_lib/db.js";
import { readBoundedBody } from "../../../../_lib/csrf.js";
import {
  adminError,
  adminJson,
  createCorrelationId,
} from "../../../../_lib/errors.js";
import {
  claimOperation,
  createOperationFingerprint,
  finalizeOperation,
  OperationError,
} from "../../../../_lib/operations.js";
import { canonicalJson } from "../../../../_lib/snapshot.js";

const maximumBodyBytes = 256 * 1024;
const mutationLeaseMilliseconds = 30 * 1000;
/**
 * @typedef {null | boolean | number | string | unknown[] | Record<string, unknown>} JsonValue
 * @typedef {Record<string, JsonValue>} JsonObject
 * @typedef {JsonObject & { status: "open" | "closed" }} DraftContent
 * @typedef {JsonObject & { name: string, website: string, summary: string }} CompanySnapshot
 * @typedef {JsonObject & { kind: "email" | "url", value: string, provenance: string }} Application
 * @typedef {{ draft?: DraftContent, companySnapshot?: CompanySnapshot, application?: Application }} DraftPatch
 * @typedef {{ expectedDraftVersion: number, idempotencyKey: string, retryOf?: string, patch: DraftPatch, fingerprintInput: Record<string, unknown> }} DraftPatchRequest
 * @typedef {{ draftJson: string, companySnapshotJson: string, applicationJson: string, updatedAt: number }} DraftMutation
 * @typedef {{ missing: true, expectedDraftVersion: number } | { missing: false, draftJson: string, companySnapshotJson: string, applicationJson: string, expectedDraftVersion: number, updatedAt: number }} FrozenDraftInput
 */

/**
 * Returns the mutable draft only to the Access-authenticated administrator. Attached
 * assets use protected admin content URLs, never public /media URLs.
 *
 * @param {EventContext<{ DB: D1Database }, string, import("../../_middleware.js").AdminMiddlewareData>} context
 */
export async function onRequestGet(context) {
  const correlationId = createCorrelationId();
  if (!context.data.admin) return adminError("ACCESS_INVALID", correlationId);
  if (!context.env.DB) return adminError("ADMIN_UNAVAILABLE", correlationId);

  try {
    const jobId = requiredUuid(context.params["id"], "DRAFT_NOT_FOUND", 404);
    const draft = await readDraftByJobId(context.env.DB, jobId);
    if (!draft) return draftResponse(404, "DRAFT_NOT_FOUND", correlationId);
    return adminJson(await draftEnvelope(context.env.DB, draft));
  } catch (error) {
    if (error instanceof DraftApiError)
      return draftResponse(error.status, error.code, correlationId);
    return adminError("ADMIN_UNAVAILABLE", correlationId);
  }
}

/**
 * Changes draft-only state through an expected-version durable operation. The draft
 * trigger rejects the zero-increment stale branch, making a version CAS miss atomic.
 *
 * @param {EventContext<{ DB: D1Database }, string, import("../../_middleware.js").AdminMiddlewareData>} context
 */
export async function onRequestPatch(context) {
  const correlationId = createCorrelationId();
  if (!context.data.admin) return adminError("ACCESS_INVALID", correlationId);
  if (!context.env.DB) return adminError("ADMIN_UNAVAILABLE", correlationId);
  if (!isJsonRequest(context.request))
    return draftResponse(415, "UNSUPPORTED_MEDIA_TYPE", correlationId);

  try {
    const jobId = requiredUuid(context.params["id"], "DRAFT_NOT_FOUND", 404);
    const request = parseDraftPatch(
      await readJson(context.request, maximumBodyBytes),
    );
    assertHeaderKey(context.request, request.idempotencyKey);
    const current = await readDraftByJobId(context.env.DB, jobId);
    const now = Date.now();
    const candidate = current ? mergeDraft(current, request, now) : null;
    const fingerprint = await createOperationFingerprint({
      operation: "update_draft",
      scopeType: "job",
      scopeId: jobId,
      actorSubject: context.data.admin.subject,
      environment: context.data.adminSecurity?.environment ?? "",
      input: request.fingerprintInput,
    });
    const claim = await claimOperation(context.env.DB, {
      operationId: crypto.randomUUID(),
      scopeType: "job",
      scopeId: jobId,
      operation: "update_draft",
      idempotencyKey: request.idempotencyKey,
      fingerprint,
      frozenInput: candidate
        ? {
            ...candidate,
            expectedDraftVersion: request.expectedDraftVersion,
            ...(request.retryOf ? { retryOf: request.retryOf } : {}),
          }
        : {
            expectedDraftVersion: request.expectedDraftVersion,
            missing: true,
            ...(request.retryOf ? { retryOf: request.retryOf } : {}),
          },
      actorSubject: context.data.admin.subject,
      environment: context.data.adminSecurity?.environment ?? "",
      leaseToken: crypto.randomUUID(),
      leaseDurationMs: mutationLeaseMilliseconds,
      now,
      correlationId,
      ...(request.retryOf ? { retryOf: request.retryOf } : {}),
    });
    if (claim.kind !== "claimed") return claimedResponse(claim, correlationId);
    const operation = requirePendingOperation(claim.operation);

    const frozen = await readFrozenDraftInput(context.env.DB, operation.id);
    if (frozen.missing)
      return finalizeFailure(
        context.env.DB,
        operation,
        "DRAFT_NOT_FOUND",
        404,
        correlationId,
        now,
      );
    if (frozen.expectedDraftVersion !== request.expectedDraftVersion) {
      return finalizeFailure(
        context.env.DB,
        operation,
        "OPERATION_UNAVAILABLE",
        503,
        correlationId,
        now,
      );
    }
    const persisted = await readDraftByJobId(context.env.DB, jobId);
    if (!persisted)
      return finalizeFailure(
        context.env.DB,
        operation,
        "DRAFT_NOT_FOUND",
        404,
        correlationId,
        now,
      );
    if (persisted.draftVersion !== frozen.expectedDraftVersion) {
      return finalizeFailure(
        context.env.DB,
        operation,
        "DRAFT_VERSION_CONFLICT",
        409,
        correlationId,
        now,
      );
    }

    const assets = await readDraftAssets(context.env.DB, jobId);
    const responseDraft = frozenDraftEnvelope(persisted, frozen, assets);
    const outcome = await finalizeOperation(context.env.DB, {
      operation: operation,
      resourceStatements: [
        d1Statement(
          context.env.DB,
          `UPDATE job_drafts
           SET draft_json = ?, company_snapshot_json = ?, application_json = ?,
               version = version + CASE WHEN version = ? THEN 1 ELSE 0 END,
               updated_at = ?
           WHERE job_id = ?`,
          [
            frozen.draftJson,
            frozen.companySnapshotJson,
            frozen.applicationJson,
            frozen.expectedDraftVersion,
            frozen.updatedAt,
            jobId,
          ],
        ),
      ],
      terminal: terminalOperation(
        "succeeded",
        200,
        "DRAFT_UPDATED",
        correlationId,
        responseDraft,
      ),
      now,
      failureForError: (code) =>
        terminalOperation(
          "failed",
          code === "DRAFT_VERSION_INVALID" ? 409 : 503,
          code === "DRAFT_VERSION_INVALID"
            ? "DRAFT_VERSION_CONFLICT"
            : "DRAFT_UPDATE_FAILED",
          correlationId,
        ),
    });
    return finalizedResponse(outcome, correlationId);
  } catch (error) {
    return draftErrorResponse(error, correlationId);
  }
}

/** @param {unknown} value @returns {DraftPatchRequest} */
function parseDraftPatch(value) {
  const body = requireObject(value);
  assertOnlyKeys(body, [
    "expectedDraftVersion",
    "draft",
    "companySnapshot",
    "application",
    "idempotencyKey",
    "retryOf",
  ]);
  const expectedDraftVersion = requiredPositiveInteger(
    body["expectedDraftVersion"],
    "DRAFT_VERSION_INVALID",
  );
  const idempotencyKey = requiredUuid(
    body["idempotencyKey"],
    "IDEMPOTENCY_KEY_INVALID",
    400,
  );
  const retryOf = optionalUuid(body["retryOf"], "RETRY_OF_INVALID", 422);
  /** @type {DraftPatch} */
  const patch = {};
  if (Object.hasOwn(body, "draft")) patch.draft = validatedDraft(body["draft"]);
  if (Object.hasOwn(body, "companySnapshot"))
    patch.companySnapshot = validatedCompanySnapshot(body["companySnapshot"]);
  if (Object.hasOwn(body, "application"))
    patch.application = validatedApplication(body["application"]);
  if (Object.keys(patch).length === 0)
    throw new DraftApiError("DRAFT_PATCH_EMPTY", 422);
  /** @type {Record<string, unknown>} */
  const fingerprintInput = {
    expectedDraftVersion,
    ...patch,
    ...(retryOf ? { retryOf } : {}),
  };
  return {
    expectedDraftVersion,
    idempotencyKey,
    ...(retryOf ? { retryOf } : {}),
    patch,
    fingerprintInput,
  };
}

/**
 * @param {import("../../../../_lib/db.js").DraftRow} current
 * @param {DraftPatchRequest} request
 * @param {number} now
 * @returns {DraftMutation}
 */
function mergeDraft(current, request, now) {
  const currentDraft = parseStoredObject(
    current.draftJson,
    "DRAFT_ROW_INVALID",
  );
  const currentCompany = parseStoredObject(
    current.companySnapshotJson,
    "DRAFT_ROW_INVALID",
  );
  const currentApplication = parseStoredObject(
    current.applicationJson,
    "DRAFT_ROW_INVALID",
  );
  const draft = request.patch.draft ?? currentDraft;
  const companySnapshot = request.patch.companySnapshot ?? currentCompany;
  const application = request.patch.application ?? currentApplication;
  return {
    draftJson: canonicalJson(draft),
    companySnapshotJson: canonicalJson(companySnapshot),
    applicationJson: canonicalJson(application),
    updatedAt: now,
  };
}

/**
 * @param {D1Database} database
 * @param {string} operationId
 * @returns {Promise<FrozenDraftInput>}
 */
async function readFrozenDraftInput(database, operationId) {
  const row = await d1Statement(
    database,
    "SELECT frozen_input FROM mutation_operations WHERE id = ?",
    [operationId],
  ).first();
  if (!row || typeof row["frozen_input"] !== "string")
    throw new DraftApiError("OPERATION_UNAVAILABLE", 503);
  let value;
  try {
    value = JSON.parse(row["frozen_input"]);
  } catch {
    throw new DraftApiError("OPERATION_UNAVAILABLE", 503);
  }
  const input = requireObject(value);
  const expectedDraftVersion = input["expectedDraftVersion"];
  if (input["missing"] === true && isPositiveInteger(expectedDraftVersion)) {
    return { missing: true, expectedDraftVersion };
  }
  const draftJson = input["draftJson"];
  const companySnapshotJson = input["companySnapshotJson"];
  const applicationJson = input["applicationJson"];
  const updatedAt = input["updatedAt"];
  if (
    typeof draftJson !== "string" ||
    typeof companySnapshotJson !== "string" ||
    typeof applicationJson !== "string" ||
    !isPositiveInteger(expectedDraftVersion) ||
    !isSafeInteger(updatedAt)
  ) {
    throw new DraftApiError("OPERATION_UNAVAILABLE", 503);
  }
  return {
    missing: false,
    draftJson,
    companySnapshotJson,
    applicationJson,
    expectedDraftVersion,
    updatedAt,
  };
}

/** @param {D1Database} database @param {import("../../../../_lib/db.js").DraftRow} draft */
async function draftEnvelope(database, draft) {
  return {
    job: {
      id: draft.jobId,
      slug: draft.slug,
      activeRevisionId: draft.activeRevisionId,
      activeGeneration: draft.activeGeneration,
    },
    draft: {
      version: draft.draftVersion,
      companyId: draft.companyId,
      draft: parseStoredObject(draft.draftJson, "DRAFT_ROW_INVALID"),
      companySnapshot: parseStoredObject(
        draft.companySnapshotJson,
        "DRAFT_ROW_INVALID",
      ),
      application: parseStoredObject(
        draft.applicationJson,
        "DRAFT_ROW_INVALID",
      ),
      updatedAt: draft.draftUpdatedAt,
      assets: await readDraftAssets(database, draft.jobId),
    },
  };
}

/**
 * @param {import("../../../../_lib/db.js").DraftRow} persisted
 * @param {Extract<FrozenDraftInput, { missing: false }>} frozen
 * @param {readonly DraftAsset[]} assets
 */
function frozenDraftEnvelope(persisted, frozen, assets) {
  return {
    job: {
      id: persisted.jobId,
      slug: persisted.slug,
      activeRevisionId: persisted.activeRevisionId,
      activeGeneration: persisted.activeGeneration,
    },
    draft: {
      version: frozen.expectedDraftVersion + 1,
      companyId: persisted.companyId,
      draft: parseStoredObject(frozen.draftJson, "OPERATION_UNAVAILABLE"),
      companySnapshot: parseStoredObject(
        frozen.companySnapshotJson,
        "OPERATION_UNAVAILABLE",
      ),
      application: parseStoredObject(
        frozen.applicationJson,
        "OPERATION_UNAVAILABLE",
      ),
      updatedAt: frozen.updatedAt,
      assets,
    },
  };
}

/** @param {D1Database} database @param {string} jobId @returns {Promise<DraftAsset[]>} */
async function readDraftAssets(database, jobId) {
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
  return result.results.map(parseDraftAssetRow);
}

/**
 * @param {Record<string, unknown>} row
 * @returns {DraftAsset}
 */
function parseDraftAssetRow(row) {
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
    throw new DraftApiError("DRAFT_ASSET_ROW_INVALID", 503);
  }
  return {
    assetId,
    role,
    ordinal,
    mimeType,
    byteLength,
    sha256,
    contentUrl: `/api/admin/assets/${encodeURIComponent(assetId)}/content`,
  };
}

/** @param {Request} request @param {number} maximumBytes */
async function readJson(request, maximumBytes) {
  const bytes = await readBoundedBody(request, maximumBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DraftApiError("INVALID_REQUEST", 400);
  }
}

/** @param {Request} request @param {string} bodyKey */
function assertHeaderKey(request, bodyKey) {
  if (request.headers.get("x-idempotency-key") !== bodyKey)
    throw new DraftApiError("IDEMPOTENCY_KEY_INVALID", 400);
}

/**
 * @param {D1Database} database
 * @param {import("../../../../_lib/operations.js").PendingOperation} operation
 * @param {string} code
 * @param {number} status
 * @param {string} correlationId
 * @param {number} now
 */
async function finalizeFailure(
  database,
  operation,
  code,
  status,
  correlationId,
  now,
) {
  const outcome = await finalizeOperation(database, {
    operation,
    resourceStatements: [],
    terminal: terminalOperation("failed", status, code, correlationId),
    now,
    failureForError: () =>
      terminalOperation(
        "failed",
        503,
        "OPERATION_FINALIZATION_FAILED",
        correlationId,
      ),
  });
  return finalizedResponse(outcome, correlationId);
}

/**
 * @param {Exclude<import("../../../../_lib/operations.js").OperationClaim, { kind: "claimed" }>} claim
 * @param {string} correlationId
 */
function claimedResponse(claim, correlationId) {
  if (claim.kind === "terminal")
    return adminJson(claim.response.body, claim.response.httpStatus);
  return inProgressResponse(claim.retryAfterSeconds, correlationId);
}

/**
 * @param {import("../../../../_lib/operations.js").FinalizationOutcome} outcome
 * @param {string} correlationId
 */
function finalizedResponse(outcome, correlationId) {
  if (outcome.kind === "terminal")
    return adminJson(outcome.response.body, outcome.response.httpStatus);
  return inProgressResponse(outcome.retryAfterSeconds, correlationId);
}

/** @param {number} retryAfterSeconds @param {string} correlationId */
function inProgressResponse(retryAfterSeconds, correlationId) {
  return new Response(
    JSON.stringify(operationBody("OPERATION_IN_PROGRESS", correlationId)),
    {
      status: 202,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(retryAfterSeconds),
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/**
 * @param {"succeeded" | "failed"} state
 * @param {number} httpStatus
 * @param {string} code
 * @param {string} correlationId
 * @param {Record<string, unknown>} [details]
 * @returns {import("../../../../_lib/operations.js").TerminalOperation}
 */
function terminalOperation(state, httpStatus, code, correlationId, details) {
  return {
    state,
    httpStatus,
    code,
    body: JSON.stringify({
      ...operationBody(code, correlationId),
      ...(details ?? {}),
    }),
    correlationId,
  };
}

/** @param {unknown} error @param {string} correlationId */
function draftErrorResponse(error, correlationId) {
  if (error instanceof DraftApiError)
    return draftResponse(error.status, error.code, correlationId);
  if (error instanceof OperationError)
    return draftResponse(
      operationErrorStatus(error.code),
      error.code,
      correlationId,
    );
  if (error instanceof RangeError)
    return draftResponse(413, "BODY_TOO_LARGE", correlationId);
  return adminError("ADMIN_UNAVAILABLE", correlationId);
}

/** @param {number} status @param {string} code @param {string} correlationId */
function draftResponse(status, code, correlationId) {
  return adminJson(operationBody(code, correlationId), status);
}

/** @param {string} code @param {string} correlationId */
function operationBody(code, correlationId) {
  return { code, message: operationMessage(code), correlationId };
}

/** @param {string} code */
function operationMessage(code) {
  if (code === "DRAFT_UPDATED") return "The draft was updated.";
  if (code === "DRAFT_NOT_FOUND") return "The requested draft was not found.";
  if (code === "DRAFT_VERSION_CONFLICT")
    return "The draft changed before the operation could be completed.";
  if (code === "DRAFT_PATCH_EMPTY")
    return "At least one draft field must be changed.";
  if (code === "IDEMPOTENCY_KEY_INVALID")
    return "The idempotency key must match the request body.";
  if (code === "IDEMPOTENCY_KEY_REUSED")
    return "The idempotency key was used for a different request.";
  if (code === "RETRY_OF_INVALID")
    return "The retry reference is not valid for this operation.";
  if (code === "OPERATION_IN_PROGRESS")
    return "The requested operation is still in progress.";
  if (
    code.startsWith("DRAFT_") ||
    code.startsWith("APPLICATION_") ||
    code.startsWith("COMPANY_")
  )
    return "The draft data is invalid.";
  return "The draft operation could not be completed.";
}

/** @param {string} code */
function operationErrorStatus(code) {
  if (code === "IDEMPOTENCY_KEY_INVALID" || code === "OPERATION_INPUT_INVALID")
    return 400;
  if (code === "IDEMPOTENCY_KEY_REUSED") return 409;
  if (code === "RETRY_OF_INVALID") return 422;
  return 503;
}

/** @param {unknown} value @returns {DraftContent} */
function validatedDraft(value) {
  const draft = requireObject(value);
  validateJsonValue(draft, 0);
  if (draft["status"] !== "open" && draft["status"] !== "closed")
    throw new DraftApiError("DRAFT_STATUS_INVALID", 422);
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
    throw new DraftApiError("COMPANY_SNAPSHOT_INVALID", 422);
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
    throw new DraftApiError("APPLICATION_INVALID", 422);
  const kind = application["kind"];
  const valueText = application["value"];
  const provenance = application["provenance"];
  if (kind !== "email" && kind !== "url")
    throw new DraftApiError("APPLICATION_KIND_INVALID", 422);
  if (
    typeof provenance !== "string" ||
    provenance.trim().length === 0 ||
    provenance.length > 2_000 ||
    /[<>]/u.test(provenance)
  ) {
    throw new DraftApiError("APPLICATION_PROVENANCE_INVALID", 422);
  }
  if (kind === "email") {
    if (
      typeof valueText !== "string" ||
      valueText.length > 320 ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(valueText)
    ) {
      throw new DraftApiError("APPLICATION_EMAIL_INVALID", 422);
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
  if (depth > 12) throw new DraftApiError("DRAFT_TOO_COMPLEX", 422);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 16_000)
      throw new DraftApiError("DRAFT_TOO_COMPLEX", 422);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DraftApiError("DRAFT_INVALID", 422);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) throw new DraftApiError("DRAFT_TOO_COMPLEX", 422);
    for (const item of value) validateJsonValue(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const object = /** @type {Record<string, unknown>} */ (value);
    const entries = Object.entries(object);
    if (entries.length > 100) throw new DraftApiError("DRAFT_TOO_COMPLEX", 422);
    for (const [key, nested] of entries) {
      if (key.length === 0 || key.length > 100)
        throw new DraftApiError("DRAFT_INVALID", 422);
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
  throw new DraftApiError("DRAFT_INVALID", 422);
}

/** @param {string} value @param {string} code @returns {JsonObject} */
function parseStoredObject(value, code) {
  try {
    return /** @type {JsonObject} */ (requireObject(JSON.parse(value)));
  } catch {
    throw new DraftApiError(code, 503);
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function requireObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new DraftApiError("INVALID_REQUEST", 400);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} object @param {readonly string[]} allowed */
function assertOnlyKeys(object, allowed) {
  if (Object.keys(object).some((key) => !allowed.includes(key)))
    throw new DraftApiError("INVALID_REQUEST", 400);
}

/** @param {unknown} value @param {number} maximumLength @param {string} code */
function requiredText(value, maximumLength, code) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[<>]/u.test(value)
  )
    throw new DraftApiError(code, 422);
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
    throw new DraftApiError(code, 422);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username ||
    url.password
  )
    throw new DraftApiError(code, 422);
  return url.toString();
}

/** @param {unknown} value @param {string} code @returns {number} */
function requiredPositiveInteger(value, code) {
  if (!isPositiveInteger(value)) throw new DraftApiError(code, 422);
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
  if (!isUuid(value)) throw new DraftApiError(code, status);
  return value;
}

/** @param {unknown} value @param {string} code @param {number} status @returns {string | undefined} */
function optionalUuid(value, code, status) {
  if (value === undefined) return undefined;
  return requiredUuid(value, code, status);
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

/**
 * @param {import("../../../../_lib/operations.js").OperationRow} operation
 * @returns {import("../../../../_lib/operations.js").PendingOperation}
 */
function requirePendingOperation(operation) {
  if (operation.state !== "pending")
    throw new DraftApiError("OPERATION_UNAVAILABLE", 503);
  return /** @type {import("../../../../_lib/operations.js").PendingOperation} */ (
    operation
  );
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

/** @typedef {{ assetId: string, role: string, ordinal: number, mimeType: string, byteLength: number, sha256: string, contentUrl: string }} DraftAsset */

class DraftApiError extends Error {
  /** @param {string} code @param {number} status */
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
