import assert from "node:assert/strict";
import test from "node:test";

import { SqliteD1, asD1 } from "./helpers/sqlite-d1.mjs";

import {
  createLeaseGuardStatement,
  createOperationFingerprint,
  claimOperation,
} from "../functions/_lib/operations.js";
import {
  MediaError,
  putImmutableMedia,
  reconcileImmutableMedia,
  readDraftMediaAsset,
  serveStoredMedia,
  sha256Hex,
  verifyMediaBytes,
} from "../functions/_lib/media.js";
import { onRequest as publicMediaRequest } from "../functions/media/[assetId].js";
import { onRequestPost as uploadAsset } from "../functions/api/admin/jobs/[id]/assets.js";
import {
  createDetachAssetStatements,
  verifyExistingAssetInR2,
} from "../functions/_lib/upload.js";
const NOW = 1_700_000_000_000;
const administrator = {
  subject: "administrator@example.test",
  email: "administrator@example.test",
  issuedAt: 1_700_000_000,
  expiresAt: 1_700_003_600,
};
const adminSecurity = {
  environment: /** @type {"staging"} */ ("staging"),
  canonicalHost: "admin.example.test",
  canonicalOrigin: "https://admin.example.test",
  issuer: "https://access.example.test",
  audience: "careers-admin",
  administratorEmail: administrator.email,
  jwksUrl: new URL("https://access.example.test/cdn-cgi/access/certs"),
};

/**
 * In-memory R2 double with R2's conditional write semantics: an existing key
 * causes a create-only PUT to resolve null without replacing stored bytes.
 */
class MemoryR2 {
  constructor() {
    /** @type {Map<string, MemoryR2Object>} */
    this.objects = new Map();
    /** @type {{ key: string, onlyIf: string | null }[]} */
    this.putCalls = [];
    /** @type {string[]} */
    this.headCalls = [];
    /** @type {{ key: string, range: R2Range | null }[]} */
    this.getCalls = [];
    /** @type {string[]} */
    this.deleteCalls = [];
    this.nextEtag = 1;
    /** @type {((object: R2ObjectDescriptor) => R2ObjectDescriptor) | null} */
    this.headTransform = null;
  }

  /** @param {string} key @param {Uint8Array} bytes @param {R2Seed} seed */
  seed(key, bytes, seed) {
    this.objects.set(key, {
      bytes: new Uint8Array(bytes),
      key,
      etag: seed.etag,
      size: bytes.byteLength,
      httpMetadata: { contentType: seed.contentType },
      customMetadata: { ...seed.customMetadata },
    });
  }

  /** @param {string} key @param {Uint8Array} value @param {R2PutOptions} options */
  async put(key, value, options) {
    const onlyIf = options.onlyIf?.get("If-None-Match") ?? null;
    this.putCalls.push({ key, onlyIf });
    if (onlyIf === "*" && this.objects.has(key)) return null;

    const bytes = new Uint8Array(value);
    const object = {
      bytes,
      key,
      etag: `etag-${this.nextEtag}`,
      size: bytes.byteLength,
      httpMetadata: { contentType: options.httpMetadata?.contentType },
      customMetadata: { ...options.customMetadata },
    };
    this.nextEtag += 1;
    this.objects.set(key, object);
    return this.describe(object);
  }

  /** @param {string} key */
  async head(key) {
    this.headCalls.push(key);
    const object = this.objects.get(key);
    if (!object) return null;
    const described = this.describe(object);
    return this.headTransform ? this.headTransform(described) : described;
  }

  /** @param {string} key @param {R2GetOptions} [options] */
  async get(key, options = {}) {
    this.getCalls.push({ key, range: options.range ?? null });
    const object = this.objects.get(key);
    if (!object) return null;
    const range = options.range;
    const bytes = range
      ? object.bytes.slice(range.offset, range.offset + range.length)
      : object.bytes;
    return {
      ...this.describe(object),
      body: byteStream(bytes),
    };
  }

  /** @param {string | string[]} keys */
  async delete(keys) {
    const values = Array.isArray(keys) ? keys : [keys];
    this.deleteCalls.push(...values);
    for (const key of values) this.objects.delete(key);
  }

  /** @param {MemoryR2Object} object */
  describe(object) {
    return {
      key: object.key,
      etag: object.etag,
      size: object.size,
      httpMetadata: { ...object.httpMetadata },
      customMetadata: { ...object.customMetadata },
    };
  }
}

/** @param {Uint8Array} bytes */
function byteStream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** @param {number} sequence */
function uuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}
/** @param {number} sequence */
function uuidSequence(sequence) {
  let next = sequence;
  return () => uuid(next++);
}

/** @returns {{ promise: Promise<void>, resolve: () => void }} */
function deferred() {
  let resolve = () => {};
  const promise = new Promise((resume) => {
    resolve = () => resume(undefined);
  });
  return { promise, resolve };
}

/** @param {MemoryR2} bucket */
function asR2(bucket) {
  return /** @type {R2Bucket} */ (/** @type {unknown} */ (bucket));
}
/**
 * @param {SqliteD1} database
 * @param {MemoryR2} bucket
 * @param {string} assetId
 */
function publicMediaContext(database, bucket, assetId) {
  return /** @type {EventContext<{ DB: D1Database, JOB_MEDIA: R2Bucket }, "assetId", unknown>} */ (
    /** @type {unknown} */ ({
      request: new Request(`http://127.0.0.1/media/${assetId}`),
      params: { assetId },
      env: { DB: asD1(database), JOB_MEDIA: asR2(bucket) },
    })
  );
}
/**
 * Builds the post-middleware context used by the production asset route.
 *
 * @param {SqliteD1} database
 * @param {MemoryR2} bucket
 * @param {string} jobId
 * @param {Awaited<ReturnType<typeof verifiedPdf>>} media
 * @param {string} idempotencyKey
 */
function assetUploadContext(database, bucket, jobId, media, idempotencyKey) {
  const fileBytes = new ArrayBuffer(media.bytes.byteLength);
  new Uint8Array(fileBytes).set(media.bytes);
  const form = new FormData();
  form.set(
    "file",
    new Blob([fileBytes], { type: media.mimeType }),
    "attachment.pdf",
  );
  form.set("role", "attachment");
  form.set("expectedDraftVersion", "1");
  form.set("sha256", media.sha256);
  form.set("mimeType", media.mimeType);
  form.set("byteLength", String(media.byteLength));
  form.set("idempotencyKey", idempotencyKey);

  return /** @type {Parameters<typeof uploadAsset>[0]} */ (
    /** @type {unknown} */ ({
      request: new Request(
        `https://admin.example.test/api/admin/jobs/${jobId}/assets`,
        {
          method: "POST",
          headers: { "x-idempotency-key": idempotencyKey },
          body: form,
        },
      ),
      env: { DB: asD1(database), JOB_MEDIA: asR2(bucket) },
      params: { id: jobId },
      data: { admin: administrator, adminSecurity },
    })
  );
}

/** @param {string} document */
async function verifiedPdf(document = "") {
  const bytes = new TextEncoder().encode(
    `%PDF-1.7\n${document}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`,
  );
  return verifyMediaBytes(bytes, {
    mimeType: "application/pdf",
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  });
}

/** @param {string} document */
async function declaredPdf(document) {
  const bytes = new TextEncoder().encode(document);
  return {
    bytes,
    declared: {
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    },
  };
}

/** @param {string} assetId @param {string} r2Key @param {Awaited<ReturnType<typeof verifiedPdf>>} media @param {string} etag */
function storedAsset(assetId, r2Key, media, etag) {
  return {
    assetId,
    r2Key,
    sha256: media.sha256,
    byteLength: media.byteLength,
    detectedMime: media.mimeType,
    etag,
  };
}

/** @param {SqliteD1} database @param {string} jobId */
function insertJobDraft(database, jobId) {
  database.run(
    "INSERT INTO jobs (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [jobId, `job-${jobId}`, NOW, NOW],
  );
  database.run(
    `INSERT INTO job_drafts (
       job_id, company_id, version, draft_json, company_snapshot_json,
       application_json, created_at, updated_at
     ) VALUES (?, NULL, 1, '{}', '{}', '{}', ?, ?)`,
    [jobId, NOW, NOW],
  );
}

/** @param {SqliteD1} database @param {ReturnType<typeof storedAsset>} asset */
function insertAsset(database, asset) {
  database.run(
    `INSERT INTO assets (
       id, r2_key, sha256, byte_length, detected_mime, verification_state,
       verified_at, etag, created_at
     ) VALUES (?, ?, ?, ?, ?, 'verified', ?, ?, ?)`,
    [
      asset.assetId,
      asset.r2Key,
      asset.sha256,
      asset.byteLength,
      asset.detectedMime,
      NOW,
      asset.etag,
      NOW,
    ],
  );
}

/**
 * Creates an immutable retained revision through the migration's operation and
 * revision guards, making the public route query an actual D1 primary session.
 *
 * @param {SqliteD1} database
 * @param {{ jobId: string, asset: ReturnType<typeof storedAsset>, operationId: string, idempotencyKey: string }} input
 */
async function retainAsset(database, input) {
  const assetManifestJson = JSON.stringify([
    { assetId: input.asset.assetId, role: "attachment", ordinal: 0 },
  ]);
  const snapshotHash = "a".repeat(64);
  const frozenInput = {
    expectedDraftVersion: 1,
    expectedGeneration: 0,
    snapshotHash,
    assetManifestJson,
  };
  const fingerprint = await createOperationFingerprint({
    operation: "publish",
    scopeType: "job",
    scopeId: input.jobId,
    actorSubject: "admin@example.test",
    environment: "test",
    input: frozenInput,
  });
  const claim = await claimOperation(asD1(database), {
    operationId: input.operationId,
    scopeType: "job",
    scopeId: input.jobId,
    operation: "publish",
    idempotencyKey: input.idempotencyKey,
    fingerprint,
    frozenInput,
    actorSubject: "admin@example.test",
    environment: "test",
    leaseToken: "retained-lease",
    leaseDurationMs: 60_000,
    now: NOW,
    correlationId: "retained-claim",
  });
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") {
    throw new Error("Expected retained revision operation to be claimed.");
  }

  await createLeaseGuardStatement(asD1(database), claim.operation, NOW).run();
  database.run(
    `INSERT INTO job_revisions (
       id, job_id, revision_number, base_generation, status, snapshot_json,
       snapshot_hash, asset_manifest_json, parent_revision_id,
       rollback_source_revision_id, created_by_operation_id, created_at
     ) VALUES (?, ?, 1, 0, 'open', ?, ?, ?, NULL, NULL, ?, ?)`,
    [
      "retained-revision",
      input.jobId,
      JSON.stringify({ status: "open" }),
      snapshotHash,
      assetManifestJson,
      input.operationId,
      NOW,
    ],
  );
  database.run(
    `INSERT INTO revision_assets (revision_id, asset_id, role, ordinal)
     VALUES (?, ?, 'attachment', 0)`,
    ["retained-revision", input.asset.assetId],
  );
  database.run(
    `UPDATE jobs
     SET active_revision_id = ?, active_generation = 1, updated_at = ?
     WHERE id = ?`,
    ["retained-revision", NOW + 1, input.jobId],
  );
  database.run(
    `UPDATE mutation_operations
     SET state = 'succeeded', terminal_http_status = 201,
         terminal_code = 'PUBLISHED', terminal_body = ?,
         terminal_correlation_id = 'retained-terminal',
         result_revision_id = ?, terminal_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      JSON.stringify({ revisionId: "retained-revision" }),
      "retained-revision",
      NOW + 2,
      NOW + 2,
      input.operationId,
    ],
  );
}

/** @param {unknown} error */
function isR2IntegrityConflict(error) {
  return (
    error instanceof MediaError && error.code === "R2_KEY_INTEGRITY_CONFLICT"
  );
}

test("immutable R2 writes use create-only conditions and reconcile exact metadata", async () => {
  const media = await verifiedPdf("immutable");
  const bucket = new MemoryR2();
  const key = `uploads/${uuid(1)}/${media.sha256}.pdf`;

  const first = await putImmutableMedia(asR2(bucket), key, media);
  const storedBytes = new Uint8Array(bucket.objects.get(key)?.bytes ?? []);
  const second = await putImmutableMedia(asR2(bucket), key, media);

  assert.deepEqual(first, second);
  assert.deepEqual(bucket.putCalls, [
    { key, onlyIf: "*" },
    { key, onlyIf: "*" },
  ]);
  assert.deepEqual(bucket.objects.get(key)?.bytes, storedBytes);
  assert.equal(bucket.deleteCalls.length, 0);

  /** @type {readonly [string, (object: R2ObjectDescriptor) => R2ObjectDescriptor][]} */
  const metadataMismatches = [
    ["key", (object) => ({ ...object, key: "uploads/wrong-key.pdf" })],
    ["size", (object) => ({ ...object, size: object.size + 1 })],
    [
      "content type",
      (object) => ({
        ...object,
        httpMetadata: { ...object.httpMetadata, contentType: "image/png" },
      }),
    ],
    [
      "digest",
      (object) => ({
        ...object,
        customMetadata: { ...object.customMetadata, sha256: "0".repeat(64) },
      }),
    ],
    [
      "length",
      (object) => ({
        ...object,
        customMetadata: { ...object.customMetadata, byteLength: "999" },
      }),
    ],
    [
      "detected MIME",
      (object) => ({
        ...object,
        customMetadata: { ...object.customMetadata, detectedMime: "image/png" },
      }),
    ],
  ];
  for (const [field, transform] of metadataMismatches) {
    bucket.headTransform = transform;
    await assert.rejects(
      () => reconcileImmutableMedia(asR2(bucket), key, media),
      isR2IntegrityConflict,
      `Expected ${field} mismatch to reject reconciliation.`,
    );
  }
  bucket.headTransform = null;
  assert.deepEqual(
    await reconcileImmutableMedia(asR2(bucket), key, media),
    first,
  );

  await assert.rejects(
    () =>
      verifyExistingAssetInR2(
        asR2(bucket),
        {
          id: uuid(2),
          r2Key: "uploads/mismatched-key.pdf",
          sha256: media.sha256,
          byteLength: media.byteLength,
          detectedMime: media.mimeType,
          etag: first.etag,
        },
        media,
      ),
    isR2IntegrityConflict,
  );
  assert.deepEqual(bucket.objects.get(key)?.bytes, storedBytes);
});
test("expired upload lease takeover preserves the exact immutable result against stale owner finalization", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());

  const bucket = new MemoryR2();
  const jobId = uuid(20);
  const idempotencyKey = uuid(21);
  const media = await verifiedPdf("lease-takeover");
  const bytesBeforeRace = new Uint8Array(media.bytes);
  const ownerAPaused = deferred();
  const releaseOwnerA = deferred();
  let now = NOW;
  insertJobDraft(database, jobId);
  const ownerA = uploadAsset(
    assetUploadContext(database, bucket, jobId, media, idempotencyKey),
    {
      now: () => now,
      randomUUID: uuidSequence(31),
      beforeConditionalPut: async () => {
        ownerAPaused.resolve();
        await releaseOwnerA.promise;
      },
    },
  );

  await ownerAPaused.promise;

  const r2Key = `uploads/${uuid(31)}/${media.sha256}.${media.extension}`;
  assert.deepEqual(
    database.one(
      `SELECT id, state, lease_token AS leaseToken,
              lease_expires_at AS leaseExpiresAt, attempt_count AS attemptCount,
              frozen_input AS frozenInput
       FROM mutation_operations`,
    ),
    {
      id: uuid(31),
      state: "pending",
      leaseToken: uuid(33),
      leaseExpiresAt: NOW + 60_000,
      attemptCount: 1,
      frozenInput: JSON.stringify({
        assetId: uuid(32),
        byteLength: media.byteLength,
        expectedDraftVersion: 1,
        mimeType: media.mimeType,
        ordinal: 0,
        r2Key,
        reuseExisting: false,
        role: "attachment",
        sha256: media.sha256,
      }),
    },
  );

  now = NOW + 60_001;
  const ownerBResponse = await uploadAsset(
    assetUploadContext(database, bucket, jobId, media, idempotencyKey),
    {
      now: () => now,
      randomUUID: uuidSequence(41),
      beforeConditionalPut: () => {},
    },
  );
  const ownerBText = await ownerBResponse.text();
  assert.equal(ownerBResponse.status, 201);

  releaseOwnerA.resolve();
  const ownerAResponse = await ownerA;
  assert.equal(ownerAResponse.status, 201);
  assert.equal(await ownerAResponse.text(), ownerBText);

  assert.deepEqual(bucket.putCalls, [
    { key: r2Key, onlyIf: "*" },
    { key: r2Key, onlyIf: "*" },
  ]);
  assert.deepEqual(bucket.headCalls, [r2Key, r2Key]);
  assert.equal(bucket.objects.size, 1);
  assert.equal(bucket.deleteCalls.length, 0);

  const object = bucket.objects.get(r2Key);
  assert.ok(object);
  assert.deepEqual(object.bytes, bytesBeforeRace);
  assert.equal(object.size, media.byteLength);
  assert.deepEqual(object.httpMetadata, { contentType: media.mimeType });
  assert.deepEqual(object.customMetadata, {
    sha256: media.sha256,
    byteLength: String(media.byteLength),
    detectedMime: media.mimeType,
  });

  assert.deepEqual(
    database.one(
      `SELECT id, r2_key AS r2Key, sha256, byte_length AS byteLength,
              detected_mime AS detectedMime, etag,
              created_by_operation_id AS createdByOperationId
       FROM assets`,
    ),
    {
      id: uuid(32),
      r2Key,
      sha256: media.sha256,
      byteLength: media.byteLength,
      detectedMime: media.mimeType,
      etag: "etag-1",
      createdByOperationId: uuid(31),
    },
  );
  assert.deepEqual(
    database.one(
      `SELECT job_id AS jobId, asset_id AS assetId, role, ordinal,
              detached_at AS detachedAt
       FROM draft_asset_refs`,
    ),
    {
      jobId,
      assetId: uuid(32),
      role: "attachment",
      ordinal: 0,
      detachedAt: null,
    },
  );
  assert.deepEqual(
    database.one(
      `SELECT state, lease_token AS leaseToken,
              lease_expires_at AS leaseExpiresAt, attempt_count AS attemptCount,
              terminal_http_status AS terminalHttpStatus,
              terminal_code AS terminalCode, result_asset_id AS resultAssetId
       FROM mutation_operations`,
    ),
    {
      state: "succeeded",
      leaseToken: uuid(43),
      leaseExpiresAt: NOW + 120_001,
      attemptCount: 2,
      terminalHttpStatus: 201,
      terminalCode: "ASSET_ATTACHED",
      resultAssetId: uuid(32),
    },
  );
  assert.deepEqual(database.one("SELECT COUNT(*) AS count FROM assets"), {
    count: 1,
  });
  assert.deepEqual(
    database.one("SELECT COUNT(*) AS count FROM draft_asset_refs"),
    { count: 1 },
  );
  assert.deepEqual(
    database.one("SELECT COUNT(*) AS count FROM mutation_operations"),
    { count: 1 },
  );
});
test("expired upload lease takeover terminalizes R2 mismatches without asset finalization or public media", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());

  const bucket = new MemoryR2();
  const jobId = uuid(50);
  const idempotencyKey = uuid(51);
  const media = await verifiedPdf("lease-takeover-mismatch");
  const bytesBeforeRace = new Uint8Array(media.bytes);
  const ownerAPaused = deferred();
  const releaseOwnerA = deferred();
  let now = NOW;
  insertJobDraft(database, jobId);
  const ownerA = uploadAsset(
    assetUploadContext(database, bucket, jobId, media, idempotencyKey),
    {
      now: () => now,
      randomUUID: uuidSequence(61),
      beforeConditionalPut: async () => {
        ownerAPaused.resolve();
        await releaseOwnerA.promise;
      },
    },
  );

  await ownerAPaused.promise;

  const r2Key = `uploads/${uuid(61)}/${media.sha256}.${media.extension}`;
  bucket.seed(r2Key, bytesBeforeRace, {
    etag: "foreign-etag",
    contentType: media.mimeType,
    customMetadata: {
      sha256: "0".repeat(64),
      byteLength: String(media.byteLength),
      detectedMime: media.mimeType,
    },
  });

  now = NOW + 60_001;
  const ownerBResponse = await uploadAsset(
    assetUploadContext(database, bucket, jobId, media, idempotencyKey),
    {
      now: () => now,
      randomUUID: uuidSequence(71),
      beforeConditionalPut: () => {},
    },
  );
  const ownerBText = await ownerBResponse.text();
  assert.equal(ownerBResponse.status, 409);
  assert.equal(JSON.parse(ownerBText).code, "R2_KEY_INTEGRITY_CONFLICT");

  releaseOwnerA.resolve();
  const ownerAResponse = await ownerA;
  assert.equal(ownerAResponse.status, 409);
  assert.equal(await ownerAResponse.text(), ownerBText);

  assert.deepEqual(bucket.putCalls, [
    { key: r2Key, onlyIf: "*" },
    { key: r2Key, onlyIf: "*" },
  ]);
  assert.deepEqual(bucket.headCalls, [r2Key, r2Key]);
  assert.equal(bucket.objects.size, 1);
  assert.equal(bucket.deleteCalls.length, 0);

  const object = bucket.objects.get(r2Key);
  assert.ok(object);
  assert.deepEqual(object.bytes, bytesBeforeRace);
  assert.equal(object.size, media.byteLength);
  assert.deepEqual(object.httpMetadata, { contentType: media.mimeType });
  assert.deepEqual(object.customMetadata, {
    sha256: "0".repeat(64),
    byteLength: String(media.byteLength),
    detectedMime: media.mimeType,
  });

  assert.deepEqual(database.one("SELECT COUNT(*) AS count FROM assets"), {
    count: 0,
  });
  assert.deepEqual(
    database.one("SELECT COUNT(*) AS count FROM draft_asset_refs"),
    { count: 0 },
  );
  assert.deepEqual(
    database.one("SELECT COUNT(*) AS count FROM operation_asset_guards"),
    { count: 0 },
  );
  assert.deepEqual(
    database.one(
      `SELECT state, lease_token AS leaseToken,
              lease_expires_at AS leaseExpiresAt, attempt_count AS attemptCount,
              terminal_http_status AS terminalHttpStatus,
              terminal_code AS terminalCode, result_asset_id AS resultAssetId
       FROM mutation_operations`,
    ),
    {
      state: "failed",
      leaseToken: uuid(73),
      leaseExpiresAt: NOW + 120_001,
      attemptCount: 2,
      terminalHttpStatus: 409,
      terminalCode: "R2_KEY_INTEGRITY_CONFLICT",
      resultAssetId: null,
    },
  );

  const headsBeforePublicRequest = bucket.headCalls.length;
  const publicResponse = await publicMediaRequest(
    publicMediaContext(database, bucket, uuid(62)),
  );
  assert.equal(publicResponse.status, 404);
  assert.equal(await publicResponse.text(), "");
  assert.equal(bucket.headCalls.length, headsBeforePublicRequest);
  assert.equal(bucket.getCalls.length, 0);
});

test("PDF verification rejects incomplete payloads and serves forced attachments", async () => {
  const missingEof = await declaredPdf("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
  const trailingPayload = await declaredPdf(
    "%PDF-1.7\n%%EOF\n<script>payload</script>",
  );

  for (const input of [missingEof, trailingPayload]) {
    await assert.rejects(
      () => verifyMediaBytes(input.bytes, input.declared),
      /** @param {unknown} error */ (error) =>
        error instanceof MediaError && error.code === "UNSUPPORTED_MEDIA_TYPE",
    );
  }

  const media = await verifiedPdf("attachment");
  const asset = storedAsset(
    'manual"\r\nX',
    "uploads/pdf-attachment.pdf",
    media,
    "pdf-etag",
  );
  const bucket = new MemoryR2();
  bucket.seed(asset.r2Key, media.bytes, {
    etag: asset.etag,
    contentType: asset.detectedMime,
    customMetadata: {
      sha256: asset.sha256,
      byteLength: String(asset.byteLength),
      detectedMime: asset.detectedMime,
    },
  });

  const response = await serveStoredMedia({
    request: new Request("https://example.test/media/manual"),
    bucket: asR2(bucket),
    asset,
    cacheControl: "public, max-age=31536000, immutable",
  });

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="manual___X.pdf"',
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("content-security-policy"),
    "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
  );
});

test("stored media supports bounded ranges and HEAD without fetching a body", async () => {
  const media = await verifiedPdf("range payload");
  const asset = storedAsset(uuid(3), "uploads/ranges.pdf", media, "range-etag");
  const bucket = new MemoryR2();
  bucket.seed(asset.r2Key, media.bytes, {
    etag: asset.etag,
    contentType: asset.detectedMime,
    customMetadata: {
      sha256: asset.sha256,
      byteLength: String(asset.byteLength),
      detectedMime: asset.detectedMime,
    },
  });

  const headResponse = await serveStoredMedia({
    request: new Request("https://example.test/media/range", {
      method: "HEAD",
      headers: { range: "bytes=2-6" },
    }),
    bucket: asR2(bucket),
    asset,
    cacheControl: "immutable",
  });
  assert.equal(headResponse.status, 206);
  assert.equal(
    headResponse.headers.get("content-range"),
    `bytes 2-6/${media.byteLength}`,
  );
  assert.equal(headResponse.headers.get("content-length"), "5");
  assert.equal(bucket.getCalls.length, 0);

  const getResponse = await serveStoredMedia({
    request: new Request("https://example.test/media/range", {
      headers: { range: "bytes=-4" },
    }),
    bucket: asR2(bucket),
    asset,
    cacheControl: "immutable",
  });
  assert.equal(getResponse.status, 206);
  assert.equal(
    getResponse.headers.get("content-range"),
    `bytes ${media.byteLength - 4}-${media.byteLength - 1}/${media.byteLength}`,
  );
  assert.deepEqual(
    new Uint8Array(await getResponse.arrayBuffer()),
    media.bytes.slice(-4),
  );
  assert.deepEqual(bucket.getCalls, [
    {
      key: asset.r2Key,
      range: { offset: media.byteLength - 4, length: 4 },
    },
  ]);

  const invalidRange = await serveStoredMedia({
    request: new Request("https://example.test/media/range", {
      headers: { range: `bytes=${media.byteLength}-` },
    }),
    bucket: asR2(bucket),
    asset,
    cacheControl: "immutable",
  });
  assert.equal(invalidRange.status, 416);
  assert.equal(
    invalidRange.headers.get("content-range"),
    `bytes */${media.byteLength}`,
  );
  assert.equal(bucket.getCalls.length, 1);
});

test("public media requires a retained revision and never falls back to draft or orphan R2 objects", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());
  const bucket = new MemoryR2();
  const jobId = "public-job";
  insertJobDraft(database, jobId);

  const retainedMedia = await verifiedPdf("retained");
  const retained = storedAsset(
    uuid(10),
    "uploads/retained.pdf",
    retainedMedia,
    "retained-etag",
  );
  insertAsset(database, retained);
  await retainAsset(database, {
    jobId,
    asset: retained,
    operationId: uuid(11),
    idempotencyKey: uuid(12),
  });
  bucket.seed(retained.r2Key, retainedMedia.bytes, {
    etag: retained.etag,
    contentType: retained.detectedMime,
    customMetadata: {
      sha256: retained.sha256,
      byteLength: String(retained.byteLength),
      detectedMime: retained.detectedMime,
    },
  });

  const retainedResponse = await publicMediaRequest(
    publicMediaContext(database, bucket, retained.assetId),
  );
  assert.equal(retainedResponse.status, 200);
  assert.equal(
    retainedResponse.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(database.sessions.at(-1), "first-primary");

  const draftMedia = await verifiedPdf("draft-only");
  const draft = storedAsset(
    uuid(13),
    "uploads/draft.pdf",
    draftMedia,
    "draft-etag",
  );
  insertAsset(database, draft);
  database.run(
    `INSERT INTO draft_asset_refs (
       job_id, asset_id, role, ordinal, attached_at, detached_at
     ) VALUES (?, ?, 'attachment', 1, ?, NULL)`,
    [jobId, draft.assetId, NOW],
  );
  bucket.seed(draft.r2Key, draftMedia.bytes, {
    etag: draft.etag,
    contentType: draft.detectedMime,
    customMetadata: {
      sha256: draft.sha256,
      byteLength: String(draft.byteLength),
      detectedMime: draft.detectedMime,
    },
  });
  const draftHeadCalls = bucket.headCalls.length;
  const draftResponse = await publicMediaRequest(
    publicMediaContext(database, bucket, draft.assetId),
  );
  assert.equal(draftResponse.status, 404);
  assert.equal(draftResponse.headers.get("cache-control"), "no-store");
  assert.equal(bucket.headCalls.length, draftHeadCalls);

  const orphanMedia = await verifiedPdf("orphan");
  const orphan = storedAsset(
    uuid(14),
    "uploads/orphan.pdf",
    orphanMedia,
    "orphan-etag",
  );
  insertAsset(database, orphan);
  bucket.seed(orphan.r2Key, orphanMedia.bytes, {
    etag: orphan.etag,
    contentType: orphan.detectedMime,
    customMetadata: {
      sha256: orphan.sha256,
      byteLength: String(orphan.byteLength),
      detectedMime: orphan.detectedMime,
    },
  });
  const orphanResponse = await publicMediaRequest(
    publicMediaContext(database, bucket, orphan.assetId),
  );
  assert.equal(orphanResponse.status, 404);
  assert.equal(bucket.headCalls.length, draftHeadCalls);

  assert.deepEqual(
    await readDraftMediaAsset(asD1(database), draft.assetId),
    draft,
  );
  assert.equal(await readDraftMediaAsset(asD1(database), orphan.assetId), null);
});

test("detaching retains immutable assets and only marks the draft reference detached", async (context) => {
  const database = new SqliteD1();
  context.after(() => database.close());
  const jobId = "detach-job";
  insertJobDraft(database, jobId);
  const media = await verifiedPdf("detached");
  const asset = storedAsset(
    uuid(20),
    "uploads/detached.pdf",
    media,
    "detached-etag",
  );
  insertAsset(database, asset);
  database.run(
    `INSERT INTO draft_asset_refs (
       job_id, asset_id, role, ordinal, attached_at, detached_at
     ) VALUES (?, ?, 'attachment', 0, ?, NULL)`,
    [jobId, asset.assetId, NOW],
  );

  await asD1(database).batch(
    createDetachAssetStatements(asD1(database), {
      jobId,
      assetId: asset.assetId,
      role: "attachment",
      expectedDraftVersion: 1,
      now: NOW + 1,
    }),
  );

  assert.deepEqual(
    database.one(
      "SELECT id, r2_key, sha256, byte_length, etag FROM assets WHERE id = ?",
      [asset.assetId],
    ),
    {
      id: asset.assetId,
      r2_key: asset.r2Key,
      sha256: asset.sha256,
      byte_length: asset.byteLength,
      etag: asset.etag,
    },
  );
  assert.deepEqual(
    database.one(
      "SELECT attached_at, detached_at FROM draft_asset_refs WHERE job_id = ? AND asset_id = ?",
      [jobId, asset.assetId],
    ),
    { attached_at: NOW, detached_at: NOW + 1 },
  );
  assert.throws(
    () => database.run("DELETE FROM assets WHERE id = ?", [asset.assetId]),
    /NO_PHYSICAL_DELETE/,
  );
});

/**
 * @typedef {{ etag: string, contentType: string, customMetadata: Record<string, string> }} R2Seed
 * @typedef {{ onlyIf: Headers, httpMetadata: { contentType: string }, customMetadata: Record<string, string> }} R2PutOptions
 * @typedef {{ range?: R2Range }} R2GetOptions
 * @typedef {{ offset: number, length: number }} R2Range
 * @typedef {{ key: string, etag: string, size: number, httpMetadata: { contentType: string | undefined }, customMetadata: Record<string, string> }} R2ObjectDescriptor
 * @typedef {{ bytes: Uint8Array, key: string, etag: string, size: number, httpMetadata: { contentType: string | undefined }, customMetadata: Record<string, string> }} MemoryR2Object
 */
