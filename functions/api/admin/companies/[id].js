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
 * @typedef {Record<string, unknown>} CompanyD1Row
 * @typedef {Record<string, unknown>} FrozenInputRow
 * @typedef {{ name?: string, website?: string, summary?: string }} CompanyPatch
 * @typedef {{
 *   expectedVersion: number,
 *   idempotencyKey: string,
 *   retryOf: string | undefined,
 *   patch: CompanyPatch,
 *   fingerprintInput: Record<string, unknown>
 * }} CompanyPatchRequest
 * @typedef {{
 *   id: string,
 *   name: string,
 *   normalizedName: string,
 *   website: string,
 *   summary: string,
 *   version: number,
 *   updatedAt: number
 * }} StoredCompany
 * @typedef {{
 *   missing: false,
 *   id: string,
 *   name: string,
 *   normalizedName: string,
 *   companyJson: string,
 *   version: number,
 *   expectedVersion: number,
 *   updatedAt: number
 * }} FrozenCompanyPatchInput
 * @typedef {{ missing: true, expectedVersion: number }} MissingCompanyPatchInput
 */

/**
 * Applies an optimistic, durable update to a mutable company. The version-zero
 * branch intentionally violates the table CHECK on a stale version, so a CAS miss
 * cannot silently terminalize as a successful no-op.
 *
 * @param {EventContext<{ DB: D1Database }, string, import("../_middleware.js").AdminMiddlewareData>} context
 */
export async function onRequestPatch(context) {
  const correlationId = createCorrelationId();
  if (!context.data.admin) return adminError("ACCESS_INVALID", correlationId);
  if (!context.env.DB) return adminError("ADMIN_UNAVAILABLE", correlationId);
  if (!isJsonRequest(context.request))
    return companyResponse(415, "UNSUPPORTED_MEDIA_TYPE", correlationId);

  try {
    const companyId = requiredUuid(
      context.params["id"],
      "COMPANY_NOT_FOUND",
      404,
    );
    const request = parseCompanyPatch(
      await readJson(context.request, maximumBodyBytes),
    );
    assertHeaderKey(context.request, request.idempotencyKey);
    const current = await readCompany(context.env.DB, companyId);
    const now = Date.now();
    const candidate = current ? mergeCompany(current, request, now) : null;
    const fingerprint = await createOperationFingerprint({
      operation: "update_company",
      scopeType: "company",
      scopeId: companyId,
      actorSubject: context.data.admin.subject,
      environment: context.data.adminSecurity?.environment ?? "",
      input: request.fingerprintInput,
    });
    const claim = await claimOperation(context.env.DB, {
      operationId: crypto.randomUUID(),
      scopeType: "company",
      scopeId: companyId,
      operation: "update_company",
      idempotencyKey: request.idempotencyKey,
      fingerprint,
      frozenInput: candidate
        ? {
            ...candidate,
            expectedVersion: request.expectedVersion,
            ...(request.retryOf ? { retryOf: request.retryOf } : {}),
          }
        : {
            expectedVersion: request.expectedVersion,
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
    const operation = pendingOperation(claim.operation);

    const frozen = await readFrozenPatchInput(context.env.DB, operation.id);
    if (frozen.missing) {
      return finalizeFailure(
        context.env.DB,
        operation,
        "COMPANY_NOT_FOUND",
        404,
        correlationId,
        now,
      );
    }
    if (frozen.expectedVersion !== request.expectedVersion) {
      return finalizeFailure(
        context.env.DB,
        operation,
        "OPERATION_UNAVAILABLE",
        503,
        correlationId,
        now,
      );
    }
    if (current === null) {
      return finalizeFailure(
        context.env.DB,
        operation,
        "COMPANY_NOT_FOUND",
        404,
        correlationId,
        now,
      );
    }
    if (current.version !== frozen.expectedVersion) {
      return finalizeFailure(
        context.env.DB,
        operation,
        "COMPANY_VERSION_CONFLICT",
        409,
        correlationId,
        now,
      );
    }

    const duplicate = await d1Statement(
      context.env.DB,
      "SELECT id FROM companies WHERE normalized_name = ? AND id <> ?",
      [frozen.normalizedName, companyId],
    ).first();
    if (duplicate !== null) {
      return finalizeFailure(
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
          `UPDATE companies
           SET name = ?, normalized_name = ?, company_json = ?,
               version = CASE WHEN version = ? THEN version + 1 ELSE 0 END,
               updated_at = ?
           WHERE id = ?`,
          [
            frozen.name,
            frozen.normalizedName,
            frozen.companyJson,
            frozen.expectedVersion,
            frozen.updatedAt,
            companyId,
          ],
        ),
      ],
      terminal: terminalOperation(
        "succeeded",
        200,
        "COMPANY_UPDATED",
        correlationId,
        { company },
      ),
      now,
      failureForError: () =>
        terminalOperation(
          "failed",
          409,
          "COMPANY_UPDATE_CONFLICT",
          correlationId,
        ),
    });
    return finalizedResponse(outcome, correlationId);
  } catch (error) {
    return companyErrorResponse(error, correlationId);
  }
}

/**
 * @param {unknown} value
 * @returns {CompanyPatchRequest}
 */
function parseCompanyPatch(value) {
  const body = requireObject(value);
  assertOnlyKeys(body, [
    "expectedVersion",
    "name",
    "website",
    "summary",
    "idempotencyKey",
    "retryOf",
  ]);
  const expectedVersion = requiredPositiveInteger(
    body["expectedVersion"],
    "COMPANY_VERSION_INVALID",
  );
  const idempotencyKey = requiredUuid(
    body["idempotencyKey"],
    "IDEMPOTENCY_KEY_INVALID",
    400,
  );
  const retryOf = optionalUuid(body["retryOf"], "RETRY_OF_INVALID", 422);
  /** @type {CompanyPatch} */
  const patch = {};
  if (Object.hasOwn(body, "name"))
    patch.name = requiredText(body["name"], 200, "COMPANY_NAME_INVALID");
  if (Object.hasOwn(body, "website"))
    patch.website = requiredHttpsUrl(
      body["website"],
      "COMPANY_WEBSITE_INVALID",
    );
  if (Object.hasOwn(body, "summary"))
    patch.summary = requiredText(
      body["summary"],
      2_000,
      "COMPANY_SUMMARY_INVALID",
    );
  if (Object.keys(patch).length === 0)
    throw new CompanyApiError("COMPANY_PATCH_EMPTY", 422);
  return {
    expectedVersion,
    idempotencyKey,
    retryOf,
    patch,
    fingerprintInput: {
      expectedVersion,
      ...patch,
      ...(retryOf ? { retryOf } : {}),
    },
  };
}

/**
 * @param {D1Database} database
 * @param {string} id
 * @returns {Promise<StoredCompany | null>}
 */
async function readCompany(database, id) {
  const row = await d1Statement(
    database,
    "SELECT id, name, normalized_name, company_json, version, updated_at FROM companies WHERE id = ?",
    [id],
  ).first();
  if (row === null) return null;
  return companyFromRow(row);
}

/**
 * @param {StoredCompany} current
 * @param {{ patch: CompanyPatch }} request
 * @param {number} now
 * @returns {{
 *   id: string,
 *   name: string,
 *   normalizedName: string,
 *   companyJson: string,
 *   version: number,
 *   updatedAt: number
 * }}
 */
function mergeCompany(current, request, now) {
  const name = request.patch.name ?? current.name;
  const website = request.patch.website ?? current.website;
  const summary = request.patch.summary ?? current.summary;
  return {
    id: current.id,
    name,
    normalizedName: normalizedName(name),
    companyJson: canonicalJson({ name, website, summary }),
    version: current.version + 1,
    updatedAt: now,
  };
}

/**
 * @param {D1Database} database
 * @param {string} operationId
 * @returns {Promise<FrozenCompanyPatchInput | MissingCompanyPatchInput>}
 */
async function readFrozenPatchInput(database, operationId) {
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
  const missing = input["missing"];
  const expectedVersion = input["expectedVersion"];
  if (missing === true) {
    if (
      typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion)
    ) {
      throw new CompanyApiError("OPERATION_UNAVAILABLE", 503);
    }
    return { missing: true, expectedVersion };
  }
  if (missing !== undefined)
    throw new CompanyApiError("OPERATION_UNAVAILABLE", 503);

  const id = input["id"];
  const name = input["name"];
  const normalizedName = input["normalizedName"];
  const companyJson = input["companyJson"];
  const version = input["version"];
  const updatedAt = input["updatedAt"];
  if (
    !isUuid(id) ||
    typeof name !== "string" ||
    typeof normalizedName !== "string" ||
    typeof companyJson !== "string" ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt)
  ) {
    throw new CompanyApiError("OPERATION_UNAVAILABLE", 503);
  }
  return {
    missing: false,
    id,
    name,
    normalizedName,
    companyJson,
    version,
    expectedVersion,
    updatedAt,
  };
}

/**
 * @param {CompanyD1Row} row
 * @returns {StoredCompany}
 */
function companyFromRow(row) {
  const id = requiredUuid(row["id"], "COMPANY_ROW_INVALID", 503);
  const name = requiredText(row["name"], 200, "COMPANY_ROW_INVALID");
  const normalizedName = row["normalized_name"];
  const companyJson = row["company_json"];
  const version = row["version"];
  const updatedAt = row["updated_at"];
  if (
    typeof normalizedName !== "string" ||
    typeof companyJson !== "string" ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt)
  ) {
    throw new CompanyApiError("COMPANY_ROW_INVALID", 503);
  }
  let stored;
  try {
    stored = requireObject(JSON.parse(companyJson));
  } catch {
    throw new CompanyApiError("COMPANY_ROW_INVALID", 503);
  }
  return {
    id,
    name,
    normalizedName,
    website: requiredHttpsUrl(stored["website"], "COMPANY_ROW_INVALID"),
    summary: requiredText(stored["summary"], 2_000, "COMPANY_ROW_INVALID"),
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
 * }} frozen
 * @returns {{
 *   id: string,
 *   name: string,
 *   website: string,
 *   summary: string,
 *   version: number,
 *   updatedAt: number
 * }}
 */
function companyFromFrozen(frozen) {
  let stored;
  try {
    stored = requireObject(JSON.parse(frozen.companyJson));
  } catch {
    throw new CompanyApiError("OPERATION_UNAVAILABLE", 503);
  }
  return {
    id: frozen.id,
    name: frozen.name,
    website: requiredHttpsUrl(stored["website"], "OPERATION_UNAVAILABLE"),
    summary: requiredText(stored["summary"], 2_000, "OPERATION_UNAVAILABLE"),
    version: frozen.version,
    updatedAt: frozen.updatedAt,
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
  if (code === "COMPANY_UPDATED") return "The company was updated.";
  if (code === "COMPANY_NOT_FOUND")
    return "The requested company was not found.";
  if (code === "COMPANY_VERSION_CONFLICT" || code === "COMPANY_UPDATE_CONFLICT")
    return "The company changed before the operation could be completed.";
  if (code === "COMPANY_NAME_CONFLICT")
    return "A company with that name already exists.";
  if (code === "COMPANY_PATCH_EMPTY")
    return "At least one company field must be changed.";
  if (code === "IDEMPOTENCY_KEY_INVALID")
    return "The idempotency key must match the request body.";
  if (code === "IDEMPOTENCY_KEY_REUSED")
    return "The idempotency key was used for a different request.";
  if (code === "RETRY_OF_INVALID")
    return "The retry reference is not valid for this operation.";
  if (code === "OPERATION_IN_PROGRESS")
    return "The requested operation is still in progress.";
  if (code.startsWith("COMPANY_")) return "The company data is invalid.";
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
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CompanyApiError("INVALID_REQUEST", 400);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} object @param {readonly string[]} allowed */
function assertOnlyKeys(object, allowed) {
  if (Object.keys(object).some((key) => !allowed.includes(key)))
    throw new CompanyApiError("INVALID_REQUEST", 400);
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
  )
    throw new CompanyApiError(code, 422);
  return url.toString();
}

/**
 * @param {unknown} value
 * @param {string} code
 * @returns {number}
 */
function requiredPositiveInteger(value, code) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CompanyApiError(code, 422);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {number} status
 * @returns {string}
 */
function requiredUuid(value, code, status) {
  if (!isUuid(value)) throw new CompanyApiError(code, status);
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
