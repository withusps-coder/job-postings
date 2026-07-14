import assert from "node:assert/strict";
import test from "node:test";

import {
  auditAblearnMigration,
  prepareAblearnMigration,
  readAblearnMigrationEvidence,
} from "../scripts/audit-ablearn-migration.mjs";
import {
  ABLEARN_MIGRATION_OPERATIONS,
  migrateAblearnToD1,
} from "../scripts/migrate-ablearn-to-d1.mjs";

test("Given the Ablearn legacy pages and migrated records, when audited, then no inventory loss is unexplained", async () => {
  const result = await auditAblearnMigration();

  assert.equal(result.valid, true, result.failures.join("; "));
  assert.deepEqual(
    result.rows.map(({ slug, status }) => ({ slug, status })),
    [{ slug: "ablearn-strategy", status: "open" }],
  );
});
test("Given reviewed non-authoritative fixture evidence, when preparing immutable migration input, then normalized content, asset bytes, and fallback provenance are preserved", async () => {
  const evidence = await readAblearnMigrationEvidence();
  const plan = prepareAblearnMigration(evidence);
  assert.equal("sourceJob" in evidence, false);
  assert.deepEqual(plan.normalizedJob, evidence.inventory.job);
  assert.equal(
    plan.snapshot.snapshotHash,
    "9af647761daf88d500c2d4583af2e2c70a008f180d213742d90ca9397a292538",
  );

  assert.deepEqual(
    plan.assets.map(({ role, source, media }) => ({
      role,
      source,
      mimeType: media.mimeType,
      byteLength: media.byteLength,
      sha256: media.sha256,
    })),
    [
      {
        role: "company-logo",
        source: "src/assets/jobs/ablearn/logo-ablearn.png",
        mimeType: "image/png",
        byteLength: 4495,
        sha256:
          "f144ab7ae00e1bfe25608d33aa24c3cdeec2392212596b8a67013bee66df0135",
      },
      {
        role: "company-map",
        source: "src/assets/jobs/ablearn/map-ablearn.jpg",
        mimeType: "image/jpeg",
        byteLength: 60315,
        sha256:
          "6003a0a65dccd29cc89ae8a299d6d04e791ca8c6f424a2801d1945f8c196122c",
      },
      {
        role: "company-document",
        source: "src/assets/jobs/ablearn/ablearn-company-profile.pdf",
        mimeType: "application/pdf",
        byteLength: 5946896,
        sha256:
          "3433b7e77fab8647e31fbfa2ede95860433e06f6d546132c9cca74e4e24d9190",
      },
    ],
  );
  assert.deepEqual(plan.draft.applicationJson, {
    kind: "email",
    value: "majesty89@starting.kr",
    provenance:
      "src/_data/site.json.contactEmail via createApplyMailto fallback; no official URL",
  });
  assert.match(
    plan.snapshot.snapshotJson,
    /\/media\/2a7269f7-a845-5b12-8640-0e1c04ade012/u,
  );
  assert.match(
    plan.snapshot.snapshotJson,
    /\/media\/2a7269f7-a845-5b13-8640-0e1c04ade013/u,
  );
  assert.doesNotMatch(
    plan.snapshot.snapshotJson,
    /src\/assets\/jobs\/ablearn/u,
  );
  assert.deepEqual(
    Object.values(ABLEARN_MIGRATION_OPERATIONS.assets).map(
      ({ operationId, idempotencyKey }) => ({ operationId, idempotencyKey }),
    ),
    [
      {
        operationId: "2a7269f7-a845-5b31-8640-0e1c04ade031",
        idempotencyKey: "2a7269f7-a845-5b32-8640-0e1c04ade032",
      },
      {
        operationId: "2a7269f7-a845-5b41-8640-0e1c04ade041",
        idempotencyKey: "2a7269f7-a845-5b42-8640-0e1c04ade042",
      },
      {
        operationId: "2a7269f7-a845-5b51-8640-0e1c04ade051",
        idempotencyKey: "2a7269f7-a845-5b52-8640-0e1c04ade052",
      },
    ],
  );
});
test("Given no bound D1 or R2 resources, when migration is called, then it fails before reading or writing a target", async () => {
  await assert.rejects(
    () => migrateAblearnToD1({ environment: "staging" }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ABLEARN_MIGRATION_BINDINGS_INVALID",
  );
});
