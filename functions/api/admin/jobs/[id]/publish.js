import { d1Statement, readDraftByJobId } from "../../../../_lib/db.js";
import { adminError } from "../../../../_lib/errors.js";
import {
  claimOperation,
  createOperationFingerprint,
  finalizeOperation,
  OperationError,
} from "../../../../_lib/operations.js";
import { finalizePublish } from "../../../../_lib/publish.js";
import {
  buildRevisionSnapshot,
  SnapshotError,
} from "../../../../_lib/snapshot.js";
import { readBoundedBody } from "../../../../_lib/csrf.js";

const mutationBodyMaximumBytes = 16 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** @type {Readonly<Record<string, readonly [number, string]>>} */
const publicationErrorDetails = Object.freeze({
  IDEMPOTENCY_KEY_INVALID: [400, "A matching idempotency key is required."],
  IDEMPOTENCY_KEY_REUSED: [
    409,
    "The idempotency key was already used for another request.",
  ],
  RETRY_OF_INVALID: [
    422,
    "Retry linkage does not match the current operation.",
  ],
  JOB_ID_INVALID: [400, "The job identifier is invalid."],
  JOB_NOT_FOUND: [404, "The job was not found."],
  NO_ACTIVE_REVISION: [409, "The job has no active revision."],
  ALREADY_CLOSED: [409, "The active job revision is already closed."],
  ACTIVE_SOURCE_NOT_FOUND: [409, "The active revision is no longer available."],
  ROLLBACK_SOURCE_NOT_FOUND: [
    404,
    "The rollback source revision was not found.",
  ],
  DRAFT_VALIDATION_FAILED: [
    422,
    "The draft cannot be published until validation succeeds.",
  ],
  CLOSE_INPUT_INVALID: [422, "The close request is invalid."],
  ROLLBACK_INPUT_INVALID: [422, "The rollback request is invalid."],
  PUBLISH_DRAFT_GUARD_FAILED: [
    409,
    "The draft changed before publication completed.",
  ],
  PUBLISH_GENERATION_GUARD_FAILED: [
    409,
    "The active revision changed before publication completed.",
  ],
  ACTIVE_GENERATION_INVALID: [
    409,
    "The active revision changed before completion.",
  ],
  ACTIVE_REVISION_ASSET_BINDING_MISMATCH: [
    409,
    "The active revision assets changed before completion.",
  ],
  DRAFT_VERSION_INVALID: [409, "The draft changed before completion."],
  PUBLISH_STATE_GUARD_FAILED: [
    409,
    "The publication source changed before publication completed.",
  ],
  CLOSE_GENERATION_GUARD_FAILED: [
    409,
    "The active revision changed before closing completed.",
  ],
  CLOSE_SOURCE_GUARD_FAILED: [
    409,
    "The active revision changed before closing completed.",
  ],
  ROLLBACK_GENERATION_GUARD_FAILED: [
    409,
    "The active revision changed before rollback completed.",
  ],
  ROLLBACK_SOURCE_GUARD_FAILED: [
    409,
    "The rollback source is no longer valid.",
  ],
  OPERATION_ASSET_INTEGRITY_GUARD_FAILED: [
    409,
    "A referenced asset is no longer valid.",
  ],
  OPERATION_DRAFT_ASSET_GUARD_FAILED: [
    409,
    "A referenced draft asset changed before publication completed.",
  ],
  OPERATION_LEASE_GUARD_FAILED: [
    409,
    "The operation lease changed before completion.",
  ],
  OPERATION_PUBLICATION_INCOMPLETE: [
    500,
    "The publication could not be completed.",
  ],
  OPERATION_FINALIZATION_FAILED: [
    500,
    "The publication could not be completed.",
  ],
  OPERATION_FINALIZATION_UNAVAILABLE: [
    503,
    "The publication outcome is temporarily unavailable.",
  ],
  OPERATION_CLAIM_UNAVAILABLE: [
    503,
    "The publication outcome is temporarily unavailable.",
  ],
  OPERATION_TERMINAL_UNAVAILABLE: [
    503,
    "The publication outcome is temporarily unavailable.",
  ],
  OPERATION_TERMINAL_INVALID: [
    503,
    "The publication outcome is temporarily unavailable.",
  ],
  PUBLICATION_PREPARATION_FAILED: [
    500,
    "The publication could not be prepared.",
  ],
  PUBLICATION_FROZEN_INPUT_INVALID: [
    500,
    "The publication outcome is unavailable.",
  ],
  INVALID_REQUEST: [400, "The request is invalid."],
  BODY_TOO_LARGE: [413, "The request body is too large."],
  UNSUPPORTED_MEDIA_TYPE: [415, "The request content type is not supported."],
  OPERATION_IN_PROGRESS: [202, "The operation is still in progress."],
});

/**
 * Publishes one validated draft as a new immutable active revision.
 *
 * @param {EventContext<AdminPublicationEnvironment, "id", AdminContextData>} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  return runPublicationMutation(context, {
    operation: "publish",
    expectedFields: ["expectedDraftVersion", "expectedGeneration"],
    parseIntent: parsePublishIntent,
    prepare: preparePublish,
    finalize: finalizePublishMutation,
    fingerprintInput: (intent) => intent,
  });
}

/**
 * Shared durable route flow for publication mutations. It freezes source state before
 * the first claim, then always reloads the persisted frozen input after a claim so an
 * expired-lease owner cannot switch to newer draft or active state.
 *
 * @param {EventContext<AdminPublicationEnvironment, "id", AdminContextData>} context
 * @param {PublicationRouteDefinition} definition
 * @returns {Promise<Response>}
 */
export async function runPublicationMutation(context, definition) {
  const correlationId = crypto.randomUUID();
  const jobId = context.params["id"];
  const database = context.env["DB"];
  const admin = context.data.admin;
  const security = context.data.adminSecurity;

  if (!isJobId(jobId)) return publicationError("JOB_ID_INVALID", correlationId);
  if (!isD1Database(database) || !admin || !security)
    return adminError("ADMIN_UNAVAILABLE", correlationId);

  const parsed = await parsePublicationRequest(
    context.request,
    definition,
    correlationId,
  );
  if (parsed instanceof Response) return parsed;

  let fingerprint;
  try {
    fingerprint = await createOperationFingerprint({
      operation: definition.operation,
      scopeType: "job",
      scopeId: jobId,
      actorSubject: admin.subject,
      environment: security.environment,
      input: definition.fingerprintInput(parsed.intent),
      retryOf: parsed.retryOf,
    });
  } catch {
    return publicationError("INVALID_REQUEST", correlationId);
  }

  const now = Date.now();
  let proposedFrozenInput;
  try {
    proposedFrozenInput = await definition.prepare(
      database,
      jobId,
      parsed.intent,
      parsed.retryOf,
      now,
    );
  } catch {
    proposedFrozenInput = failureFrozenInput(
      parsed.intent,
      parsed.retryOf,
      "PUBLICATION_PREPARATION_FAILED",
    );
  }

  let claim;
  try {
    claim = await claimOperation(database, {
      operationId: crypto.randomUUID(),
      scopeType: "job",
      scopeId: jobId,
      operation: definition.operation,
      idempotencyKey: parsed.idempotencyKey,
      fingerprint,
      frozenInput: proposedFrozenInput,
      actorSubject: admin.subject,
      environment: security.environment,
      leaseToken: crypto.randomUUID(),
      leaseDurationMs: 60_000,
      now,
      correlationId,
      retryOf: parsed.retryOf,
    });
  } catch (error) {
    return publicationError(operationErrorCode(error), correlationId);
  }

  if (claim.kind === "terminal") return storedTerminalResponse(claim.response);
  if (claim.kind === "in_progress")
    return inProgressResponse(claim.retryAfterSeconds, correlationId);

  /** @type {import("../../../../_lib/operations.js").PendingOperation} */
  const operation =
    /** @type {import("../../../../_lib/operations.js").PendingOperation} */ (
      claim.operation
    );
  let frozenInput;
  try {
    frozenInput = await readFrozenInput(database, claim.operation.id);
  } catch {
    try {
      const outcome = await finalizeOperation(database, {
        operation,
        resourceStatements: [],
        terminal: failureTerminal(
          "PUBLICATION_FROZEN_INPUT_INVALID",
          correlationId,
        ),
        now,
        failureForError: (code) => failureTerminal(code, correlationId),
      });
      return outcome.kind === "terminal"
        ? storedTerminalResponse(outcome.response)
        : inProgressResponse(outcome.retryAfterSeconds, correlationId);
    } catch {
      return publicationError(
        "OPERATION_FINALIZATION_UNAVAILABLE",
        correlationId,
      );
    }
  }

  let outcome;
  try {
    if (typeof frozenInput["failureCode"] === "string") {
      outcome = await finalizeOperation(database, {
        operation,
        resourceStatements: [],
        terminal: failureTerminal(frozenInput["failureCode"], correlationId),
        now,
        failureForError: (code) => failureTerminal(code, correlationId),
      });
    } else {
      outcome = await definition.finalize(
        database,
        operation,
        frozenInput,
        now,
        correlationId,
      );
    }
  } catch {
    try {
      outcome = await finalizeOperation(database, {
        operation,
        resourceStatements: [],
        terminal: failureTerminal(
          "PUBLICATION_FROZEN_INPUT_INVALID",
          correlationId,
        ),
        now,
        failureForError: (code) => failureTerminal(code, correlationId),
      });
    } catch {
      return publicationError(
        "OPERATION_FINALIZATION_UNAVAILABLE",
        correlationId,
      );
    }
  }

  if (outcome.kind === "terminal")
    return storedTerminalResponse(outcome.response);
  return inProgressResponse(outcome.retryAfterSeconds, correlationId);
}

/**
 * @param {D1Database} database
 * @param {string} jobId
 * @param {Record<string, unknown>} intent
 * @param {string | undefined} retryOf
 * @param {number} now
 * @returns {Promise<Record<string, unknown>>}
 */
async function preparePublish(database, jobId, intent, retryOf, now) {
  const draft = await readDraftByJobId(database, jobId);
  if (draft === null)
    return failureFrozenInput(intent, retryOf, "JOB_NOT_FOUND");

  try {
    const assets = await readActiveDraftAssets(database, jobId);
    const snapshot = await buildRevisionSnapshot({
      job: { id: draft.jobId, slug: draft.slug },
      draft: {
        draftJson: draft.draftJson,
        companySnapshotJson: draft.companySnapshotJson,
        applicationJson: draft.applicationJson,
      },
      assets,
    });
    const status = snapshot.snapshot["status"];
    if (status !== "open" && status !== "closed")
      throw new SnapshotError(
        "SNAPSHOT_STATUS_INVALID",
        "Invalid draft status.",
      );

    return {
      ...intent,
      ...(retryOf === undefined ? {} : { retryOf }),
      snapshotHash: snapshot.snapshotHash,
      assetManifestJson: snapshot.assetManifestJson,
      revision: {
        id: crypto.randomUUID(),
        jobId,
        revisionNumber: draft.activeGeneration + 1,
        baseGeneration: draft.activeGeneration,
        status,
        snapshotJson: snapshot.snapshotJson,
        snapshotHash: snapshot.snapshotHash,
        assetManifestJson: snapshot.assetManifestJson,
        parentRevisionId: draft.activeRevisionId,
        rollbackSourceRevisionId: null,
        createdAt: now,
        assets: snapshot.assets,
      },
    };
  } catch (error) {
    if (error instanceof SnapshotError) {
      return failureFrozenInput(intent, retryOf, "DRAFT_VALIDATION_FAILED");
    }
    throw error;
  }
}

/**
 * @param {D1Database} database
 * @param {import("../../../../_lib/operations.js").PendingOperation} operation
 * @param {Record<string, unknown>} frozenInput
 * @param {number} now
 * @param {string} correlationId
 */
async function finalizePublishMutation(
  database,
  operation,
  frozenInput,
  now,
  correlationId,
) {
  const intent = readPublishFrozenIntent(frozenInput);
  const revision = readFrozenRevision(frozenInput);
  return finalizePublish(database, {
    operation,
    jobId: operation.scopeId,
    expectedGeneration: intent.expectedGeneration,
    revision,
    assetGuards: revision.assets,
    terminal: successTerminal(
      "PUBLISHED",
      "The job was published.",
      revision,
      correlationId,
    ),
    now,
    failureForError: (code) => failureTerminal(code, correlationId),
  });
}

/**
 * @param {D1Database} database
 * @param {string} jobId
 * @returns {Promise<readonly DraftAsset[]>}
 */
async function readActiveDraftAssets(database, jobId) {
  const result = await d1Statement(
    database,
    `SELECT
       draft_refs.asset_id,
       draft_refs.role,
       draft_refs.ordinal,
       assets.sha256,
       assets.detected_mime,
       assets.byte_length
     FROM draft_asset_refs AS draft_refs
     JOIN assets ON assets.id = draft_refs.asset_id
     WHERE draft_refs.job_id = ?
       AND draft_refs.detached_at IS NULL
       AND assets.verification_state = 'verified'
     ORDER BY draft_refs.role ASC, draft_refs.ordinal ASC`,
    [jobId],
  ).all();
  return result.results.map(readDraftAsset);
}

/**
 * @param {Record<string, unknown>} row
 * @returns {DraftAsset}
 */
function readDraftAsset(row) {
  if (!isDraftAssetD1Row(row)) throw new TypeError("Invalid draft asset row.");
  return {
    assetId: requiredString(row["asset_id"]),
    role: requiredString(row["role"]),
    ordinal: requiredInteger(row["ordinal"], 0),
    mimeType: requiredMimeType(row["detected_mime"]),
    byteLength: requiredInteger(row["byte_length"], 1),
    sha256: requiredHash(row["sha256"]),
  };
}

/** @param {Record<string, unknown>} row @returns {row is DraftAssetD1Row} */
function isDraftAssetD1Row(row) {
  return (
    Object.hasOwn(row, "asset_id") &&
    Object.hasOwn(row, "role") &&
    Object.hasOwn(row, "ordinal") &&
    Object.hasOwn(row, "detected_mime") &&
    Object.hasOwn(row, "byte_length") &&
    Object.hasOwn(row, "sha256")
  );
}

/**
 * @param {PublicationRequestBody} body
 * @returns {PublishIntent}
 */
function parsePublishIntent(body) {
  return {
    expectedDraftVersion: requiredInteger(body["expectedDraftVersion"], 1),
    expectedGeneration: requiredInteger(body["expectedGeneration"], 0),
  };
}

/** @param {PublicationFrozenInput} frozenInput @returns {PublishIntent} */
function readPublishFrozenIntent(frozenInput) {
  return parsePublishIntent(frozenInput);
}

/**
 * @param {PublicationFrozenInput} frozenInput
 * @returns {FrozenRevision}
 */
export function readFrozenRevision(frozenInput) {
  if (!isRecord(frozenInput["revision"]))
    throw new TypeError("Missing frozen revision.");
  const revision = frozenInput["revision"];
  const status = revision["status"];
  if (status !== "open" && status !== "closed")
    throw new TypeError("Invalid frozen revision status.");
  if (!Array.isArray(revision["assets"]))
    throw new TypeError("Invalid frozen revision assets.");

  return {
    id: requiredString(revision["id"]),
    jobId: requiredString(revision["jobId"]),
    revisionNumber: requiredInteger(revision["revisionNumber"], 1),
    baseGeneration: requiredInteger(revision["baseGeneration"], 0),
    status,
    snapshotJson: requiredString(revision["snapshotJson"]),
    snapshotHash: requiredHash(revision["snapshotHash"]),
    assetManifestJson: requiredString(revision["assetManifestJson"]),
    parentRevisionId: optionalString(revision["parentRevisionId"]),
    rollbackSourceRevisionId: optionalString(
      revision["rollbackSourceRevisionId"],
    ),
    createdAt: requiredInteger(revision["createdAt"], 1),
    assets: revision["assets"].map(readFrozenAsset),
  };
}

/**
 * @param {unknown} value
 * @returns {FrozenAsset}
 */
function readFrozenAsset(value) {
  if (!isRecord(value)) throw new TypeError("Invalid frozen asset.");
  return {
    assetId: requiredString(value["assetId"]),
    role: requiredString(value["role"]),
    ordinal: requiredInteger(value["ordinal"], 0),
    mimeType: requiredMimeType(value["mimeType"]),
    byteLength: requiredInteger(value["byteLength"], 1),
    sha256: requiredHash(value["sha256"]),
  };
}

/**
 * @param {Request} request
 * @param {PublicationRouteDefinition} definition
 * @param {string} correlationId
 * @returns {Promise<ParsedPublicationRequest | Response>}
 */
async function parsePublicationRequest(request, definition, correlationId) {
  const contentType = request.headers.get("content-type");
  if (!contentType || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    return publicationError("UNSUPPORTED_MEDIA_TYPE", correlationId);
  }

  /** @type {unknown} */
  let body;
  try {
    const bytes = await readBoundedBody(request, mutationBodyMaximumBytes);
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return publicationError(
      error instanceof RangeError ? "BODY_TOO_LARGE" : "INVALID_REQUEST",
      correlationId,
    );
  }
  if (!isRecord(body))
    return publicationError("INVALID_REQUEST", correlationId);
  /** @type {PublicationRequestBody} */
  const requestBody = body;

  const allowed = new Set([
    "idempotencyKey",
    "retryOf",
    ...definition.expectedFields,
  ]);
  if (Object.keys(requestBody).some((key) => !allowed.has(key))) {
    return publicationError("INVALID_REQUEST", correlationId);
  }

  const headerKey = request.headers.get("x-idempotency-key");
  const bodyKey = requestBody["idempotencyKey"];
  if (
    typeof bodyKey !== "string" ||
    bodyKey !== headerKey ||
    !uuidPattern.test(bodyKey)
  ) {
    return publicationError("IDEMPOTENCY_KEY_INVALID", correlationId);
  }

  const retryOf = requestBody["retryOf"];
  if (
    retryOf !== undefined &&
    (typeof retryOf !== "string" || !uuidPattern.test(retryOf))
  ) {
    return publicationError("RETRY_OF_INVALID", correlationId);
  }

  try {
    return {
      idempotencyKey: bodyKey,
      ...(retryOf === undefined ? {} : { retryOf }),
      intent: definition.parseIntent(requestBody),
    };
  } catch {
    return publicationError("INVALID_REQUEST", correlationId);
  }
}

/**
 * @param {D1Database} database
 * @param {string} operationId
 * @returns {Promise<PublicationFrozenInput>}
 */
async function readFrozenInput(database, operationId) {
  const row = await d1Statement(
    database,
    "SELECT frozen_input FROM mutation_operations WHERE id = ?",
    [operationId],
  ).first();
  if (row === null || !isFrozenInputD1Row(row))
    throw new TypeError("Missing frozen operation input.");
  /** @type {unknown} */
  const parsedFrozenInput = JSON.parse(row["frozen_input"]);
  if (!isRecord(parsedFrozenInput))
    throw new TypeError("Invalid frozen operation input.");
  return parsedFrozenInput;
}

/** @param {Record<string, unknown>} row @returns {row is FrozenInputD1Row} */
function isFrozenInputD1Row(row) {
  return typeof row["frozen_input"] === "string";
}
/**
 * @param {Record<string, unknown>} intent
 * @param {string | undefined} retryOf
 * @param {string} failureCode
 * @returns {PublicationFrozenInput}
 */
export function failureFrozenInput(intent, retryOf, failureCode) {
  return {
    ...intent,
    ...(retryOf === undefined ? {} : { retryOf }),
    failureCode,
  };
}

/**
 * @param {string} code
 * @param {string} correlationId
 * @returns {import("../../../../_lib/operations.js").TerminalOperation}
 */
export function failureTerminal(code, correlationId) {
  const [httpStatus, message] = publicationErrorDetails[code] ?? [
    500,
    "The publication could not be completed.",
  ];
  /** @type {PublicationFailureResponseDto} */
  const response = { code, message, correlationId };
  return {
    state: "failed",
    httpStatus,
    code,
    body: JSON.stringify(response),
    correlationId,
  };
}

/**
 * @param {string} code
 * @param {string} message
 * @param {FrozenRevision} revision
 * @param {string} correlationId
 * @returns {import("../../../../_lib/operations.js").TerminalOperation}
 */
export function successTerminal(code, message, revision, correlationId) {
  /** @type {PublicationSuccessResponseDto} */
  const response = {
    code,
    message,
    correlationId,
    revision: publicationResult(revision),
  };
  return {
    state: "succeeded",
    httpStatus: 200,
    code,
    body: JSON.stringify(response),
    correlationId,
    resultRevisionId: revision.id,
  };
}

/** @param {FrozenRevision} revision @returns {PublicationResultDto} */
function publicationResult(revision) {
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    status: revision.status,
    activeGeneration: revision.baseGeneration + 1,
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function operationErrorCode(error) {
  if (error instanceof OperationError) return error.code;
  return "OPERATION_CLAIM_UNAVAILABLE";
}

/** @param {string} code @param {string} correlationId */
export function publicationError(code, correlationId) {
  const [status, message] = publicationErrorDetails[code] ?? [
    500,
    "The publication could not be completed.",
  ];
  /** @type {PublicationFailureResponseDto} */
  const response = { code, message, correlationId };
  return Response.json(response, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * @param {{ httpStatus: number, bodyText: string }} response
 * @returns {Response}
 */
function storedTerminalResponse(response) {
  return new Response(response.bodyText, {
    status: response.httpStatus,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

/** @param {number} retryAfterSeconds @param {string} correlationId */
function inProgressResponse(retryAfterSeconds, correlationId) {
  const [status, message] = publicationErrorDetails[
    "OPERATION_IN_PROGRESS"
  ] ?? [202, "The operation is still in progress."];
  /** @type {PublicationFailureResponseDto} */
  const response = {
    code: "OPERATION_IN_PROGRESS",
    message,
    correlationId,
  };
  return Response.json(response, {
    status,
    headers: {
      "cache-control": "no-store",
      "retry-after": String(retryAfterSeconds),
      "x-content-type-options": "nosniff",
    },
  });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is D1Database} */
function isD1Database(value) {
  return (
    isRecord(value) &&
    typeof value["prepare"] === "function" &&
    typeof value["batch"] === "function"
  );
}

/** @param {unknown} value @returns {string} */
export function requiredString(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384
  ) {
    throw new TypeError("Invalid string.");
  }
  return value;
}

/** @param {unknown} value @returns {string | null} */
function optionalString(value) {
  if (value === null) return null;
  return requiredString(value);
}

/** @param {unknown} value @param {number} minimum @returns {number} */
export function requiredInteger(value, minimum) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new TypeError("Invalid integer.");
  }
  return value;
}

/** @param {unknown} value @returns {string} */
function requiredHash(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new TypeError("Invalid hash.");
  return value;
}

/** @param {unknown} value @returns {"image/png" | "image/jpeg" | "image/webp" | "application/pdf"} */
function requiredMimeType(value) {
  if (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "application/pdf"
  ) {
    return value;
  }
  throw new TypeError("Invalid media type.");
}

/** @param {unknown} value @returns {value is string} */
function isJobId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/**
 * @typedef {{ DB?: unknown }} AdminPublicationEnvironment
 * @typedef {{ subject: string }} AdminContextDataAdmin
 * @typedef {{ environment: string }} AdminContextDataSecurity
 * @typedef {{ admin?: AdminContextDataAdmin, adminSecurity?: AdminContextDataSecurity }} AdminContextData
 * @typedef {Record<string, unknown> & { idempotencyKey?: unknown, retryOf?: unknown }} PublicationRequestBody
 * @typedef {Record<string, unknown> & { failureCode?: unknown, revision?: unknown, source?: unknown, sourceRevisionId?: unknown, sourceSnapshotHash?: unknown, sourceAssetManifestJson?: unknown, snapshotHash?: unknown, closedAt?: unknown }} PublicationFrozenInput
 * @typedef {{ expectedDraftVersion: number, expectedGeneration: number }} PublishIntent
 * @typedef {{ assetId: string, role: string, ordinal: number, mimeType: "image/png" | "image/jpeg" | "image/webp" | "application/pdf", byteLength: number, sha256: string }} DraftAsset
 * @typedef {DraftAsset} FrozenAsset
 * @typedef {{ id: string, jobId: string, revisionNumber: number, baseGeneration: number, status: "open" | "closed", snapshotJson: string, snapshotHash: string, assetManifestJson: string, parentRevisionId: string | null, rollbackSourceRevisionId: string | null, createdAt: number, assets: FrozenAsset[] }} FrozenRevision
 * @typedef {Record<string, unknown> & { asset_id: unknown, role: unknown, ordinal: unknown, detected_mime: unknown, byte_length: unknown, sha256: unknown }} DraftAssetD1Row
 * @typedef {Record<string, unknown> & { frozen_input: string }} FrozenInputD1Row
 * @typedef {{ code: string, message: string, correlationId: string }} PublicationFailureResponseDto
 * @typedef {{ id: string, revisionNumber: number, status: "open" | "closed", activeGeneration: number }} PublicationResultDto
 * @typedef {PublicationFailureResponseDto & { revision: PublicationResultDto }} PublicationSuccessResponseDto
 * @typedef {{ idempotencyKey: string, retryOf?: string, intent: Record<string, unknown> }} ParsedPublicationRequest
 * @typedef {{ operation: "publish" | "close" | "rollback", expectedFields: readonly string[], parseIntent: (body: PublicationRequestBody) => Record<string, unknown>, fingerprintInput: (intent: Record<string, unknown>) => Record<string, unknown>, prepare: (database: D1Database, jobId: string, intent: Record<string, unknown>, retryOf: string | undefined, now: number) => Promise<PublicationFrozenInput>, finalize: (database: D1Database, operation: import("../../../../_lib/operations.js").PendingOperation, frozenInput: PublicationFrozenInput, now: number, correlationId: string) => Promise<import("../../../../_lib/operations.js").FinalizationOutcome> }} PublicationRouteDefinition
 */
