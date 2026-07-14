import { d1Statement, readDraftByJobId } from "../../../../_lib/db.js";
import { readBoundedBody } from "../../../../_lib/csrf.js";
import {
  adminError,
  adminJson,
  createCorrelationId,
} from "../../../../_lib/errors.js";
import {
  createAssetGuardStatements,
  createOperationFingerprint,
  claimOperation,
  finalizeOperation,
  OperationError,
} from "../../../../_lib/operations.js";
import {
  createImmutableMediaKey,
  MediaError,
  putImmutableMedia,
} from "../../../../_lib/media.js";
import {
  AssetMutationError,
  createAttachAssetStatements,
  createDetachAssetStatements,
  hasActiveDraftAssetRef,
  parseAssetDetach,
  parseAssetUpload,
  readNextDraftAssetOrdinal,
  readVerifiedAssetBySha256,
  verifyExistingAssetInR2,
} from "../../../../_lib/upload.js";

const uploadLeaseDurationMilliseconds = 60 * 1000;
const detachLeaseDurationMilliseconds = 30 * 1000;
const maximumDetachBytes = 16 * 1024;
const defaultAssetUploadDependencies = Object.freeze({
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
});

/**
 * Fully buffers and verifies an immutable asset before a create-only R2 write,
 * then atomically attaches it to a current draft. The admin middleware owns
 * Access, host, Origin, CSRF, and envelope guards; this handler additionally
 * binds the header and multipart idempotency keys to the durable operation.
 *
 * @param {EventContext<AssetBindings, "id", import("../../_middleware.js").AdminMiddlewareData>} context
 * @param {AssetUploadDependencies} [dependencies] Internal test dependencies; never request input.
 */
export async function onRequestPost(
  context,
  dependencies = defaultAssetUploadDependencies,
) {
  const correlationId = createCorrelationId();
  if (!context.data.admin || !context.data.adminSecurity)
    return adminError("ACCESS_INVALID", correlationId);
  if (!hasAssetBindings(context.env))
    return adminError("ADMIN_UNAVAILABLE", correlationId);

  try {
    const body = await readBoundedBody(context.request, 20 * 1024 * 1024);
    const upload = await parseAssetUpload(context.request, body);
    assertMatchingIdempotencyKey(context.request, upload.idempotencyKey);
    return await attachAsset(context, upload, correlationId, dependencies);
  } catch (error) {
    return assetErrorResponse(error, correlationId);
  }
}

/**
 * Detaches only the mutable draft reference. R2 bytes and immutable asset rows
 * remain retained indefinitely and no physical deletion API is invoked.
 *
 * @param {EventContext<AssetBindings, "id", import("../../_middleware.js").AdminMiddlewareData>} context
 */
export async function onRequestDelete(context) {
  const correlationId = createCorrelationId();
  if (!context.data.admin || !context.data.adminSecurity)
    return adminError("ACCESS_INVALID", correlationId);
  if (!hasAssetBindings(context.env))
    return adminError("ADMIN_UNAVAILABLE", correlationId);
  if (!isJsonContentType(context.request.headers.get("content-type"))) {
    return assetResponse(415, "UNSUPPORTED_MEDIA_TYPE", correlationId);
  }

  try {
    const body = await readBoundedBody(context.request, maximumDetachBytes);
    const detach = parseAssetDetach(body);
    assertMatchingIdempotencyKey(context.request, detach.idempotencyKey);
    return await detachAsset(context, detach, correlationId);
  } catch (error) {
    return assetErrorResponse(error, correlationId);
  }
}

/**
 * @param {EventContext<AssetBindings, "id", import("../../_middleware.js").AdminMiddlewareData>} context
 * @param {import("../../../../_lib/upload.js").ParsedAssetUpload} upload
 * @param {string} correlationId
 * @param {AssetUploadDependencies} dependencies
 */
async function attachAsset(context, upload, correlationId, dependencies) {
  const admin = context.data.admin;
  const security = context.data.adminSecurity;
  if (!admin || !security) throw new AssetMutationError("ACCESS_INVALID", 401);
  const jobId = requiredJobId(context.params.id);
  const operationId = dependencies.randomUUID();
  const candidateAssetId = dependencies.randomUUID();
  const now = dependencies.now();
  const existingAtClaim = await readVerifiedAssetBySha256(
    context.env.DB,
    upload.media.sha256,
  );
  const ordinal = await readNextDraftAssetOrdinal(
    context.env.DB,
    jobId,
    upload.role,
  );
  /** @type {FrozenUploadInput} */
  const frozenInput = {
    assetId: existingAtClaim?.id ?? candidateAssetId,
    r2Key:
      existingAtClaim?.r2Key ??
      createImmutableMediaKey(operationId, upload.media),
    reuseExisting: existingAtClaim !== null,
    role: upload.role,
    ordinal,
    expectedDraftVersion: upload.expectedDraftVersion,
    sha256: upload.media.sha256,
    byteLength: upload.media.byteLength,
    mimeType: upload.media.mimeType,
    ...(upload.retryOf ? { retryOf: upload.retryOf } : {}),
  };
  const fingerprint = await createOperationFingerprint({
    operation: "upload_asset",
    scopeType: "job",
    scopeId: jobId,
    actorSubject: admin.subject,
    environment: security.environment,
    input: {
      role: upload.role,
      expectedDraftVersion: upload.expectedDraftVersion,
      sha256: upload.media.sha256,
      byteLength: upload.media.byteLength,
      mimeType: upload.media.mimeType,
      ...(upload.retryOf ? { retryOf: upload.retryOf } : {}),
    },
  });

  const claim = await claimOperation(context.env.DB, {
    operationId,
    scopeType: "job",
    scopeId: jobId,
    operation: "upload_asset",
    idempotencyKey: upload.idempotencyKey,
    fingerprint,
    frozenInput,
    actorSubject: admin.subject,
    environment: security.environment,
    leaseToken: dependencies.randomUUID(),
    leaseDurationMs: uploadLeaseDurationMilliseconds,
    now,
    correlationId,
    ...(upload.retryOf ? { retryOf: upload.retryOf } : {}),
  });
  if (claim.kind !== "claimed")
    return claimedOperationResponse(claim, correlationId);
  const operation = requirePendingOperation(claim.operation);

  const persisted = await readFrozenUploadInput(context.env.DB, operation.id);
  const draft = await readDraftByJobId(context.env.DB, jobId);
  if (!draft) {
    return finalizeAssetFailure(
      context.env.DB,
      operation,
      "DRAFT_NOT_FOUND",
      404,
      correlationId,
      now,
    );
  }
  if (draft.draftVersion !== persisted.expectedDraftVersion) {
    return finalizeAssetFailure(
      context.env.DB,
      operation,
      "DRAFT_VERSION_INVALID",
      409,
      correlationId,
      now,
    );
  }

  /** @type {import("../../../../_lib/upload.js").ExistingMediaAsset} */
  let asset;
  let createAsset = false;
  try {
    if (persisted.reuseExisting) {
      const existing = await readVerifiedAssetBySha256(
        context.env.DB,
        persisted.sha256,
      );
      if (
        !existing ||
        existing.id !== persisted.assetId ||
        existing.r2Key !== persisted.r2Key
      ) {
        return finalizeAssetFailure(
          context.env.DB,
          operation,
          "ASSET_INTEGRITY_CONFLICT",
          409,
          correlationId,
          now,
        );
      }
      await verifyExistingAssetInR2(
        context.env.JOB_MEDIA,
        existing,
        upload.media,
      );
      asset = existing;
    } else {
      if (dependencies.beforeConditionalPut) {
        await dependencies.beforeConditionalPut();
      }
      const object = await putImmutableMedia(
        context.env.JOB_MEDIA,
        persisted.r2Key,
        upload.media,
      );
      asset = {
        id: persisted.assetId,
        r2Key: persisted.r2Key,
        sha256: upload.media.sha256,
        byteLength: upload.media.byteLength,
        detectedMime: upload.media.mimeType,
        etag: object.etag,
      };
      createAsset = true;
    }
  } catch (error) {
    if (error instanceof MediaError || error instanceof AssetMutationError) {
      return finalizeAssetFailure(
        context.env.DB,
        operation,
        error.code,
        error.status,
        correlationId,
        now,
      );
    }
    return operationUnavailable(correlationId);
  }

  const resourceStatements = [
    ...createAttachAssetStatements(context.env.DB, {
      jobId,
      expectedDraftVersion: persisted.expectedDraftVersion,
      asset,
      role: persisted.role,
      ordinal: persisted.ordinal,
      now,
      createAsset,
      operationId: operation.id,
    }),
    ...createAssetGuardStatements(context.env.DB, {
      operationId: operation.id,
      assets: [
        {
          assetId: asset.id,
          role: persisted.role,
          sha256: asset.sha256,
          mimeType: asset.detectedMime,
          byteLength: asset.byteLength,
          requireActiveDraftRef: true,
          createdAt: now,
        },
      ],
    }),
  ];
  const outcome = await finalizeOperation(context.env.DB, {
    operation,
    resourceStatements,
    terminal: terminalOperation(
      "succeeded",
      201,
      "ASSET_ATTACHED",
      correlationId,
      asset.id,
    ),
    now,
    failureForError: (code) =>
      terminalOperation("failed", 409, attachFailureCode(code), correlationId),
  });
  return finalizedOperationResponse(outcome, correlationId);
}

/**
 * Reloads only the immutable fields frozen by the durable claim. Server-generated
 * asset IDs, R2 keys, and ordinals are not part of the caller fingerprint, so
 * concurrent same-key requests always continue with the winning operation's
 * exact final identity.
 *
 * @param {D1Database} database
 * @param {string} operationId
 * @returns {Promise<FrozenUploadInput>}
 */
async function readFrozenUploadInput(database, operationId) {
  const row = await d1Statement(
    database,
    `SELECT frozen_input
     FROM mutation_operations
     WHERE id = ? AND operation = 'upload_asset'`,
    [operationId],
  ).first();
  const frozenText = row?.["frozen_input"];
  if (typeof frozenText !== "string") {
    throw new AssetMutationError("OPERATION_INPUT_UNAVAILABLE", 503);
  }

  /** @type {unknown} */
  let frozen;
  try {
    frozen = JSON.parse(frozenText);
  } catch {
    throw new AssetMutationError("OPERATION_INPUT_UNAVAILABLE", 503);
  }
  if (!isPlainObject(frozen)) {
    throw new AssetMutationError("OPERATION_INPUT_UNAVAILABLE", 503);
  }

  const reuseExisting = frozen["reuseExisting"];
  const assetId = frozen["assetId"];
  const r2Key = frozen["r2Key"];
  const role = frozen["role"];
  const ordinal = frozen["ordinal"];
  const expectedDraftVersion = frozen["expectedDraftVersion"];
  const sha256 = frozen["sha256"];
  const byteLength = frozen["byteLength"];
  const mimeType = frozen["mimeType"];
  const retryOf = frozen["retryOf"];

  if (
    typeof reuseExisting !== "boolean" ||
    typeof assetId !== "string" ||
    !isUuid(assetId) ||
    typeof r2Key !== "string" ||
    r2Key.length === 0 ||
    r2Key.length > 1024 ||
    typeof role !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(role) ||
    typeof ordinal !== "number" ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    typeof expectedDraftVersion !== "number" ||
    !Number.isSafeInteger(expectedDraftVersion) ||
    expectedDraftVersion < 1 ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(sha256) ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > 20 * 1024 * 1024 ||
    !isSupportedMediaType(mimeType) ||
    (retryOf !== undefined && (typeof retryOf !== "string" || !isUuid(retryOf)))
  ) {
    throw new AssetMutationError("OPERATION_INPUT_UNAVAILABLE", 503);
  }

  return {
    reuseExisting,
    assetId,
    r2Key,
    role,
    ordinal,
    expectedDraftVersion,
    sha256,
    byteLength,
    mimeType,
    ...(retryOf ? { retryOf } : {}),
  };
}

/**
 * @param {EventContext<AssetBindings, "id", import("../../_middleware.js").AdminMiddlewareData>} context
 * @param {import("../../../../_lib/upload.js").ParsedAssetDetach} detach
 * @param {string} correlationId
 */
async function detachAsset(context, detach, correlationId) {
  const admin = context.data.admin;
  const security = context.data.adminSecurity;
  if (!admin || !security) throw new AssetMutationError("ACCESS_INVALID", 401);
  const jobId = requiredJobId(context.params.id);
  const operationId = crypto.randomUUID();
  const now = Date.now();
  const frozenInput = {
    assetId: detach.assetId,
    role: detach.role,
    expectedDraftVersion: detach.expectedDraftVersion,
    ...(detach.retryOf ? { retryOf: detach.retryOf } : {}),
  };
  const fingerprint = await createOperationFingerprint({
    operation: "detach_asset",
    scopeType: "job",
    scopeId: jobId,
    actorSubject: admin.subject,
    environment: security.environment,
    input: frozenInput,
  });
  const claim = await claimOperation(context.env.DB, {
    operationId,
    scopeType: "job",
    scopeId: jobId,
    operation: "detach_asset",
    idempotencyKey: detach.idempotencyKey,
    fingerprint,
    frozenInput,
    actorSubject: admin.subject,
    environment: security.environment,
    leaseToken: crypto.randomUUID(),
    leaseDurationMs: detachLeaseDurationMilliseconds,
    now,
    correlationId,
    ...(detach.retryOf ? { retryOf: detach.retryOf } : {}),
  });
  if (claim.kind !== "claimed")
    return claimedOperationResponse(claim, correlationId);
  const operation = requirePendingOperation(claim.operation);

  const draft = await readDraftByJobId(context.env.DB, jobId);
  if (!draft) {
    return finalizeAssetFailure(
      context.env.DB,
      operation,
      "DRAFT_NOT_FOUND",
      404,
      correlationId,
      now,
    );
  }
  if (draft.draftVersion !== detach.expectedDraftVersion) {
    return finalizeAssetFailure(
      context.env.DB,
      operation,
      "DRAFT_VERSION_INVALID",
      409,
      correlationId,
      now,
    );
  }
  if (
    !(await hasActiveDraftAssetRef(context.env.DB, {
      jobId,
      assetId: detach.assetId,
      role: detach.role,
    }))
  ) {
    return finalizeAssetFailure(
      context.env.DB,
      operation,
      "DRAFT_ASSET_REF_NOT_FOUND",
      404,
      correlationId,
      now,
    );
  }

  const outcome = await finalizeOperation(context.env.DB, {
    operation,
    resourceStatements: createDetachAssetStatements(context.env.DB, {
      jobId,
      assetId: detach.assetId,
      role: detach.role,
      expectedDraftVersion: detach.expectedDraftVersion,
      now,
    }),
    terminal: terminalOperation(
      "succeeded",
      200,
      "ASSET_DETACHED",
      correlationId,
      detach.assetId,
    ),
    now,
    failureForError: (code) =>
      terminalOperation("failed", 409, detachFailureCode(code), correlationId),
  });
  return finalizedOperationResponse(outcome, correlationId);
}

/**
 * @param {import("../../../../_lib/operations.js").OperationRow} operation
 * @returns {import("../../../../_lib/operations.js").PendingOperation}
 */
function requirePendingOperation(operation) {
  if (operation.state !== "pending") {
    throw new AssetMutationError("OPERATION_STATE_INVALID", 503);
  }
  return /** @type {import("../../../../_lib/operations.js").PendingOperation} */ (
    operation
  );
}

/**
 * @param {D1Database} database
 * @param {import("../../../../_lib/operations.js").PendingOperation} operation
 * @param {string} code
 * @param {number} status
 * @param {string} correlationId
 * @param {number} now
 */
async function finalizeAssetFailure(
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
  return finalizedOperationResponse(outcome, correlationId);
}

/**
 * @param {import("../../../../_lib/operations.js").OperationClaim} claim
 * @param {string} correlationId
 */
function claimedOperationResponse(claim, correlationId) {
  if (claim.kind === "in_progress") {
    return operationInProgressResponse(claim.retryAfterSeconds, correlationId);
  }
  if (claim.kind === "terminal") return storedOperationResponse(claim.response);
  return operationUnavailable(correlationId);
}

/**
 * @param {import("../../../../_lib/operations.js").FinalizationOutcome} outcome
 * @param {string} correlationId
 */
function finalizedOperationResponse(outcome, correlationId) {
  if (outcome.kind === "in_progress") {
    return operationInProgressResponse(
      outcome.retryAfterSeconds,
      correlationId,
    );
  }
  return storedOperationResponse(outcome.response);
}

/**
 * @param {'succeeded' | 'failed'} state
 * @param {number} httpStatus
 * @param {string} code
 * @param {string} correlationId
 * @param {string=} resultAssetId
 */
function terminalOperation(
  state,
  httpStatus,
  code,
  correlationId,
  resultAssetId,
) {
  return {
    state,
    httpStatus,
    code,
    body: JSON.stringify(operationBody(code, correlationId)),
    correlationId,
    ...(resultAssetId ? { resultAssetId } : {}),
  };
}

/**
 * Replays the stored terminal JSON body byte-for-byte, preserving the original
 * durable status, correlation ID, and response order for a same-key retry.
 *
 * @param {{ httpStatus: number, bodyText: string }} response
 */
function storedOperationResponse(response) {
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
function operationInProgressResponse(retryAfterSeconds, correlationId) {
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

/** @param {string} code @param {string} correlationId */
function operationBody(code, correlationId) {
  return {
    code,
    message: operationMessage(code),
    correlationId,
  };
}

/** @param {string} code */
function operationMessage(code) {
  if (code === "ASSET_ATTACHED") return "The asset was attached to the draft.";
  if (code === "ASSET_DETACHED")
    return "The asset was detached from the draft.";
  if (code === "OPERATION_IN_PROGRESS")
    return "The requested operation is still in progress.";
  if (code === "DRAFT_NOT_FOUND" || code === "DRAFT_ASSET_REF_NOT_FOUND")
    return "The requested draft asset was not found.";
  if (code === "DRAFT_VERSION_INVALID")
    return "The draft changed before the operation could be completed.";
  if (
    code === "R2_KEY_INTEGRITY_CONFLICT" ||
    code === "ASSET_INTEGRITY_CONFLICT"
  )
    return "The immutable asset could not be reconciled safely.";
  if (code.startsWith("MEDIA_") || code === "UNSUPPORTED_MEDIA_TYPE")
    return "The uploaded file did not pass media validation.";
  return "The asset operation could not be completed.";
}

/** @param {string} code */
function attachFailureCode(code) {
  return code === "DRAFT_VERSION_INVALID" ? code : "ASSET_ATTACH_FAILED";
}

/** @param {string} code */
function detachFailureCode(code) {
  return code === "DRAFT_VERSION_INVALID" ? code : "ASSET_DETACH_FAILED";
}

/** @param {Request} request @param {string} bodyKey */
function assertMatchingIdempotencyKey(request, bodyKey) {
  const headerKey = request.headers.get("x-idempotency-key");
  if (headerKey !== bodyKey) {
    throw new AssetMutationError("IDEMPOTENCY_KEY_INVALID", 400);
  }
}

/** @param {unknown} value @returns {string} */
function requiredJobId(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  ) {
    throw new AssetMutationError("JOB_ID_INVALID", 404);
  }
  return value;
}

/** @param {string | null} contentType */
function isJsonContentType(contentType) {
  return Boolean(
    contentType &&
    contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json",
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} value */
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
}

/** @param {unknown} value @returns {value is 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf'} */
function isSupportedMediaType(value) {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "application/pdf"
  );
}

/** @param {unknown} error @param {string} correlationId */
function assetErrorResponse(error, correlationId) {
  if (error instanceof MediaError || error instanceof AssetMutationError) {
    return assetResponse(error.status, error.code, correlationId);
  }
  if (error instanceof OperationError) {
    return assetResponse(
      operationErrorStatus(error.code),
      error.code,
      correlationId,
    );
  }
  if (error instanceof RangeError)
    return assetResponse(413, "BODY_TOO_LARGE", correlationId);
  return adminError("ADMIN_UNAVAILABLE", correlationId);
}

/** @param {string} code */
function operationErrorStatus(code) {
  if (code === "IDEMPOTENCY_KEY_INVALID" || code === "OPERATION_INPUT_INVALID")
    return 400;
  if (code === "IDEMPOTENCY_KEY_REUSED") return 409;
  if (code === "RETRY_OF_INVALID") return 422;
  return 503;
}

/** @param {number} status @param {string} code @param {string} correlationId */
function assetResponse(status, code, correlationId) {
  return adminJson(operationBody(code, correlationId), status);
}

/** @param {string} correlationId */
function operationUnavailable(correlationId) {
  return assetResponse(503, "OPERATION_UNAVAILABLE", correlationId);
}

/** @param {AssetBindings} env */
function hasAssetBindings(env) {
  return Boolean(env.DB && env.JOB_MEDIA);
}

/**
 * @typedef {{ DB: D1Database, JOB_MEDIA: R2Bucket }} AssetBindings
 * @typedef {{
 *   reuseExisting: boolean,
 *   assetId: string,
 *   r2Key: string,
 *   role: string,
 *   ordinal: number,
 *   expectedDraftVersion: number,
 *   sha256: string,
 *   byteLength: number,
 *   mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf',
 *   retryOf?: string
 * }} FrozenUploadInput
 * @typedef {{
 *   now: () => number,
 *   randomUUID: () => string,
 *   beforeConditionalPut?: () => void | Promise<void>
 * }} AssetUploadDependencies
 */
