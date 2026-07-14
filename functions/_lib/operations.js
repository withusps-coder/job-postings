import { d1Statement, executeBatch } from "./db.js";
import { canonicalJson, sha256Hex } from "./snapshot.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const terminalStates = new Set(["succeeded", "failed"]);
const stableD1Codes = new Set([
  "ACTIVE_GENERATION_INVALID",
  "ACTIVE_REVISION_ASSET_BINDING_MISMATCH",
  "ALREADY_CLOSED",
  "CLOSE_GENERATION_GUARD_FAILED",
  "CLOSE_SOURCE_GUARD_FAILED",
  "DRAFT_VERSION_INVALID",
  "OPERATION_ASSET_INTEGRITY_GUARD_FAILED",
  "OPERATION_DRAFT_ASSET_GUARD_FAILED",
  "OPERATION_LEASE_GUARD_FAILED",
  "OPERATION_PUBLICATION_INCOMPLETE",
  "PUBLISH_DRAFT_GUARD_FAILED",
  "PUBLISH_GENERATION_GUARD_FAILED",
  "PUBLISH_STATE_GUARD_FAILED",
  "RESERVED_SLUG",
  "ROLLBACK_GENERATION_GUARD_FAILED",
  "ROLLBACK_SOURCE_GUARD_FAILED",
]);

/** A stable public-safe error for idempotency, lease, and operation input failures. */
export class OperationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "OperationError";
    this.code = code;
  }
}

/**
 * Validates a canonical lowercase UUID required for every mutation idempotency key.
 *
 * @param {string} key
 * @returns {string}
 */
export function assertIdempotencyKey(key) {
  if (!uuidPattern.test(key)) {
    throw new OperationError(
      "IDEMPOTENCY_KEY_INVALID",
      "A lowercase UUID idempotency key is required.",
    );
  }
  return key;
}

/**
 * Computes the durable request fingerprint over the scoped, validated frozen input.
 * Expected versions/generation, ordered asset IDs, and optional retry lineage are
 * covered explicitly; unvalidated request bytes are never fingerprinted as trusted input.
 *
 * @param {{ operation: string, scopeType: 'company' | 'job', scopeId: string, actorSubject: string, environment: string, input: Record<string, unknown>, retryOf?: string | undefined }} input
 * @returns {Promise<string>}
 */
export async function createOperationFingerprint(input) {
  assertOperationIdentity(input);
  return sha256Hex(
    canonicalJson({
      operation: input.operation,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      actorSubject: input.actorSubject,
      environment: input.environment,
      retryOf: input.retryOf ?? null,
      input: input.input,
    }),
  );
}

/**
 * Claims a durable operation or returns the existing exact terminal response. A foreign
 * unexpired lease never runs the mutation; an expired lease is conditionally acquired
 * and then reloaded rather than inferred from an affected-row count.
 *
 * @param {D1Database} database
 * @param {{
 *   operationId: string,
 *   scopeType: 'company' | 'job',
 *   scopeId: string,
 *   operation: string,
 *   idempotencyKey: string,
 *   fingerprint: string,
 *   frozenInput: Record<string, unknown>,
 *   actorSubject: string,
 *   environment: string,
 *   leaseToken: string,
 *   leaseDurationMs: number,
 *   now: number,
 *   correlationId: string,
 *   retryOf?: string | undefined
 * }} input
 * @returns {Promise<OperationClaim>}
 */
export async function claimOperation(database, input) {
  validateClaimInput(input);
  if (input.retryOf !== undefined) {
    await assertRetryOf(database, {
      retryOf: input.retryOf,
      actorSubject: input.actorSubject,
      environment: input.environment,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      operation: input.operation,
    });
  }

  const frozenInput = canonicalJson(input.frozenInput);
  const leaseExpiresAt = input.now + input.leaseDurationMs;
  await d1Statement(
    database,
    `INSERT INTO mutation_operations (
       id, scope_type, scope_id, operation, idempotency_key, fingerprint, frozen_input,
       actor_subject, environment, retry_of, state, lease_token, lease_expires_at,
       attempt_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?, ?)
     ON CONFLICT(scope_type, scope_id, idempotency_key) DO NOTHING`,
    [
      input.operationId,
      input.scopeType,
      input.scopeId,
      input.operation,
      input.idempotencyKey,
      input.fingerprint,
      frozenInput,
      input.actorSubject,
      input.environment,
      input.retryOf ?? null,
      input.leaseToken,
      leaseExpiresAt,
      input.now,
      input.now,
    ],
  ).run();

  let operation = await readOperationByKey(
    database,
    input.scopeType,
    input.scopeId,
    input.idempotencyKey,
  );
  if (operation === null) {
    throw new OperationError(
      "OPERATION_CLAIM_UNAVAILABLE",
      "The operation claim could not be reloaded.",
    );
  }
  assertMatchingOperation(operation, input);

  if (isTerminalOperation(operation)) {
    return terminalClaim(operation);
  }
  if (operation.leaseToken === input.leaseToken) {
    await recordOperationAttempt(
      database,
      operation,
      input.correlationId,
      input.now,
    );
    return { kind: "claimed", operation };
  }

  if (operation.leaseExpiresAt <= input.now) {
    await d1Statement(
      database,
      `UPDATE mutation_operations
       SET lease_token = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ? AND state = 'pending' AND lease_expires_at <= ?`,
      [input.leaseToken, leaseExpiresAt, input.now, operation.id, input.now],
    ).run();
    operation = await readOperationById(database, operation.id);
    if (operation === null) {
      throw new OperationError(
        "OPERATION_CLAIM_UNAVAILABLE",
        "The operation claim could not be reloaded.",
      );
    }
    if (isTerminalOperation(operation)) {
      return terminalClaim(operation);
    }
    if (operation.leaseToken === input.leaseToken) {
      await recordOperationAttempt(
        database,
        operation,
        input.correlationId,
        input.now,
      );
      return { kind: "claimed", operation };
    }
  }

  return {
    kind: "in_progress",
    operation,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((operation.leaseExpiresAt - input.now) / 1000),
    ),
  };
}

/**
 * Runs a guarded terminal batch. Resource statements must be derived from persisted
 * input and placed after the lease/asset guards. On a collision it reloads durable
 * state; it never assumes a failed batch means the mutation did not commit.
 *
 * @param {D1Database} database
 * @param {{
 *   operation: PendingOperation,
 *   resourceStatements: readonly D1PreparedStatement[],
 *   terminal: TerminalOperation,
 *   now: number,
 *   failureForError: (code: string) => TerminalOperation
 * }} input
 * @returns {Promise<FinalizationOutcome>}
 */
export async function finalizeOperation(database, input) {
  try {
    await executeBatch(database, [
      createLeaseGuardStatement(database, input.operation, input.now),
      ...input.resourceStatements,
      createAttemptTerminalStatement(
        database,
        input.operation,
        input.terminal.state,
        input.terminal.code,
        input.now,
      ),
      createTerminalStatement(
        database,
        input.operation,
        input.terminal,
        input.now,
      ),
    ]);
    const operation = await readOperationById(database, input.operation.id);
    if (operation === null || !isTerminalOperation(operation)) {
      throw new OperationError(
        "OPERATION_TERMINAL_UNAVAILABLE",
        "The terminal operation could not be reloaded.",
      );
    }
    return {
      kind: "terminal",
      operation,
      response: parseTerminalResponse(operation),
    };
  } catch (error) {
    const reloaded = await readOperationById(database, input.operation.id);
    if (reloaded !== null && isTerminalOperation(reloaded)) {
      return {
        kind: "terminal",
        operation: reloaded,
        response: parseTerminalResponse(reloaded),
      };
    }
    if (
      reloaded !== null &&
      (reloaded.leaseToken !== input.operation.leaseToken ||
        reloaded.leaseExpiresAt !== input.operation.leaseExpiresAt)
    ) {
      return {
        kind: "in_progress",
        operation: reloaded,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((reloaded.leaseExpiresAt - input.now) / 1000),
        ),
      };
    }
    if (reloaded === null || reloaded.state !== "pending") {
      throw new OperationError(
        "OPERATION_FINALIZATION_UNAVAILABLE",
        "The operation outcome could not be determined.",
      );
    }

    const failure = input.failureForError(stableD1ErrorCode(error));
    try {
      await executeBatch(database, [
        createLeaseGuardStatement(database, input.operation, input.now),
        createAttemptTerminalStatement(
          database,
          input.operation,
          failure.state,
          failure.code,
          input.now,
        ),
        createTerminalStatement(database, input.operation, failure, input.now),
      ]);
    } catch {
      const afterFailure = await readOperationById(
        database,
        input.operation.id,
      );
      if (afterFailure !== null && isTerminalOperation(afterFailure)) {
        return {
          kind: "terminal",
          operation: afterFailure,
          response: parseTerminalResponse(afterFailure),
        };
      }
      if (afterFailure !== null) {
        return {
          kind: "in_progress",
          operation: afterFailure,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((afterFailure.leaseExpiresAt - input.now) / 1000),
          ),
        };
      }
      throw new OperationError(
        "OPERATION_FINALIZATION_UNAVAILABLE",
        "The operation outcome could not be determined.",
      );
    }

    const terminal = await readOperationById(database, input.operation.id);
    if (terminal === null || !isTerminalOperation(terminal)) {
      throw new OperationError(
        "OPERATION_TERMINAL_UNAVAILABLE",
        "The terminal operation could not be reloaded.",
      );
    }
    return {
      kind: "terminal",
      operation: terminal,
      response: parseTerminalResponse(terminal),
    };
  }
}

/**
 * Builds the first statement in every terminal mutation batch. The migration trigger
 * validates pending state, exact lease token, and exact expiry before resource writes.
 *
 * @param {D1Database} database
 * @param {PendingOperation} operation
 * @param {number} now
 * @returns {D1PreparedStatement}
 */
export function createLeaseGuardStatement(database, operation, now) {
  return d1Statement(
    database,
    `INSERT INTO operation_lease_guards (
       operation_id, expected_state, expected_lease_token, expected_lease_expires_at, created_at
     ) VALUES (?, 'pending', ?, ?, ?)`,
    [operation.id, operation.leaseToken, operation.leaseExpiresAt, now],
  );
}

/**
 * Builds immutable asset guards for a publish batch. The schema verifies each asset's
 * immutable metadata and active draft reference inside the same D1 transaction.
 *
 * @param {D1Database} database
 * @param {{ operationId: string, assets: readonly AssetGuard[] }} input
 * @returns {D1PreparedStatement[]}
 */
export function createAssetGuardStatements(database, input) {
  return input.assets.map((asset) => {
    validateAssetGuard(asset);
    return d1Statement(
      database,
      `INSERT INTO operation_asset_guards (
         operation_id, asset_id, role, expected_sha256, expected_mime,
         expected_byte_length, require_active_draft_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.operationId,
        asset.assetId,
        asset.role,
        asset.sha256,
        asset.mimeType,
        asset.byteLength,
        asset.requireActiveDraftRef ? 1 : 0,
        asset.createdAt,
      ],
    );
  });
}

/**
 * Builds the terminal mutation-operation update. `body` is stored byte-for-byte as the
 * JSON response body used for future same-key replay.
 *
 * @param {D1Database} database
 * @param {PendingOperation} operation
 * @param {TerminalOperation} terminal
 * @param {number} now
 * @returns {D1PreparedStatement}
 */
export function createTerminalStatement(database, operation, terminal, now) {
  validateTerminalOperation(terminal);
  return d1Statement(
    database,
    `UPDATE mutation_operations
     SET state = ?, terminal_http_status = ?, terminal_code = ?, terminal_body = ?,
         terminal_correlation_id = ?, result_revision_id = ?, result_asset_id = ?,
         terminal_at = ?, updated_at = ?
     WHERE id = ? AND state = 'pending' AND lease_token = ? AND lease_expires_at = ?`,
    [
      terminal.state,
      terminal.httpStatus,
      terminal.code,
      terminal.body,
      terminal.correlationId,
      terminal.resultRevisionId ?? null,
      terminal.resultAssetId ?? null,
      now,
      now,
      operation.id,
      operation.leaseToken,
      operation.leaseExpiresAt,
    ],
  );
}

/**
 * Validates retry lineage against the same actor, environment, scope, and operation.
 * A retry only links a failed terminal operation; it never copies frozen input.
 *
 * @param {D1Database} database
 * @param {{ retryOf: string, actorSubject: string, environment: string, scopeType: string, scopeId: string, operation: string }} input
 * @returns {Promise<void>}
 */
export async function assertRetryOf(database, input) {
  const prior = await readOperationById(database, input.retryOf);
  if (
    prior === null ||
    prior.state !== "failed" ||
    prior.actorSubject !== input.actorSubject ||
    prior.environment !== input.environment ||
    prior.scopeType !== input.scopeType ||
    prior.scopeId !== input.scopeId ||
    prior.operation !== input.operation
  ) {
    throw new OperationError(
      "RETRY_OF_INVALID",
      "Retry linkage does not match the current operation.",
    );
  }
}

/**
 * @param {D1Database} database
 * @param {PendingOperation} operation
 * @param {'succeeded' | 'failed'} outcome
 * @param {string} errorCode
 * @param {number} now
 * @returns {D1PreparedStatement}
 */
function createAttemptTerminalStatement(
  database,
  operation,
  outcome,
  errorCode,
  now,
) {
  return d1Statement(
    database,
    `UPDATE operation_attempts
     SET finished_at = ?, outcome = ?, error_code = ?
     WHERE operation_id = ? AND lease_token = ? AND finished_at IS NULL`,
    [
      now,
      outcome,
      outcome === "failed" ? errorCode : null,
      operation.id,
      operation.leaseToken,
    ],
  );
}

/**
 * @param {D1Database} database
 * @param {PendingOperation} operation
 * @param {string} correlationId
 * @param {number} now
 */
async function recordOperationAttempt(database, operation, correlationId, now) {
  await d1Statement(
    database,
    `INSERT INTO operation_attempts (
       operation_id, attempt_number, lease_token, started_at, outcome, correlation_id
     ) VALUES (?, ?, ?, ?, 'claimed', ?)
     ON CONFLICT(operation_id, attempt_number) DO NOTHING`,
    [
      operation.id,
      operation.attemptCount,
      operation.leaseToken,
      now,
      correlationId,
    ],
  ).run();
}

/**
 * @param {D1Database} database
 * @param {'company' | 'job'} scopeType
 * @param {string} scopeId
 * @param {string} idempotencyKey
 * @returns {Promise<OperationRow | null>}
 */
async function readOperationByKey(
  database,
  scopeType,
  scopeId,
  idempotencyKey,
) {
  const row = await d1Statement(
    database,
    `SELECT * FROM mutation_operations
     WHERE scope_type = ? AND scope_id = ? AND idempotency_key = ?`,
    [scopeType, scopeId, idempotencyKey],
  ).first();
  return row === null ? null : mapOperation(row);
}

/**
 * Reloads a durable operation after any D1 timeout or guard collision.
 *
 * @param {D1Database} database
 * @param {string} operationId
 * @returns {Promise<OperationRow | null>}
 */
export async function readOperationById(database, operationId) {
  const row = await d1Statement(
    database,
    "SELECT * FROM mutation_operations WHERE id = ?",
    [operationId],
  ).first();
  return row === null ? null : mapOperation(row);
}

/**
 * @param {TerminalOperationRow} operation
 * @returns {{ kind: 'terminal', operation: TerminalOperationRow, response: { httpStatus: number, code: string, bodyText: string, body: unknown, correlationId: string | null } }}
 */
function terminalClaim(operation) {
  return {
    kind: "terminal",
    operation,
    response: parseTerminalResponse(operation),
  };
}

/**
 * @param {OperationRow} operation
 * @returns {operation is TerminalOperationRow}
 */
function isTerminalOperation(operation) {
  return operation.state === "succeeded" || operation.state === "failed";
}

/**
 * @param {TerminalOperationRow} operation
 */
function parseTerminalResponse(operation) {
  if (
    !terminalStates.has(operation.state) ||
    operation.terminalHttpStatus === null ||
    operation.terminalCode === null ||
    operation.terminalBody === null
  ) {
    throw new OperationError(
      "OPERATION_TERMINAL_INVALID",
      "Terminal operation response is invalid.",
    );
  }
  try {
    return {
      httpStatus: operation.terminalHttpStatus,
      code: operation.terminalCode,
      bodyText: operation.terminalBody,
      body: JSON.parse(operation.terminalBody),
      correlationId: operation.terminalCorrelationId,
    };
  } catch {
    throw new OperationError(
      "OPERATION_TERMINAL_INVALID",
      "Terminal operation response is invalid.",
    );
  }
}

/**
 * @param {OperationRow} operation
 * @param {{ fingerprint: string, operation: string, actorSubject: string, environment: string }} input
 */
function assertMatchingOperation(operation, input) {
  if (
    operation.fingerprint !== input.fingerprint ||
    operation.operation !== input.operation ||
    operation.actorSubject !== input.actorSubject ||
    operation.environment !== input.environment
  ) {
    throw new OperationError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was already used for another request.",
    );
  }
}

/**
 * @param {{ operationId: string, scopeType: string, scopeId: string, operation: string, idempotencyKey: string, fingerprint: string, frozenInput: unknown, actorSubject: string, environment: string, leaseToken: string, leaseDurationMs: number, now: number, correlationId: string, retryOf?: string | undefined }} input
 */
function validateClaimInput(input) {
  assertIdempotencyKey(input.operationId);
  assertIdempotencyKey(input.idempotencyKey);
  assertOperationIdentity(input);
  if (!/^[0-9a-f]{64}$/u.test(input.fingerprint)) {
    throw new OperationError(
      "OPERATION_FINGERPRINT_INVALID",
      "Operation fingerprint is invalid.",
    );
  }
  if (!isObject(input.frozenInput)) {
    throw new OperationError(
      "OPERATION_INPUT_INVALID",
      "Frozen operation input must be an object.",
    );
  }
  if (
    input.retryOf !== undefined &&
    input.frozenInput["retryOf"] !== input.retryOf
  ) {
    throw new OperationError(
      "RETRY_OF_INVALID",
      "Retry linkage must be included in frozen operation input.",
    );
  }
  if (
    typeof input.leaseToken !== "string" ||
    input.leaseToken.length === 0 ||
    input.leaseToken.length > 128
  ) {
    throw new OperationError(
      "OPERATION_LEASE_INVALID",
      "Operation lease token is invalid.",
    );
  }
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1_000 ||
    input.leaseDurationMs > 600_000
  ) {
    throw new OperationError(
      "OPERATION_LEASE_INVALID",
      "Operation lease duration is invalid.",
    );
  }
  if (!Number.isSafeInteger(input.now) || input.now <= 0) {
    throw new OperationError(
      "OPERATION_TIME_INVALID",
      "Operation time is invalid.",
    );
  }
  if (
    typeof input.correlationId !== "string" ||
    input.correlationId.length === 0 ||
    input.correlationId.length > 128
  ) {
    throw new OperationError(
      "CORRELATION_ID_INVALID",
      "Correlation ID is invalid.",
    );
  }
}

/**
 * @param {{ scopeType: string, scopeId: string, operation: string, actorSubject: string, environment: string }} input
 */
function assertOperationIdentity(input) {
  if (
    (input.scopeType !== "company" && input.scopeType !== "job") ||
    typeof input.scopeId !== "string" ||
    input.scopeId.length === 0
  ) {
    throw new OperationError(
      "OPERATION_SCOPE_INVALID",
      "Operation scope is invalid.",
    );
  }
  if (
    typeof input.operation !== "string" ||
    input.operation.length === 0 ||
    input.operation.length > 80
  ) {
    throw new OperationError(
      "OPERATION_TYPE_INVALID",
      "Operation type is invalid.",
    );
  }
  if (
    typeof input.actorSubject !== "string" ||
    input.actorSubject.length === 0 ||
    input.actorSubject.length > 320
  ) {
    throw new OperationError(
      "OPERATION_ACTOR_INVALID",
      "Operation actor is invalid.",
    );
  }
  if (
    typeof input.environment !== "string" ||
    input.environment.length === 0 ||
    input.environment.length > 80
  ) {
    throw new OperationError(
      "OPERATION_ENVIRONMENT_INVALID",
      "Operation environment is invalid.",
    );
  }
}

/** @param {AssetGuard} asset */
function validateAssetGuard(asset) {
  if (
    typeof asset.assetId !== "string" ||
    typeof asset.role !== "string" ||
    !/^[0-9a-f]{64}$/u.test(asset.sha256) ||
    !["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(
      asset.mimeType,
    ) ||
    !Number.isSafeInteger(asset.byteLength) ||
    asset.byteLength <= 0 ||
    !Number.isSafeInteger(asset.createdAt) ||
    asset.createdAt <= 0
  ) {
    throw new OperationError(
      "OPERATION_ASSET_GUARD_INVALID",
      "Operation asset guard is invalid.",
    );
  }
}

/** @param {TerminalOperation} terminal */
function validateTerminalOperation(terminal) {
  if (
    !terminalStates.has(terminal.state) ||
    !Number.isSafeInteger(terminal.httpStatus) ||
    terminal.httpStatus < 100 ||
    terminal.httpStatus > 599
  ) {
    throw new OperationError(
      "OPERATION_TERMINAL_INVALID",
      "Terminal operation state is invalid.",
    );
  }
  if (
    typeof terminal.code !== "string" ||
    terminal.code.length === 0 ||
    terminal.code.length > 80 ||
    typeof terminal.body !== "string" ||
    typeof terminal.correlationId !== "string" ||
    terminal.correlationId.length === 0 ||
    terminal.correlationId.length > 128
  ) {
    throw new OperationError(
      "OPERATION_TERMINAL_INVALID",
      "Terminal operation response is invalid.",
    );
  }
  try {
    JSON.parse(terminal.body);
  } catch {
    throw new OperationError(
      "OPERATION_TERMINAL_INVALID",
      "Terminal operation body must be JSON.",
    );
  }
}

/** @param {unknown} error */
function stableD1ErrorCode(error) {
  if (error instanceof Error) {
    for (const code of stableD1Codes) {
      if (error.message.includes(code)) {
        return code;
      }
    }
  }
  return "OPERATION_FINALIZATION_FAILED";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} row
 * @returns {OperationRow}
 */
function mapOperation(row) {
  const state = requiredString(row, "state");
  if (state !== "pending" && state !== "succeeded" && state !== "failed") {
    throw new OperationError(
      "OPERATION_ROW_INVALID",
      "Operation state is invalid.",
    );
  }
  return {
    id: requiredString(row, "id"),
    scopeType: requiredScopeType(row["scope_type"]),
    scopeId: requiredString(row, "scope_id"),
    operation: requiredString(row, "operation"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    fingerprint: requiredString(row, "fingerprint"),
    actorSubject: requiredString(row, "actor_subject"),
    environment: requiredString(row, "environment"),
    retryOf: optionalString(row["retry_of"]),
    state,
    leaseToken: requiredString(row, "lease_token"),
    leaseExpiresAt: requiredNumber(row, "lease_expires_at"),
    attemptCount: requiredNumber(row, "attempt_count"),
    terminalHttpStatus: optionalNumber(row["terminal_http_status"]),
    terminalCode: optionalString(row["terminal_code"]),
    terminalBody: optionalString(row["terminal_body"]),
    terminalCorrelationId: optionalString(row["terminal_correlation_id"]),
    resultRevisionId: optionalString(row["result_revision_id"]),
    resultAssetId: optionalString(row["result_asset_id"]),
  };
}

/** @param {unknown} value */
function requiredScopeType(value) {
  if (value !== "company" && value !== "job") {
    throw new OperationError(
      "OPERATION_ROW_INVALID",
      "Operation scope is invalid.",
    );
  }
  return value;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} key
 */
function requiredString(row, key) {
  const value = row[key];
  if (typeof value !== "string") {
    throw new OperationError(
      "OPERATION_ROW_INVALID",
      "Operation row has an invalid string column.",
    );
  }
  return value;
}

/** @param {unknown} value */
function optionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new OperationError(
      "OPERATION_ROW_INVALID",
      "Operation row has an invalid optional string column.",
    );
  }
  return value;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} key
 */
function requiredNumber(row, key) {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new OperationError(
      "OPERATION_ROW_INVALID",
      "Operation row has an invalid integer column.",
    );
  }
  return value;
}

/** @param {unknown} value */
function optionalNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new OperationError(
      "OPERATION_ROW_INVALID",
      "Operation row has an invalid optional integer column.",
    );
  }
  return value;
}

/**
 * @typedef {{
 *   id: string,
 *   scopeType: 'company' | 'job',
 *   scopeId: string,
 *   operation: string,
 *   idempotencyKey: string,
 *   fingerprint: string,
 *   actorSubject: string,
 *   environment: string,
 *   retryOf: string | null,
 *   leaseToken: string,
 *   leaseExpiresAt: number,
 *   attemptCount: number,
 *   terminalHttpStatus: number | null,
 *   terminalCode: string | null,
 *   terminalBody: string | null,
 *   terminalCorrelationId: string | null,
 *   resultRevisionId: string | null,
 *   resultAssetId: string | null
 * }} OperationFields
 * @typedef {OperationFields & { state: 'pending' }} PendingOperation
 * @typedef {OperationFields & { state: 'succeeded' | 'failed' }} TerminalOperationRow
 * @typedef {PendingOperation | TerminalOperationRow} OperationRow
 * @typedef {{ state: 'succeeded' | 'failed', httpStatus: number, code: string, body: string, correlationId: string, resultRevisionId?: string, resultAssetId?: string }} TerminalOperation
 * @typedef {{ assetId: string, role: string, sha256: string, mimeType: string, byteLength: number, requireActiveDraftRef: boolean, createdAt: number }} AssetGuard
 * @typedef {{ kind: 'claimed', operation: PendingOperation } | { kind: 'terminal', operation: TerminalOperationRow, response: { httpStatus: number, code: string, bodyText: string, body: unknown, correlationId: string | null } } | { kind: 'in_progress', operation: PendingOperation, retryAfterSeconds: number }} OperationClaim
 * @typedef {{ kind: 'terminal', operation: TerminalOperationRow, response: { httpStatus: number, code: string, bodyText: string, body: unknown, correlationId: string | null } } | { kind: 'in_progress', operation: PendingOperation, retryAfterSeconds: number }} FinalizationOutcome
 */
