import { d1Statement } from "../../../_lib/db.js";
import { readBoundedBody } from "../../../_lib/csrf.js";
import {
  adminError,
  adminJson,
  createCorrelationId,
} from "../../../_lib/errors.js";
import {
  claimOperation,
  createOperationFingerprint,
  finalizeOperation,
  OperationError,
} from "../../../_lib/operations.js";
import { canonicalJson } from "../../../_lib/snapshot.js";

const maximumBodyBytes = 16 * 1024;
const mutationLeaseMilliseconds = 30 * 1000;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/**
 * @typedef {Record<string, unknown>} D1Row
 * @typedef {Record<string, unknown>} JsonObject
 * @typedef {{ name: string, website: string, summary: string }} CompanySnapshot
 * @typedef {{
 *   slug: string,
 *   companyId: string,
 *   draft: JsonObject,
 *   companySnapshot: CompanySnapshot | undefined,
 *   application: JsonObject,
 *   idempotencyKey: string,
 *   retryOf: string | undefined,
 *   fingerprintInput: Record<string, unknown>
 * }} JobCreateRequest
 * @typedef {{
 *   id: string,
 *   slug: string,
 *   activeRevisionId: string | null,
 *   activeGeneration: number,
 *   companyId: string | null,
 *   draftVersion: number,
 *   updatedAt: number
 * }} JobResult
 * @typedef {{
 *   id: string,
 *   slug: string,
 *   companyId: string,
 *   draftJson: string,
 *   companySnapshotJson: string,
 *   applicationJson: string,
 *   createdAt: number,
 *   missingCompany: boolean
 * }} FrozenJobCreateInput
 */

/**
 * Lists administrative job state without reading any public revision snapshots.
 * The cursor is opaque and the requested page size is bounded to 1..100.
 *
 * @param {EventContext<{ DB: D1Database }, string, import("../_middleware.js").AdminMiddlewareData>} context
 */
export async function onRequestGet(context) {
  const correlationId = createCorrelationId();
  if (!context.data.admin) return adminError("ACCESS_INVALID", correlationId);
  if (!context.env.DB) return adminError("ADMIN_UNAVAILABLE", correlationId);

  try {
    const page = parsePage(new URL(context.request.url));
    const result = await d1Statement(
      context.env.DB,
      `SELECT jobs.id, jobs.slug, jobs.active_revision_id, jobs.active_generation,
              jobs.updated_at, drafts.company_id, drafts.version AS draft_version
       FROM jobs
       JOIN job_drafts AS drafts ON drafts.job_id = jobs.id
       WHERE (? IS NULL OR jobs.updated_at < ? OR (jobs.updated_at = ? AND jobs.id > ?))
       ORDER BY jobs.updated_at DESC, jobs.id ASC
       LIMIT ?`,
      [
        page.cursor?.updatedAt ?? null,
        page.cursor?.updatedAt ?? 0,
        page.cursor?.updatedAt ?? 0,
        page.cursor?.id ?? "",
        page.limit + 1,
      ],
    ).all();
    const rows = result.results.map(jobFromRow);
    const hasMore = rows.length > page.limit;
    const jobs = rows.slice(0, page.limit);
    return adminJson({
      jobs,
      nextCursor: hasMore ? encodeCursor(jobs.at(-1)) : null,
    });
  } catch (error) {
    if (error instanceof JobApiError)
      return jobResponse(error.status, error.code, correlationId);
    return adminError("ADMIN_UNAVAILABLE", correlationId);
  }
}

/**
 * Creates a private job and its first draft. No revision, public pointer, or public
 * media binding is created here; the job remains invisible until a later publish.
 *
 * @param {EventContext<{ DB: D1Database }, string, import("../_middleware.js").AdminMiddlewareData>} context
 */
export async function onRequestPost(context) {
  const correlationId = createCorrelationId();
  if (!context.data.admin) return adminError("ACCESS_INVALID", correlationId);
  if (!context.env.DB) return adminError("ADMIN_UNAVAILABLE", correlationId);
  if (!isJsonRequest(context.request))
    return jobResponse(415, "UNSUPPORTED_MEDIA_TYPE", correlationId);

  try {
    const request = parseJobCreate(
      await readJson(context.request, maximumBodyBytes),
    );
    assertHeaderKey(context.request, request.idempotencyKey);
    const company = await readCompany(context.env.DB, request.companyId);
    const now = Date.now();
    const candidate = {
      id: crypto.randomUUID(),
      slug: request.slug,
      companyId: request.companyId,
      draftJson: canonicalJson(request.draft),
      companySnapshotJson: canonicalJson(
        request.companySnapshot ?? company?.company ?? {},
      ),
      applicationJson: canonicalJson(request.application),
      createdAt: now,
      ...(company === null ? { missingCompany: true } : {}),
      ...(request.retryOf ? { retryOf: request.retryOf } : {}),
    };
    const fingerprint = await createOperationFingerprint({
      operation: "create_job",
      scopeType: "job",
      scopeId: "new",
      actorSubject: context.data.admin.subject,
      environment: context.data.adminSecurity?.environment ?? "",
      input: request.fingerprintInput,
    });
    const claim = await claimOperation(context.env.DB, {
      operationId: crypto.randomUUID(),
      scopeType: "job",
      scopeId: "new",
      operation: "create_job",
      idempotencyKey: request.idempotencyKey,
      fingerprint,
      frozenInput: candidate,
      actorSubject: context.data.admin.subject,
      environment: context.data.adminSecurity?.environment ?? "",
      leaseToken: crypto.randomUUID(),
      leaseDurationMs: mutationLeaseMilliseconds,
      now,
      correlationId,
      ...(request.retryOf ? { retryOf: request.retryOf } : {}),
    });
    if (claim.kind !== "claimed") return claimedResponse(claim, correlationId);
    const operation = pendingOperation(claim.operation);

    const frozen = await readFrozenCreateInput(context.env.DB, operation.id);
    const reserved = await d1Statement(
      context.env.DB,
      "SELECT 1 FROM reserved_slugs WHERE slug = ?",
      [frozen.slug],
    ).first();
    if (reserved !== null) {
      return finalizeFailure(
        context.env.DB,
        operation,
        "RESERVED_SLUG",
        409,
        correlationId,
        now,
      );
    }
    const existing = await d1Statement(
      context.env.DB,
      "SELECT id FROM jobs WHERE slug = ?",
      [frozen.slug],
    ).first();
    if (existing !== null) {
      return finalizeFailure(
        context.env.DB,
        operation,
        "JOB_SLUG_CONFLICT",
        409,
        correlationId,
        now,
      );
    }
    if (
      frozen.missingCompany ||
      (await readCompany(context.env.DB, frozen.companyId)) === null
    ) {
      return finalizeFailure(
        context.env.DB,
        operation,
        "COMPANY_NOT_FOUND",
        422,
        correlationId,
        now,
      );
    }

    const result = {
      job: { id: frozen.id, slug: frozen.slug, activeGeneration: 0 },
      draft: { version: 1, companyId: frozen.companyId },
    };
    const outcome = await finalizeOperation(context.env.DB, {
      operation,
      resourceStatements: [
        d1Statement(
          context.env.DB,
          `INSERT INTO jobs (id, slug, active_revision_id, active_generation, created_at, updated_at)
           VALUES (?, ?, NULL, 0, ?, ?)`,
          [frozen.id, frozen.slug, frozen.createdAt, frozen.createdAt],
        ),
        d1Statement(
          context.env.DB,
          `INSERT INTO job_drafts (
             job_id, company_id, version, draft_json, company_snapshot_json,
             application_json, created_at, updated_at
           ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
          [
            frozen.id,
            frozen.companyId,
            frozen.draftJson,
            frozen.companySnapshotJson,
            frozen.applicationJson,
            frozen.createdAt,
            frozen.createdAt,
          ],
        ),
      ],
      terminal: terminalOperation(
        "succeeded",
        201,
        "JOB_CREATED",
        correlationId,
        result,
      ),
      now,
      failureForError: () =>
        terminalOperation("failed", 503, "JOB_CREATE_FAILED", correlationId),
    });
    return finalizedResponse(outcome, correlationId);
  } catch (error) {
    return jobErrorResponse(error, correlationId);
  }
}

/**
 * @param {unknown} value
 * @returns {JobCreateRequest}
 */
function parseJobCreate(value) {
  const body = requireObject(value);
  assertOnlyKeys(body, [
    "slug",
    "companyId",
    "draft",
    "companySnapshot",
    "application",
    "idempotencyKey",
    "retryOf",
  ]);
  const slug = requiredSlug(body["slug"]);
  const companyId = requiredUuid(body["companyId"], "COMPANY_ID_INVALID", 422);
  const idempotencyKey = requiredUuid(
    body["idempotencyKey"],
    "IDEMPOTENCY_KEY_INVALID",
    400,
  );
  const retryOf = optionalUuid(body["retryOf"], "RETRY_OF_INVALID", 422);
  const draft = Object.hasOwn(body, "draft")
    ? validatedDraft(body["draft"])
    : { status: "open" };
  const companySnapshot = Object.hasOwn(body, "companySnapshot")
    ? validatedCompanySnapshot(body["companySnapshot"])
    : undefined;
  const application = Object.hasOwn(body, "application")
    ? validatedApplication(body["application"])
    : {};
  return {
    slug,
    companyId,
    draft,
    companySnapshot,
    application,
    idempotencyKey,
    retryOf,
    fingerprintInput: {
      slug,
      companyId,
      draft,
      ...(companySnapshot ? { companySnapshot } : {}),
      ...(Object.keys(application).length > 0 ? { application } : {}),
      ...(retryOf ? { retryOf } : {}),
    },
  };
}

/**
 * @param {D1Database} database
 * @param {string} companyId
 * @returns {Promise<{ company: CompanySnapshot } | null>}
 */
async function readCompany(database, companyId) {
  const row = await d1Statement(
    database,
    "SELECT company_json FROM companies WHERE id = ?",
    [companyId],
  ).first();
  if (row === null) return null;
  const companyJson = row["company_json"];
  if (typeof companyJson !== "string")
    throw new JobApiError("COMPANY_ROW_INVALID", 503);
  let company;
  try {
    company = validatedCompanySnapshot(JSON.parse(companyJson));
  } catch (error) {
    if (error instanceof JobApiError)
      throw new JobApiError("COMPANY_ROW_INVALID", 503);
    throw new JobApiError("COMPANY_ROW_INVALID", 503);
  }
  return { company };
}

/**
 * @param {D1Database} database
 * @param {string} operationId
 * @returns {Promise<FrozenJobCreateInput>}
 */
async function readFrozenCreateInput(database, operationId) {
  const row = await d1Statement(
    database,
    "SELECT frozen_input FROM mutation_operations WHERE id = ?",
    [operationId],
  ).first();
  if (row === null || typeof row["frozen_input"] !== "string")
    throw new JobApiError("OPERATION_UNAVAILABLE", 503);
  let value;
  try {
    value = JSON.parse(row["frozen_input"]);
  } catch {
    throw new JobApiError("OPERATION_UNAVAILABLE", 503);
  }
  const input = requireObject(value);
  const id = input["id"];
  const slug = input["slug"];
  const companyId = input["companyId"];
  const draftJson = input["draftJson"];
  const companySnapshotJson = input["companySnapshotJson"];
  const applicationJson = input["applicationJson"];
  const createdAt = input["createdAt"];
  const missingCompany = input["missingCompany"];
  if (
    !isUuid(id) ||
    !isSlug(slug) ||
    !isUuid(companyId) ||
    typeof draftJson !== "string" ||
    typeof companySnapshotJson !== "string" ||
    typeof applicationJson !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    (missingCompany !== undefined && missingCompany !== true)
  ) {
    throw new JobApiError("OPERATION_UNAVAILABLE", 503);
  }
  return {
    id,
    slug,
    companyId,
    draftJson,
    companySnapshotJson,
    applicationJson,
    createdAt,
    missingCompany: missingCompany === true,
  };
}

/**
 * @param {D1Row} row
 * @returns {JobResult}
 */
function jobFromRow(row) {
  const id = requiredUuid(row["id"], "JOB_ROW_INVALID", 503);
  const slug = row["slug"];
  const activeRevisionId = row["active_revision_id"];
  const activeGeneration = row["active_generation"];
  const companyId = row["company_id"];
  const draftVersion = row["draft_version"];
  const updatedAt = row["updated_at"];
  if (
    !isSlug(slug) ||
    typeof activeGeneration !== "number" ||
    !Number.isSafeInteger(activeGeneration) ||
    activeGeneration < 0 ||
    typeof draftVersion !== "number" ||
    !Number.isSafeInteger(draftVersion) ||
    draftVersion < 1 ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt) ||
    (companyId !== null && !isUuid(companyId)) ||
    (activeRevisionId !== null && !isUuid(activeRevisionId))
  ) {
    throw new JobApiError("JOB_ROW_INVALID", 503);
  }
  return {
    id,
    slug,
    activeRevisionId,
    activeGeneration,
    companyId,
    draftVersion,
    updatedAt,
  };
}

/** @param {URL} url */
function parsePage(url) {
  const rawLimit = url.searchParams.get("limit") ?? "50";
  if (!/^\d+$/u.test(rawLimit))
    throw new JobApiError("PAGINATION_INVALID", 400);
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new JobApiError("PAGINATION_INVALID", 400);
  return { limit, cursor: decodeCursor(url.searchParams.get("cursor")) };
}

/** @param {string | null} value */
function decodeCursor(value) {
  if (value === null) return null;
  if (
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    throw new JobApiError("PAGINATION_INVALID", 400);
  try {
    const bytes = base64UrlToBytes(value);
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      !Number.isSafeInteger(decoded[0]) ||
      decoded[0] < 1 ||
      !isUuid(decoded[1])
    ) {
      throw new Error("invalid cursor");
    }
    return { updatedAt: decoded[0], id: decoded[1] };
  } catch {
    throw new JobApiError("PAGINATION_INVALID", 400);
  }
}

/** @param {{ updatedAt: number, id: string } | undefined} row */
function encodeCursor(row) {
  if (!row) return null;
  const bytes = new TextEncoder().encode(
    JSON.stringify([row.updatedAt, row.id]),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/** @param {string} value */
function base64UrlToBytes(value) {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** @param {Request} request @param {number} maximumBytes */
async function readJson(request, maximumBytes) {
  const bytes = await readBoundedBody(request, maximumBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new JobApiError("INVALID_REQUEST", 400);
  }
}

/** @param {Request} request @param {string} bodyKey */
function assertHeaderKey(request, bodyKey) {
  if (request.headers.get("x-idempotency-key") !== bodyKey)
    throw new JobApiError("IDEMPOTENCY_KEY_INVALID", 400);
}

/**
 * @param {import("../../../_lib/operations.js").OperationRow} operation
 * @returns {import("../../../_lib/operations.js").PendingOperation}
 */
function pendingOperation(operation) {
  if (operation.state !== "pending") {
    throw new OperationError(
      "OPERATION_CLAIM_UNAVAILABLE",
      "The claimed operation is not pending.",
    );
  }
  return operation;
}

/** @param {D1Database} database @param {import("../../../_lib/operations.js").PendingOperation} operation @param {string} code @param {number} status @param {string} correlationId @param {number} now */
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

/** @param {import("../../../_lib/operations.js").OperationClaim} claim @param {string} correlationId */
function claimedResponse(claim, correlationId) {
  if (claim.kind === "terminal")
    return adminJson(claim.response.body, claim.response.httpStatus);
  if (claim.kind === "in_progress")
    return inProgressResponse(claim.retryAfterSeconds, correlationId);
  throw new OperationError(
    "OPERATION_CLAIM_UNAVAILABLE",
    "An operation claim was not terminal or in progress.",
  );
}

/** @param {import("../../../_lib/operations.js").FinalizationOutcome} outcome @param {string} correlationId */
function finalizedResponse(outcome, correlationId) {
  if (outcome.kind === "in_progress")
    return inProgressResponse(outcome.retryAfterSeconds, correlationId);
  return adminJson(outcome.response.body, outcome.response.httpStatus);
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

/** @param {"succeeded" | "failed"} state @param {number} httpStatus @param {string} code @param {string} correlationId @param {Record<string, unknown>} [details] */
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
function jobErrorResponse(error, correlationId) {
  if (error instanceof JobApiError)
    return jobResponse(error.status, error.code, correlationId);
  if (error instanceof OperationError)
    return jobResponse(
      operationErrorStatus(error.code),
      error.code,
      correlationId,
    );
  if (error instanceof RangeError)
    return jobResponse(413, "BODY_TOO_LARGE", correlationId);
  return adminError("ADMIN_UNAVAILABLE", correlationId);
}

/** @param {number} status @param {string} code @param {string} correlationId */
function jobResponse(status, code, correlationId) {
  return adminJson(operationBody(code, correlationId), status);
}

/** @param {string} code @param {string} correlationId */
function operationBody(code, correlationId) {
  return { code, message: operationMessage(code), correlationId };
}

/** @param {string} code */
function operationMessage(code) {
  if (code === "JOB_CREATED") return "The job draft was created.";
  if (code === "JOB_SLUG_CONFLICT") return "That job slug is already in use.";
  if (code === "RESERVED_SLUG") return "That job slug is reserved.";
  if (code === "COMPANY_NOT_FOUND")
    return "The selected company was not found.";
  if (code === "IDEMPOTENCY_KEY_INVALID")
    return "The idempotency key must match the request body.";
  if (code === "IDEMPOTENCY_KEY_REUSED")
    return "The idempotency key was used for a different request.";
  if (code === "RETRY_OF_INVALID")
    return "The retry reference is not valid for this operation.";
  if (code === "OPERATION_IN_PROGRESS")
    return "The requested operation is still in progress.";
  if (code === "PAGINATION_INVALID")
    return "The page cursor or limit is invalid.";
  if (code.startsWith("JOB_") || code.includes("_INVALID"))
    return "The job data is invalid.";
  return "The job operation could not be completed.";
}

/** @param {string} code */
function operationErrorStatus(code) {
  if (code === "IDEMPOTENCY_KEY_INVALID" || code === "OPERATION_INPUT_INVALID")
    return 400;
  if (code === "IDEMPOTENCY_KEY_REUSED") return 409;
  if (code === "RETRY_OF_INVALID") return 422;
  return 503;
}

/**
 * @param {unknown} value
 * @returns {JsonObject}
 */
function validatedDraft(value) {
  const draft = requireObject(value);
  validateJsonValue(draft, 0);
  if (draft["status"] !== "open" && draft["status"] !== "closed")
    throw new JobApiError("DRAFT_STATUS_INVALID", 422);
  return draft;
}

/**
 * @param {unknown} value
 * @returns {CompanySnapshot}
 */
function validatedCompanySnapshot(value) {
  const company = requireObject(value);
  if (
    Object.keys(company).some(
      (key) => !["name", "website", "summary"].includes(key),
    )
  ) {
    throw new JobApiError("COMPANY_SNAPSHOT_INVALID", 422);
  }
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

/**
 * @param {unknown} value
 * @returns {JsonObject}
 */
function validatedApplication(value) {
  const application = requireObject(value);
  if (Object.keys(application).length === 0) return application;
  if (
    Object.keys(application).some(
      (key) => !["kind", "value", "provenance"].includes(key),
    )
  ) {
    throw new JobApiError("APPLICATION_INVALID", 422);
  }
  const kind = application["kind"];
  const valueText = application["value"];
  const provenance = application["provenance"];
  if (kind !== "email" && kind !== "url")
    throw new JobApiError("APPLICATION_KIND_INVALID", 422);
  if (
    typeof provenance !== "string" ||
    provenance.trim().length === 0 ||
    provenance.length > 2_000 ||
    /[<>]/u.test(provenance)
  ) {
    throw new JobApiError("APPLICATION_PROVENANCE_INVALID", 422);
  }
  if (
    kind === "email" &&
    (typeof valueText !== "string" ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(valueText) ||
      valueText.length > 320)
  ) {
    throw new JobApiError("APPLICATION_EMAIL_INVALID", 422);
  }
  if (kind === "url") requiredHttpsUrl(valueText, "APPLICATION_URL_INVALID");
  return { kind, value: valueText, provenance: provenance.trim() };
}

/** @param {unknown} value @param {number} depth */
function validateJsonValue(value, depth) {
  if (depth > 12) throw new JobApiError("DRAFT_TOO_COMPLEX", 422);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 16_000) throw new JobApiError("DRAFT_TOO_COMPLEX", 422);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new JobApiError("DRAFT_INVALID", 422);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) throw new JobApiError("DRAFT_TOO_COMPLEX", 422);
    for (const item of value) validateJsonValue(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const object = /** @type {Record<string, unknown>} */ (value);
    const entries = Object.entries(object);
    if (entries.length > 100) throw new JobApiError("DRAFT_TOO_COMPLEX", 422);
    for (const [key, nested] of entries) {
      if (key.length === 0 || key.length > 100)
        throw new JobApiError("DRAFT_INVALID", 422);
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
  throw new JobApiError("DRAFT_INVALID", 422);
}

/** @param {unknown} value */
function requireObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new JobApiError("INVALID_REQUEST", 400);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} object @param {readonly string[]} allowed */
function assertOnlyKeys(object, allowed) {
  if (Object.keys(object).some((key) => !allowed.includes(key)))
    throw new JobApiError("INVALID_REQUEST", 400);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function requiredSlug(value) {
  if (!isSlug(value)) throw new JobApiError("JOB_SLUG_INVALID", 422);
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isSlug(value) {
  return (
    typeof value === "string" && value.length <= 80 && slugPattern.test(value)
  );
}

/** @param {unknown} value @param {number} maximumLength @param {string} code */
function requiredText(value, maximumLength, code) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[<>]/u.test(value)
  ) {
    throw new JobApiError(code, 422);
  }
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
    throw new JobApiError(code, 422);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username ||
    url.password
  )
    throw new JobApiError(code, 422);
  return url.toString();
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {number} status
 * @returns {string}
 */
function requiredUuid(value, code, status) {
  if (!isUuid(value)) throw new JobApiError(code, status);
  return value;
}

/** @param {unknown} value @param {string} code @param {number} status */
function optionalUuid(value, code, status) {
  if (value === undefined) return undefined;
  return requiredUuid(value, code, status);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
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

class JobApiError extends Error {
  /** @param {string} code @param {number} status */
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
