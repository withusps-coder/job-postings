import test from "node:test";
import assert from "node:assert/strict";
import { validateFixture } from "../scripts/validate-data.mjs";

test("Given the deterministic empty fixture, when validated, then it is accepted", () => {
  const result = validateFixture({ schemaVersion: 1, jobs: [] });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("Given a malformed fixture, when validated, then it identifies the JSON path", () => {
  const result = validateFixture({ schemaVersion: 1, jobs: ["not-empty"] });

  assert.equal(result.valid, false);
  assert.equal(result.errors[0]?.instancePath, "/jobs");
});
