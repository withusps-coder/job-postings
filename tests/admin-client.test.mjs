import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/assets/scripts/job-admin.js", import.meta.url),
  "utf8",
);
const transportStart = source.indexOf(
  "class AdminRequestError extends Error {",
);
const transportEnd = source.indexOf(
  "/** @param {string} path @param {string} key @returns {Promise<unknown[]>} */",
  transportStart,
);

if (transportStart < 0 || transportEnd < 0) {
  throw new Error("Could not locate the admin mutation transport test seam.");
}

const transportSource = source.slice(transportStart, transportEnd);

/** @param {() => string} [randomUUID] */
function loadTransport(randomUUID = () => "generated-key") {
  return new Function(
    "isRecord",
    "readString",
    "operationIdFrom",
    "crypto",
    `${transportSource}
return {
  AdminRequestError,
  MutationBusyError,
  MutationResponseError,
  MutationUncertaintyError,
  clearError,
  createJsonMutationRequest,
  createMutationCoordinator,
  createMutationRequest,
  createMutationTransport,
  hasCoordinatorRecovery,
  mutationCoordinator,
  operationSuccess,
  selectedCompanyVersion,
  showClientError,
};`,
  )(
    /** @param {unknown} value */
    (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value),
    /** @param {unknown} value */
    (value) => (typeof value === "string" ? value : ""),
    /** @param {unknown} value */
    (value) =>
      value !== null &&
      typeof value === "object" &&
      "operationId" in value &&
      typeof value.operationId === "string"
        ? value.operationId
        : "",
    { randomUUID },
  );
}

/** @param {number} status @param {unknown} body @param {string | undefined} [retryAfter] */
function responseResult(status, body, retryAfter = undefined) {
  const headers = new Headers();
  if (retryAfter) headers.set("retry-after", retryAfter);
  return {
    response: new Response(JSON.stringify(body), { status, headers }),
    body,
    parsed: true,
  };
}

test("202 polls the exact JSON request and idempotency key until its terminal replay", async () => {
  let createdKeys = 0;
  const {
    createJsonMutationRequest,
    createMutationTransport,
    operationSuccess,
  } = loadTransport(() => {
    createdKeys += 1;
    return "generated-key";
  });
  const mutation = createJsonMutationRequest(
    "/api/admin/jobs/job-1/publish",
    "POST",
    { expectedGeneration: 7 },
    undefined,
  );
  /** @type {unknown[]} */
  const requests = [];
  /** @type {number[]} */
  const delays = [];
  const transport = createMutationTransport({
    request: async (/** @type {any} */ request) => {
      requests.push(request);
      return requests.length === 1
        ? responseResult(202, { code: "OPERATION_IN_PROGRESS" }, "1")
        : responseResult(200, { code: "PUBLISHED", revision: { id: "rev-1" } });
    },
    sleep: async (/** @type {number} */ delay) => delays.push(delay),
    now: () => 0,
  });

  const result = await transport(
    mutation,
    operationSuccess("PUBLISHED", "revision"),
  );

  assert.deepEqual(result, { code: "PUBLISHED", revision: { id: "rev-1" } });
  assert.deepEqual(delays, [1_000]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request === mutation));
  assert.equal(mutation.method, "POST");
  assert.equal(mutation.path, "/api/admin/jobs/job-1/publish");
  assert.equal(mutation.idempotencyKey, "generated-key");
  assert.equal(
    mutation.body,
    '{"expectedGeneration":7,"idempotencyKey":"generated-key"}',
  );
  assert.equal(createdKeys, 1);
});

test("network and parse ambiguity replay the same frozen request instead of creating another key", async () => {
  const {
    createJsonMutationRequest,
    createMutationTransport,
    operationSuccess,
  } = loadTransport(() => "one-key-only");
  const mutation = createJsonMutationRequest(
    "/api/admin/companies/company-1",
    "PATCH",
    { expectedVersion: 4, name: "Updated" },
    undefined,
  );
  /** @type {unknown[]} */
  const requests = [];
  /** @type {number[]} */
  const delays = [];
  let attempt = 0;
  const transport = createMutationTransport({
    request: async (/** @type {any} */ request) => {
      requests.push(request);
      attempt += 1;
      if (attempt === 1) throw new TypeError("network disconnected after send");
      if (attempt === 2) {
        return {
          response: new Response("not json", { status: 200 }),
          body: null,
          parsed: false,
        };
      }
      return responseResult(200, { code: "COMPANY_UPDATED" });
    },
    sleep: async (/** @type {number} */ delay) => delays.push(delay),
    now: () => 0,
  });

  assert.deepEqual(
    await transport(mutation, operationSuccess("COMPANY_UPDATED")),
    {
      code: "COMPANY_UPDATED",
    },
  );
  assert.deepEqual(delays, [250, 500]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request === mutation));
  assert.equal(mutation.idempotencyKey, "one-key-only");
  assert.equal(
    mutation.body,
    '{"expectedVersion":4,"name":"Updated","idempotencyKey":"one-key-only"}',
  );
});

test("terminal conflicts do not replay and require a consciously created current-intent request", async () => {
  const {
    AdminRequestError,
    createJsonMutationRequest,
    createMutationTransport,
    operationSuccess,
  } = loadTransport();
  const original = createJsonMutationRequest(
    "/api/admin/jobs/job-1/draft",
    "PATCH",
    { expectedDraftVersion: 3, draft: { title: "Before reload" } },
    undefined,
    "original-key",
  );
  /** @type {unknown[]} */
  const requests = [];
  const transport = createMutationTransport({
    request: async (/** @type {any} */ request) => {
      requests.push(request);
      return responseResult(409, {
        code: "DRAFT_VERSION_CONFLICT",
        operationId: "operation-1",
      });
    },
    sleep: async () => assert.fail("terminal conflicts must not be retried"),
  });

  await assert.rejects(
    transport(original, operationSuccess("DRAFT_UPDATED")),
    (error) => {
      const requestError = /** @type {{ status?: unknown, code?: unknown }} */ (
        error
      );
      return (
        error instanceof AdminRequestError &&
        requestError.status === 409 &&
        requestError.code === "DRAFT_VERSION_CONFLICT"
      );
    },
  );
  assert.deepEqual(requests, [original]);

  const resubmittedCurrentIntent = createJsonMutationRequest(
    "/api/admin/jobs/job-1/draft",
    "PATCH",
    { expectedDraftVersion: 4, draft: { title: "After reload" } },
    "operation-1",
    "fresh-key",
  );
  assert.notEqual(
    resubmittedCurrentIntent.idempotencyKey,
    original.idempotencyKey,
  );
  assert.equal(
    resubmittedCurrentIntent.body,
    '{"expectedDraftVersion":4,"draft":{"title":"After reload"},"idempotencyKey":"fresh-key","retryOf":"operation-1"}',
  );
});

test("multipart FormData is replayed without rebuilding or changing its payload", async () => {
  const { createMutationRequest, createMutationTransport, operationSuccess } =
    loadTransport();
  const data = new FormData();
  const file = new Blob(["asset bytes"], { type: "image/png" });
  data.set("file", file, "logo.png");
  data.set("role", "company-logo");
  data.set("expectedDraftVersion", "9");
  data.set("idempotencyKey", "multipart-key");
  const originalFile = data.get("file");
  const mutation = createMutationRequest(
    "/api/admin/jobs/job-1/assets",
    "POST",
    data,
    "multipart-key",
  );
  /** @type {unknown[]} */
  const requests = [];
  const transport = createMutationTransport({
    request: async (/** @type {any} */ request) => {
      requests.push(request);
      return requests.length === 1
        ? responseResult(202, { code: "OPERATION_IN_PROGRESS" }, "0")
        : responseResult(201, { code: "ASSET_ATTACHED" });
    },
    sleep: async () => {},
    now: () => 0,
  });

  assert.deepEqual(
    await transport(mutation, operationSuccess("ASSET_ATTACHED")),
    { code: "ASSET_ATTACHED" },
  );
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request === mutation));
  assert.equal(mutation.body, data);
  assert.equal(data.get("file"), originalFile);
  assert.equal(data.get("role"), "company-logo");
  assert.equal(data.get("expectedDraftVersion"), "9");
  assert.equal(data.get("idempotencyKey"), "multipart-key");
});

test("bounded 202 exhaustion reports uncertainty and never claims a terminal success", async () => {
  const {
    MutationUncertaintyError,
    createJsonMutationRequest,
    createMutationTransport,
    operationSuccess,
  } = loadTransport();
  const mutation = createJsonMutationRequest(
    "/api/admin/jobs/job-1/close",
    "POST",
    { expectedGeneration: 2, closedState: "Closed" },
    undefined,
    "uncertain-key",
  );
  /** @type {unknown[]} */
  const requests = [];
  /** @type {number[]} */
  const delays = [];
  const transport = createMutationTransport({
    request: async (/** @type {any} */ request) => {
      requests.push(request);
      return responseResult(202, { code: "OPERATION_IN_PROGRESS" }, "99999");
    },
    sleep: async (/** @type {number} */ delay) => delays.push(delay),
    now: () => 0,
    maxAttempts: 3,
  });

  await assert.rejects(
    transport(mutation, operationSuccess("CLOSED")),
    (error) => {
      const uncertainty =
        /** @type {{ code?: unknown, status?: unknown, request?: unknown, attempts?: unknown }} */ (
          error
        );
      return (
        error instanceof MutationUncertaintyError &&
        uncertainty.code === "OPERATION_OUTCOME_UNKNOWN" &&
        uncertainty.status === 0 &&
        uncertainty.request === mutation &&
        uncertainty.attempts === 3
      );
    },
  );
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request === mutation));
  assert.deepEqual(delays, [5_000, 5_000]);
});

test("mutation coordinator blocks fresh keys until same-key uncertainty replay terminates", () => {
  const {
    MutationBusyError,
    MutationUncertaintyError,
    createMutationCoordinator,
    createMutationRequest,
    operationSuccess,
  } = loadTransport();
  const controls = [{ disabled: false }, { disabled: false }];
  const coordinator = createMutationCoordinator({ controls: () => controls });
  const request = createMutationRequest(
    "/api/admin/jobs/job-1/publish",
    "POST",
    '{"idempotencyKey":"same-key"}',
    "same-key",
  );
  const reservation = coordinator.reserveFresh();
  coordinator.attach(reservation, request, operationSuccess("PUBLISHED"));

  assert.ok(controls.every((control) => control.disabled));
  assert.throws(() => coordinator.reserveFresh(), MutationBusyError);

  coordinator.fail(
    reservation,
    new MutationUncertaintyError(request, 4, {
      code: "OPERATION_IN_PROGRESS",
    }),
  );
  assert.equal(coordinator.current().phase, "outcome-unknown");
  assert.ok(controls.every((control) => control.disabled));
  assert.throws(
    () =>
      coordinator.beginReplay(
        createMutationRequest("/different", "POST", "{}", "new-key"),
      ),
    MutationBusyError,
  );

  const replay = coordinator.beginReplay(request);
  assert.equal(replay, reservation);
  coordinator.succeed(replay);
  assert.equal(coordinator.current(), null);
  assert.ok(controls.every((control) => !control.disabled));
});

test("terminal failure requires its reload permit before a fresh mutation can begin", () => {
  const {
    AdminRequestError,
    MutationBusyError,
    createMutationCoordinator,
    createMutationRequest,
    operationSuccess,
  } = loadTransport();
  const coordinator = createMutationCoordinator({ controls: () => [] });
  const request = createMutationRequest(
    "/api/admin/companies/company-1",
    "PATCH",
    '{"idempotencyKey":"failed-key"}',
    "failed-key",
  );
  const reservation = coordinator.reserveFresh();
  coordinator.attach(reservation, request, operationSuccess("COMPANY_UPDATED"));
  coordinator.fail(
    reservation,
    new AdminRequestError(409, { code: "COMPANY_VERSION_CONFLICT" }),
  );

  const permit = coordinator.resubmissionPermit();
  assert.ok(permit);
  assert.throws(() => coordinator.reserveFresh(), MutationBusyError);
  assert.equal(coordinator.reserveFresh(permit), reservation);
});

test("success validators reject parseable invalid 2xx envelopes without replay", async () => {
  const {
    MutationResponseError,
    createJsonMutationRequest,
    createMutationTransport,
    operationSuccess,
  } = loadTransport();
  let requests = 0;
  const mutation = createJsonMutationRequest(
    "/api/admin/jobs/job-1/publish",
    "POST",
    { expectedGeneration: 1 },
    undefined,
    "invalid-success-key",
  );
  const transport = createMutationTransport({
    request: async () => {
      requests += 1;
      return responseResult(200, { code: "WRONG_SUCCESS" });
    },
    sleep: async () => assert.fail("invalid terminal success must not replay"),
  });

  await assert.rejects(
    transport(mutation, operationSuccess("PUBLISHED", "revision")),
    MutationResponseError,
  );
  assert.equal(requests, 1);
});

test("standalone company reload resolves the selected current version", () => {
  const { selectedCompanyVersion } = loadTransport();
  assert.equal(
    selectedCompanyVersion(
      [
        { id: "company-1", version: 3 },
        { id: "company-2", version: 8 },
      ],
      "company-2",
    ),
    8,
  );
  assert.equal(selectedCompanyVersion([], "company-2"), 0);
});
test("coordinator-owned same-key recovery survives unrelated UI clearing", () => {
  const {
    MutationUncertaintyError,
    createMutationCoordinator,
    createMutationRequest,
    hasCoordinatorRecovery,
    operationSuccess,
  } = loadTransport();
  const controls = [{ disabled: false }];
  const coordinator = createMutationCoordinator({ controls: () => controls });
  const request = createMutationRequest(
    "/api/admin/jobs/job-1/publish",
    "POST",
    '{"idempotencyKey":"same-key"}',
    "same-key",
  );
  const reservation = coordinator.reserveFresh();
  coordinator.attach(reservation, request, operationSuccess("PUBLISHED"));
  coordinator.fail(
    reservation,
    new MutationUncertaintyError(request, 4, {
      code: "OPERATION_IN_PROGRESS",
    }),
  );
  const sameKeyReplay = {
    label: "초안 공개",
    kind: /** @type {"replay"} */ ("replay"),
    reloaded: false,
    execute: () => coordinator.beginReplay(request),
  };
  coordinator.setRecovery(sameKeyReplay);

  const clearUnrelatedUi = () =>
    hasCoordinatorRecovery(coordinator) ? coordinator.recoveryAction() : null;
  assert.equal(clearUnrelatedUi(), sameKeyReplay);
  assert.ok(controls.every((control) => control.disabled));
  assert.equal(sameKeyReplay.execute(), reservation);
  assert.equal(coordinator.recoveryAction(), null);
  coordinator.fail(
    reservation,
    new MutationUncertaintyError(request, 4, {
      code: "OPERATION_IN_PROGRESS",
    }),
  );
  assert.equal(coordinator.recoveryAction(), sameKeyReplay);
});

test("coordinator-owned terminal recovery retains permit-gated reload path", () => {
  const {
    AdminRequestError,
    MutationBusyError,
    createMutationCoordinator,
    createMutationRequest,
    hasCoordinatorRecovery,
    operationSuccess,
  } = loadTransport();
  const coordinator = createMutationCoordinator({ controls: () => [] });
  const request = createMutationRequest(
    "/api/admin/companies/company-1",
    "PATCH",
    '{"idempotencyKey":"failed-key"}',
    "failed-key",
  );
  const reservation = coordinator.reserveFresh();
  coordinator.attach(reservation, request, operationSuccess("COMPANY_UPDATED"));
  coordinator.fail(
    reservation,
    new AdminRequestError(409, {
      code: "COMPANY_VERSION_CONFLICT",
      operationId: "operation-1",
    }),
  );
  const afterReload = {
    label: "회사 정보 저장",
    kind: /** @type {"resubmit"} */ ("resubmit"),
    operationId: "operation-1",
    reloaded: false,
    execute: () => {},
  };
  coordinator.setRecovery(afterReload);

  assert.equal(hasCoordinatorRecovery(coordinator), true);
  assert.equal(coordinator.recoveryAction(), afterReload);
  assert.equal(coordinator.markRecoveryReloaded(), afterReload);
  assert.equal(afterReload.reloaded, true);
  assert.throws(() => coordinator.reserveFresh(), MutationBusyError);

  const permit = coordinator.resubmissionPermit();
  assert.ok(permit);
  assert.equal(coordinator.reserveFresh(permit), reservation);
});
test("unrelated UI clearing preserves the coordinator-owned same-key replay action", () => {
  const globals = /** @type {Record<string, unknown>} */ (
    /** @type {unknown} */ (globalThis)
  );
  const retryPanel = { hidden: true };
  const retryReload = { hidden: false };
  const retrySubmit = { hidden: true, textContent: "" };
  const retryMessage = { textContent: "" };
  const originalGlobals = new Map(
    [
      "document",
      "errorOutput",
      "retryPanel",
      "retryReload",
      "retrySubmit",
      "retryMessage",
    ].map((key) => [key, globals[key]]),
  );
  Object.assign(globals, {
    document: { querySelectorAll: () => [] },
    errorOutput: { hidden: true, textContent: "" },
    retryPanel,
    retryReload,
    retrySubmit,
    retryMessage,
  });
  try {
    const {
      MutationUncertaintyError,
      clearError,
      createMutationRequest,
      mutationCoordinator,
      operationSuccess,
      showClientError,
    } = loadTransport();
    const request = createMutationRequest(
      "/api/admin/jobs/job-1/publish",
      "POST",
      '{"idempotencyKey":"same-key"}',
      "same-key",
    );
    const reservation = mutationCoordinator.reserveFresh();
    mutationCoordinator.attach(
      reservation,
      request,
      operationSuccess("PUBLISHED"),
    );
    mutationCoordinator.fail(
      reservation,
      new MutationUncertaintyError(request, 4, {
        code: "OPERATION_IN_PROGRESS",
      }),
    );
    const replay = {
      label: "초안 공개",
      kind: /** @type {"replay"} */ ("replay"),
      reloaded: false,
      execute: () => mutationCoordinator.beginReplay(request),
    };
    mutationCoordinator.setRecovery(replay);

    clearError();
    showClientError("unrelated validation error");

    assert.equal(mutationCoordinator.recoveryAction(), replay);
    assert.equal(retryPanel.hidden, false);
    assert.equal(retryReload.hidden, true);
    assert.equal(retrySubmit.hidden, false);
    assert.equal(replay.execute(), reservation);
  } finally {
    for (const [key, value] of originalGlobals) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  }
});

test("ordinary clearing preserves the coordinator-owned permit-gated reload action", () => {
  const globals = /** @type {Record<string, unknown>} */ (
    /** @type {unknown} */ (globalThis)
  );
  const retryPanel = { hidden: true };
  const retryReload = { hidden: false };
  const retrySubmit = { hidden: true, textContent: "" };
  const retryMessage = { textContent: "" };
  const originalGlobals = new Map(
    [
      "document",
      "errorOutput",
      "retryPanel",
      "retryReload",
      "retrySubmit",
      "retryMessage",
    ].map((key) => [key, globals[key]]),
  );
  Object.assign(globals, {
    document: { querySelectorAll: () => [] },
    errorOutput: { hidden: true, textContent: "" },
    retryPanel,
    retryReload,
    retrySubmit,
    retryMessage,
  });
  try {
    const {
      AdminRequestError,
      clearError,
      createMutationRequest,
      mutationCoordinator,
      operationSuccess,
      showClientError,
    } = loadTransport();
    const request = createMutationRequest(
      "/api/admin/companies/company-1",
      "PATCH",
      '{"idempotencyKey":"failed-key"}',
      "failed-key",
    );
    const reservation = mutationCoordinator.reserveFresh();
    mutationCoordinator.attach(
      reservation,
      request,
      operationSuccess("COMPANY_UPDATED"),
    );
    mutationCoordinator.fail(
      reservation,
      new AdminRequestError(409, {
        code: "COMPANY_VERSION_CONFLICT",
        operationId: "operation-1",
      }),
    );
    const resubmit = {
      label: "회사 정보 저장",
      kind: /** @type {"resubmit"} */ ("resubmit"),
      operationId: "operation-1",
      reloaded: false,
      execute: () => {},
    };
    mutationCoordinator.setRecovery(resubmit);

    clearError();
    showClientError("unrelated validation error");

    assert.equal(mutationCoordinator.recoveryAction(), resubmit);
    assert.equal(retryPanel.hidden, false);
    assert.equal(retryReload.hidden, false);
    assert.equal(retrySubmit.hidden, true);
    assert.equal(mutationCoordinator.markRecoveryReloaded(), resubmit);
    clearError();
    assert.equal(retrySubmit.hidden, false);
    assert.ok(mutationCoordinator.resubmissionPermit());
  } finally {
    for (const [key, value] of originalGlobals) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  }
});
