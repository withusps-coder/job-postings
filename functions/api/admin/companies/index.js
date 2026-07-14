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
/**
 * @typedef {Record<string, unknown>} CompanyListRow
 * @typedef {Record<string, unknown>} FrozenInputRow
 * @typedef {{
 *   name: string,
 *   website: string,
 *   summary: string,
 *   idempotencyKey: string,
 *   retryOf: string | undefined,
 *   fingerprintInput: Record<string, unknown>
 * }} CreateCompanyRequest
 * @typedef {{
 *   id: string,
 *   name: string,
 *   website: string,
 *   summary: string,
 *   version: number,
 *   updatedAt: number
 * }} CompanyResult
 * @typedef {{
 *   id: string,
 *   name: string,
 *   normalizedName: string,
 *   companyJson: string,
 *   version: 1,
 *   createdAt: number,
 *   updatedAt: number
 * }} FrozenCreateCompanyInput
 */

/**
 * Lists mutable company records for the protected administrator. Company rows are
 * deliberately never joined by public runtime queries.
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
      `SELECT id, name, company_json, version, updated_at
       FROM companies
       WHERE (? IS NULL OR updated_at < ? OR (updated_at = ? AND id > ?))
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
      [
        page.cursor?.updatedAt ?? null,
        page.cursor?.updatedAt ?? 0,
        page.cursor?.updatedAt ?? 0,
        page.cursor?.id ?? "",
        page.limit + 1,
      ],
    ).all();
    const rows = result.results.map(companyFromRow);
    const hasMore = rows.length > page.limit;
    const companies = rows.slice(0, page.limit);
    return adminJson({
      companies,
      nextCursor: hasMore ? encodeCursor(companies.at(-1)) : null,
    });
  } catch (error) {
    if (error instanceof CompanyApiError)
      return companyResponse(error.status, error.code, correlationId);
    return adminError("ADMIN_UNAVAILABLE", correlationId);
  }
}

/**
 * Creates one mutable company through a durable operation. A new company has the
 * fixed "new" creation scope so a same-key replay resolves the original operation
 * rather than a newly generated company ID.
 *
 * @param {EventContext<{ DB: D1Database }, string, import("../_middleware.js").AdminMiddlewareData>} context
 */
export async function onRequestPost(context) {
  const correlationId = createCorrelationId();
  if (!context.data.admin) return adminError("ACCESS_INVALID", correlationId);
  if (!context.env.DB) return adminError("ADMIN_UNAVAILABLE", correlationId);
  if (!isJsonRequest(context.request))
    return companyResponse(415, "UNSUPPORTED_MEDIA_TYPE", correlationId);

  try {
    const request = parseCreateCompany(
      await readJson(context.request, maximumBodyBytes),
    );
    assertHeaderKey(context.request, request.idempotencyKey);
    const now = Date.now();
    const candidate = {
      id: crypto.randomUUID(),
      name: request.name,
      normalizedName: normalizedName(request.name),
      companyJson: canonicalJson({
        name: request.name,
        website: request.website,
        summary: request.summary,
      }),
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...(request.retryOf ? { retryOf: request.retryOf } : {}),
    };
    const fingerprint = await createOperationFingerprint({
      operation: "create_company",
      scopeType: "company",
      scopeId: "new",
      actorSubject: context.data.admin.subject,
      environment: context.data.adminSecurity?.environment ?? "",
      input: request.fingerprintInput,
    });
    const claim = await claimOperation(context.env.DB, {
      operationId: crypto.randomUUID(),
      scopeType: "company",
      scopeId: "new",
      operation: "create_company",
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

    const frozen = await readFrozenCompanyInput(
      context.env.DB,
      operation.id,
      "create",
    );
    const existing = await d1Statement(
      context.env.DB,
      "SELECT id FROM companies WHERE normalized_name = ?",
      [frozen.normalizedName],
    ).first();
    if (existing !== null) {
      return finalizeCompanyFailure(
        context.env.DB,
        operation,
        "COMPANY_NAME_CONFLICT",
        409,
        correlationId,
        now,
      );
    }

    const company = companyFromFrozen(frozen);
    const outcome = await finalizeOperation(context.env.DB, {
      operation,
      resourceStatements: [
        d1Statement(
          context.env.DB,
          `INSERT INTO companies (
             id, name, normalized_name, company_json, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
          [
            frozen.id,
            frozen.name,
            frozen.normalizedName,
            frozen.companyJson,
            frozen.createdAt,
            frozen.updatedAt,
          ],
        ),
      ],
      terminal: terminalOperation(
        "succeeded",
        201,
        "COMPANY_CREATED",
        correlationId,
        { company },
      ),
      now,
      failureForError: () =>
        terminalOperation(
          "failed",
          503,
          "COMPANY_CREATE_FAILED",
          correlationId,
        ),
    });
    return finalizedResponse(outcome, correlationId);
  } catch (error) {
    return companyErrorResponse(error, correlationId);
  }
}

/** @param {URL} url */
function parsePage(url) {
  const rawLimit = url.searchParams.get("limit") ?? "50";
  if (!/^\d+$/u.test(rawLimit))
    throw new CompanyApiError("PAGINATION_INVALID", 400);
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CompanyApiError("PAGINATION_INVALID", 400);
  }
  return { limit, cursor: decodeCursor(url.searchParams.get("cursor")) };
}

/** @param {string | null} value */
function decodeCursor(value) {
  if (value === null) return null;
  if (
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new CompanyApiError("PAGINATION_INVALID", 400);
  }
  try {
    const decoded = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(value)),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      !Number.isSafeInteger(decoded[0]) ||
      decoded[0] < 1 ||
      typeof decoded[1] !== "string" ||
      !isUuid(decoded[1])
    ) {
      throw new Error("invalid cursor");
    }
    return { updatedAt: decoded[0], id: decoded[1] };
  } catch {
    throw new CompanyApiError("PAGINATION_INVALID", 400);
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

/**
 * @param {unknown} value
 * @returns {CreateCompanyRequest}
 */
function parseCreateCompany(value) {
  const body = requireObject(value);
  assertOnlyKeys(body, [
    "name",
    "website",
    "summary",
    "idempotencyKey",
    "retryOf",
  ]);
  const name = requiredText(body["name"], 200, "COMPANY_NAME_INVALID");
  const website = requiredHttpsUrl(body["website"], "COMPANY_WEBSITE_INVALID");
  const summary = requiredText(
    body["summary"],
    2_000,
    "COMPANY_SUMMARY_INVALID",
  );
  const idempotencyKey = requiredUuid(
    body["idempotencyKey"],
    "IDEMPOTENCY_KEY_INVALID",
    400,
  );
  const retryOf = optionalUuid(body["retryOf"], "RETRY_OF_INVALID", 422);
  return {
    name,
    website,
    summary,
    idempotencyKey,
    retryOf,
    fingerprintInput: {
      name,
      website,
      summary,
      ...(retryOf ? { retryOf } : {}),
    },
  };
}

/** @param {Request} request @param {number} maximumBytes */
async function readJson(request, maximumBytes) {
  const bytes = await readBoundedBody(request, maximumBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CompanyApiError("INVALID_REQUEST", 400);
  }
}

/** @param {Request} request @param {string} bodyKey */
function assertHeaderKey(request, bodyKey) {
  if (request.headers.get("x-idempotency-key") !== bodyKey) {
    throw new CompanyApiError("IDEMPOTENCY_KEY_INVALID", 400);
  }
}

/**
 * @param {D1Database} database
 * @param {string} operationId
 * @param {"create"} kind
 * @returns {Promise<FrozenCreateCompanyInput>}
 */
async function readFrozenCompanyInput(database, operationId, kind) {
  const row = await d1Statement(
    database,
    "SELECT frozen_input FROM mutation_operations WHERE id = ?",
    [operationId],
  ).first();
  if (row === null || typeof row["frozen_input"] !== "string")
    throw new CompanyApiError("OPERATION_UNAVAILABLE", 503);
  let value;
  try {
    value = JSON.parse(row["frozen_input"]);
  } catch {
    throw new CompanyApiError("OPERATION_UNAVAILABLE", 503);
  }
  const input = requireObject(value);
  const id = input["id"];
  const name = input["name"];
  const normalizedName = input["normalizedName"];
  const companyJson = input["companyJson"];
  const version = input["version"];
  const createdAt = input["createdAt"];
  const updatedAt = input["updatedAt"];
  if (
    kind !== "create" ||
    !isUuid(id) ||
    typeof name !== "string" ||
    typeof normalizedName !== "string" ||
    typeof companyJson !== "string" ||
    version !== 1 ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt)
  ) {
    throw new CompanyApiError("OPERATION_UNAVAILABLE", 503);
  }
  return {
    id,
    name,
    normalizedName,
    companyJson,
    version,
    createdAt,
    updatedAt,
  };
}

/**
 * @param {CompanyListRow} row
 * @returns {CompanyResult}
 */
function companyFromRow(row) {
  const id = row["id"];
  const name = row["name"];
  const companyJson = row["company_json"];
  const version = row["version"];
  const updatedAt = row["updated_at"];
  if (
    !isUuid(id) ||
    typeof name !== "string" ||
    typeof companyJson !== "string" ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt)
  ) {
    throw new CompanyApiError("COMPANY_ROW_INVALID", 503);
  }
  const company = parseCompanyJson(companyJson);
  return {
    id,
    name,
    website: company.website,
    summary: company.summary,
    version,
    updatedAt,
  };
}

/**
 * @param {{
 *   id: string,
 *   name: string,
 *   companyJson: string,
 *   version: number,
 *   updatedAt: number
 * }} input
 * @returns {CompanyResult}
 */
function companyFromFrozen(input) {
  return companyFromRow({
    id: input.id,
    name: input.name,
    company_json: input.companyJson,
    version: input.version,
    updated_at: input.updatedAt,
  });
}

/** @param {string} value */
function parseCompanyJson(value) {
  try {
    const company = requireObject(JSON.parse(value));
    return {
      website: requiredHttpsUrl(company["website"], "COMPANY_ROW_INVALID"),
      summary: requiredText(company["summary"], 2_000, "COMPANY_ROW_INVALID"),
    };
  } catch (error) {
    if (error instanceof CompanyApiError) throw error;
    throw new CompanyApiError("COMPANY_ROW_INVALID", 503);
  }
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
async function finalizeCompanyFailure(
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
function companyErrorResponse(error, correlationId) {
  if (error instanceof CompanyApiError)
    return companyResponse(error.status, error.code, correlationId);
  if (error instanceof OperationError)
    return companyResponse(
      operationErrorStatus(error.code),
      error.code,
      correlationId,
    );
  if (error instanceof RangeError)
    return companyResponse(413, "BODY_TOO_LARGE", correlationId);
  return adminError("ADMIN_UNAVAILABLE", correlationId);
}

/** @param {number} status @param {string} code @param {string} correlationId */
function companyResponse(status, code, correlationId) {
  return adminJson(operationBody(code, correlationId), status);
}

/** @param {string} code @param {string} correlationId */
function operationBody(code, correlationId) {
  return { code, message: operationMessage(code), correlationId };
}

/** @param {string} code */
function operationMessage(code) {
  if (code === "COMPANY_CREATED") return "The company was created.";
  if (code === "COMPANY_NAME_CONFLICT")
    return "A company with that name already exists.";
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
  if (code.startsWith("COMPANY_") || code === "VALIDATION_FAILED")
    return "The company data is invalid.";
  return "The company operation could not be completed.";
}

/** @param {string} code */
function operationErrorStatus(code) {
  if (code === "IDEMPOTENCY_KEY_INVALID" || code === "OPERATION_INPUT_INVALID")
    return 400;
  if (code === "IDEMPOTENCY_KEY_REUSED") return 409;
  if (code === "RETRY_OF_INVALID") return 422;
  return 503;
}

/** @param {unknown} value */
function requireObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanyApiError("INVALID_REQUEST", 400);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} object @param {readonly string[]} allowed */
function assertOnlyKeys(object, allowed) {
  if (Object.keys(object).some((key) => !allowed.includes(key))) {
    throw new CompanyApiError("INVALID_REQUEST", 400);
  }
}

/** @param {unknown} value @param {number} maximumLength @param {string} code */
function requiredText(value, maximumLength, code) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[<>]/u.test(value)
  ) {
    throw new CompanyApiError(code, 422);
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
  ) {
    throw new CompanyApiError(code, 422);
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username ||
    url.password
  ) {
    throw new CompanyApiError(code, 422);
  }
  return url.toString();
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {number} status
 * @returns {string}
 */
function requiredUuid(value, code, status) {
  if (typeof value !== "string" || !isUuid(value))
    throw new CompanyApiError(code, status);
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

/** @param {string} name */
function normalizedName(name) {
  return name.trim().toLocaleLowerCase("en-US");
}

class CompanyApiError extends Error {
  /** @param {string} code @param {number} status */
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
