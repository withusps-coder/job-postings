/** @typedef {{ id: string, name: string, website: string, summary: string, version: number }} Company */
/** @typedef {{ id: string, slug: string, companyId?: string, activeGeneration: number, draftVersion?: number, activeRevisionId?: string, status?: string }} Job */
/** @typedef {{ assetId: string, role: string, ordinal?: number, mimeType?: string, byteLength?: number }} DraftAsset */
/** @typedef {{ label: string, url: string }} LinkItem */
/** @typedef {{ label: string, value: string }} StatItem */
/** @typedef {{ execute: (retryOf?: string) => Promise<unknown>, operationId?: string, label: string, reloaded: boolean, kind?: "replay" | "resubmit" }} RetryAction */
/** @typedef {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} FormValueControl */
/** @typedef {{ path: string, method: string, body: BodyInit, idempotencyKey: string }} MutationRequest */
/** @typedef {(body: unknown) => Record<string, unknown>} MutationSuccessValidator */
/** @typedef {{ phase: "in-flight" | "outcome-unknown" | "requires-reload", request: MutationRequest | null, validator: MutationSuccessValidator | null, recovery?: RetryAction, permit?: symbol }} MutationActivity */
/** @typedef {Omit<RetryAction, "operationId" | "reloaded"> & { operationId?: string }} RetryRequest */
/**
 * @typedef {Record<string, unknown> & { name: string, website: string, summary: string }} CompanySnapshot
 * @typedef {Record<string, unknown> & { kind: "email" | "url", value: string, provenance: string }} Application
 * @typedef {{
 *   schemaVersion: number,
 *   status: "open" | "closed",
 *   closedState?: string,
 *   datePosted: string,
 *   publisherAuthorization: { authorized: boolean, scope: "published-job", attestedAt: string },
 *   title: string,
 *   category: string,
 *   employment: string,
 *   location: string,
 *   remote: "onsite" | "hybrid" | "remote",
 *   experience: string,
 *   tags: string[],
 *   mapQuery?: string,
 *   sections: { responsibilities: string[], qualifications: string[], stats?: StatItem[], company?: string[], news?: LinkItem[], preferred?: string[], benefits?: string[], conditions?: string[], process?: string[], notes?: string[] },
 *   documents?: LinkItem[]
 * }} DraftPayload
 */

const formNode = document.querySelector("[data-admin-form]");
const previewNode = document.querySelector("[data-admin-preview]");
const statusNode = document.querySelector("[data-admin-status]");
const errorNode = document.querySelector("[data-admin-error]");
const identityNode = document.querySelector("[data-admin-identity]");
const companySelectNode = document.querySelector("[data-admin-company]");
const jobSelectNode = document.querySelector("[data-admin-job]");
const assetsSectionNode = document.querySelector("[data-admin-assets-section]");
const assetListNode = document.querySelector("[data-admin-asset-list]");
const publishSectionNode = document.querySelector(
  "[data-admin-publish-section]",
);
const publishStateNode = document.querySelector("[data-admin-publish-state]");
const previewStateNode = document.querySelector("[data-admin-preview-state]");
const retryNode = document.querySelector("[data-admin-retry]");
const retryMessageNode = document.querySelector("[data-admin-retry-message]");
const retryReloadNode = document.querySelector("[data-admin-retry-reload]");
const retrySubmitNode = document.querySelector("[data-admin-retry-submit]");
const applicationLabelNode = document.querySelector(
  "[data-admin-application-label]",
);
const applicationHintNode = document.querySelector(
  "[data-admin-application-hint]",
);

if (
  !(formNode instanceof HTMLFormElement) ||
  !(previewNode instanceof HTMLElement) ||
  !(statusNode instanceof HTMLElement) ||
  !(errorNode instanceof HTMLElement) ||
  !(identityNode instanceof HTMLElement) ||
  !(companySelectNode instanceof HTMLSelectElement) ||
  !(jobSelectNode instanceof HTMLSelectElement) ||
  !(assetsSectionNode instanceof HTMLElement) ||
  !(assetListNode instanceof HTMLElement) ||
  !(publishSectionNode instanceof HTMLElement) ||
  !(publishStateNode instanceof HTMLElement) ||
  !(previewStateNode instanceof HTMLElement) ||
  !(retryNode instanceof HTMLElement) ||
  !(retryMessageNode instanceof HTMLElement) ||
  !(retryReloadNode instanceof HTMLButtonElement) ||
  !(retrySubmitNode instanceof HTMLButtonElement) ||
  !(applicationLabelNode instanceof HTMLElement) ||
  !(applicationHintNode instanceof HTMLElement)
)
  throw new Error("관리 화면을 초기화할 수 없습니다.");

const form = formNode;
const preview = previewNode;
const statusOutput = statusNode;
const errorOutput = errorNode;
const identityOutput = identityNode;
const companySelect = companySelectNode;
const jobSelect = jobSelectNode;
const assetsSection = assetsSectionNode;
const assetList = assetListNode;
const publishSection = publishSectionNode;
const publishState = publishStateNode;
const previewStatus = previewStateNode;
const retryPanel = retryNode;
const retryMessage = retryMessageNode;
const retryReload = retryReloadNode;
const retrySubmit = retrySubmitNode;
const applicationLabel = applicationLabelNode;
const applicationHint = applicationHintNode;

const supportedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maximumImageBytes = 5 * 1024 * 1024;
const maximumPdfBytes = 20 * 1024 * 1024;

let csrfToken = "";
let csrfExpiresAt = 0;
/** @type {Company[]} */
let companies = [];
/** @type {Job[]} */
let jobs = [];
/** @type {DraftAsset[]} */
let assets = [];
let currentJobId = "";
let currentCompanyId = "";
let currentCompanyVersion = 0;
let draftVersion = 0;
let activeGeneration = 0;
let activeRevisionId = "";
let activeStatus = "";
/** @type {DraftAsset | null} */
let replacementAsset = null;

class AdminRequestError extends Error {
  /** @param {number} status @param {unknown} body */
  constructor(status, body) {
    const detail = isRecord(body) ? body : {};
    super(readString(detail["message"]) || "요청을 처리할 수 없습니다.");
    this.name = "AdminRequestError";
    this.status = status;
    this.code = readString(detail["code"]) || "ADMIN_REQUEST_FAILED";
    this.correlationId = readString(detail["correlationId"]);
    this.operationId = operationIdFrom(detail);
  }
}

class MutationUncertaintyError extends AdminRequestError {
  /**
   * @param {MutationRequest} request
   * @param {number} attempts
   * @param {unknown} body
   */
  constructor(request, attempts, body) {
    super(0, {
      code: "OPERATION_OUTCOME_UNKNOWN",
      message:
        "작업 완료 여부를 확인하지 못했습니다. 동일한 요청으로 상태를 다시 확인해 주세요.",
      ...(isRecord(body) && operationIdFrom(body)
        ? { operationId: operationIdFrom(body) }
        : {}),
    });
    this.name = "MutationUncertaintyError";
    this.request = request;
    this.attempts = attempts;
  }
}
class MutationBusyError extends Error {
  constructor() {
    super(
      "진행 중이거나 확인되지 않은 작업이 있습니다. 완료 상태를 확인한 뒤 다시 시도해 주세요.",
    );
    this.name = "MutationBusyError";
    this.code = "MUTATION_BUSY";
  }
}

class MutationResponseError extends AdminRequestError {
  /** @param {number} status @param {unknown} body @param {string} expectedCode */
  constructor(status, body, expectedCode) {
    super(status, {
      code: "MUTATION_RESPONSE_INVALID",
      message: `서버가 ${expectedCode} 작업의 완료 결과를 확인 가능한 형식으로 반환하지 않았습니다.`,
    });
    this.name = "MutationResponseError";
    this.expectedCode = expectedCode;
    this.body = body;
  }
}

const freshMutationControlSelector = [
  "[data-admin-company-save]",
  "[data-admin-save]",
  "[data-admin-asset-upload]",
  "[data-admin-publish]",
  "[data-admin-close]",
  "[data-admin-rollback]",
  "[data-admin-asset-detach]",
].join(",");

/**
 * @param {{
 *   controls?: () => Iterable<HTMLButtonElement>,
 * }} [options]
 */
function createMutationCoordinator(options = {}) {
  /** @type {MutationActivity | null} */
  let activity = null;
  const controls =
    options.controls ??
    (() =>
      [...document.querySelectorAll(freshMutationControlSelector)].filter(
        (control) => control instanceof HTMLButtonElement,
      ));

  const render = () => {
    for (const control of controls()) control.disabled = activity !== null;
  };

  return {
    /** @param {symbol | null} permit */
    reserveFresh(permit = null) {
      if (activity) {
        if (
          activity.phase === "requires-reload" &&
          permit &&
          activity.permit === permit
        ) {
          activity.phase = "in-flight";
          delete activity.permit;
          render();
          return activity;
        }
        throw new MutationBusyError();
      }
      activity = {
        phase: "in-flight",
        request: null,
        validator: null,
      };
      render();
      return activity;
    },
    /**
     * @param {MutationActivity} reservation
     * @param {MutationRequest} request
     * @param {MutationSuccessValidator} validator
     */
    attach(reservation, request, validator) {
      if (activity !== reservation) throw new MutationBusyError();
      reservation.request = request;
      reservation.validator = validator;
    },
    /** @param {MutationRequest} request */
    beginReplay(request) {
      if (
        !activity ||
        activity.phase !== "outcome-unknown" ||
        activity.request !== request ||
        !activity.validator
      ) {
        throw new MutationBusyError();
      }
      activity.phase = "in-flight";
      render();
      return activity;
    },
    /** @param {MutationActivity} reservation */
    succeed(reservation) {
      if (activity !== reservation) return;
      activity = null;
      render();
    },
    /** @param {MutationActivity} reservation @param {unknown} error */
    fail(reservation, error) {
      if (activity !== reservation) return;
      if (error instanceof MutationUncertaintyError) {
        reservation.phase = "outcome-unknown";
      } else if (reservation.request) {
        reservation.phase = "requires-reload";
        reservation.permit = Symbol("resubmission");
      } else {
        activity = null;
      }
      render();
    },
    /** @returns {symbol | null} */
    resubmissionPermit() {
      return activity?.phase === "requires-reload"
        ? activity.permit || null
        : null;
    },
    /** @param {RetryAction} recovery */
    setRecovery(recovery) {
      if (
        !activity ||
        (activity.phase !== "outcome-unknown" &&
          activity.phase !== "requires-reload")
      ) {
        return null;
      }
      activity.recovery = recovery;
      return recovery;
    },
    /** @returns {RetryAction | null} */
    recoveryAction() {
      return activity &&
        (activity.phase === "outcome-unknown" ||
          activity.phase === "requires-reload")
        ? (activity.recovery ?? null)
        : null;
    },
    /** @returns {RetryAction | null} */
    markRecoveryReloaded() {
      if (
        !activity ||
        activity.phase !== "requires-reload" ||
        !activity.recovery
      ) {
        return null;
      }
      activity.recovery.reloaded = true;
      return activity.recovery;
    },
    /** @returns {MutationActivity | null} */
    current() {
      return activity;
    },
    render,
  };
}

const mutationCoordinator = createMutationCoordinator();
/** @type {symbol | null} */
let resubmissionPermit = null;
/** @param {Company[]} availableCompanies @param {string} companyId */
function selectedCompanyVersion(availableCompanies, companyId) {
  return (
    availableCompanies.find((company) => company.id === companyId)?.version ?? 0
  );
}

/** @param {{ recoveryAction: () => RetryAction | null }} coordinator */
function hasCoordinatorRecovery(coordinator = mutationCoordinator) {
  return coordinator.recoveryAction() !== null;
}
/** @param {RetryAction} action */
function renderRecoveryAction(action) {
  retryPanel.hidden = false;
  retryReload.hidden = action.kind === "replay";
  retrySubmit.hidden = action.kind !== "replay" && !action.reloaded;
  retrySubmit.textContent =
    action.kind === "replay"
      ? "동일한 요청으로 다시 확인"
      : "현재 입력으로 다시 제출";
  retryMessage.textContent =
    action.kind === "replay"
      ? `${action.label} 작업의 완료 여부를 확인하지 못했습니다. 새 요청을 만들지 않고 동일한 요청 키로 다시 확인할 수 있습니다.`
      : action.reloaded
        ? "현재 저장 상태를 불러왔습니다. 입력값과 자산을 검토한 뒤 같은 작업을 새 키로 다시 제출해 주세요."
        : `${action.label} 작업을 다시 시도하려면 먼저 현재 상태를 불러오고 입력값을 검토해 주세요.${action.operationId ? " 새 시도는 이전 작업과 연결됩니다." : " 이전 작업 ID를 확인할 수 없어 새 시도로만 제출됩니다."}`;
}

/** @returns {boolean} */
function renderCoordinatorRecovery() {
  const action = mutationCoordinator.recoveryAction();
  if (!action) return false;
  renderRecoveryAction(action);
  return true;
}

const clearError = () => {
  if (hasCoordinatorRecovery()) {
    renderCoordinatorRecovery();
    return;
  }
  errorOutput.textContent = "";
  errorOutput.hidden = true;
  retryPanel.hidden = true;
  retryReload.hidden = false;
  retrySubmit.hidden = true;
  retrySubmit.textContent = "현재 입력으로 다시 제출";
};

/** @param {string} message */
const setStatus = (message) => {
  statusOutput.textContent = message;
};

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function readString(value) {
  return typeof value === "string" ? value : "";
}

/** @param {unknown} value */
function readPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

// Redacted API errors may omit this optional lineage ID; retries remain safe after a state reload.
/** @param {Record<string, unknown>} response */
function operationIdFrom(response) {
  const direct = readString(response["operationId"]);
  if (direct) return direct;
  const operation = response["operation"];
  return isRecord(operation) ? readString(operation["id"]) : "";
}

/**
 * @param {string} name
 * @returns {FormValueControl | null}
 */
function control(name) {
  const element = form.elements.namedItem(name);
  return isFormValueControl(element) ? element : null;
}

/** @param {unknown} value @returns {value is FormValueControl} */
function isFormValueControl(value) {
  return (
    value instanceof HTMLInputElement ||
    value instanceof HTMLSelectElement ||
    value instanceof HTMLTextAreaElement
  );
}

/** @param {string} name */
function fieldValue(name) {
  const field = control(name);
  return field ? field.value.trim() : "";
}

/** @param {string} name @param {string | boolean | undefined} value */
function setField(name, value) {
  const field = control(name);
  if (field instanceof HTMLInputElement && field.type === "checkbox") {
    field.checked = value === true;
  } else if (field) {
    field.value = typeof value === "string" ? value : "";
  }
}

/** @param {string} name */
function textLines(name) {
  return fieldValue(name)
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** @param {string} name */
function commaOrTextLines(name) {
  return fieldValue(name)
    .split(/\n|,/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** @param {string} name @returns {LinkItem[]} */
function linkPairs(name) {
  return textLines(name).flatMap((item) => {
    const [label, ...remaining] = item.split("|");
    const url = remaining.join("|").trim();
    return label?.trim() && isHttpsUrl(url)
      ? [{ label: label.trim(), url }]
      : [];
  });
}

/** @returns {StatItem[]} */
function statPairs() {
  return textLines("stats").flatMap((item) => {
    const [label, ...remaining] = item.split("|");
    const value = remaining.join("|").trim();
    return label?.trim() && value ? [{ label: label.trim(), value }] : [];
  });
}

/** @param {string} value */
function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** @param {string} value */
function isEmail(value) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value);
}

/** @param {string[] | undefined} values */
function joinLines(values) {
  return (values ?? []).join("\n");
}

/** @param {LinkItem[] | undefined} values */
function joinLinkPairs(values) {
  return (values ?? []).map((item) => `${item.label} | ${item.url}`).join("\n");
}

/** @param {StatItem[] | undefined} values */
function joinStatPairs(values) {
  return (values ?? [])
    .map((item) => `${item.label} | ${item.value}`)
    .join("\n");
}

function updateApplicationControl() {
  const kind = fieldValue("applicationKind") === "email" ? "email" : "url";
  const value = control("applicationValue");
  if (!(value instanceof HTMLInputElement)) return;

  value.type = kind === "email" ? "email" : "url";
  applicationLabel.textContent =
    kind === "email" ? "지원 이메일 *" : "공식 지원 URL *";
  applicationHint.textContent =
    kind === "email"
      ? "지원자가 사용할 이메일 주소를 입력합니다."
      : "https://로 시작하는 공식 지원 페이지를 입력합니다.";
}

/** @returns {CompanySnapshot} */
function buildCompanySnapshot() {
  return {
    name: fieldValue("companyName"),
    website: fieldValue("companyWebsite"),
    summary: fieldValue("companySummary"),
  };
}

/** @returns {Application} */
function buildApplication() {
  const kind = fieldValue("applicationKind") === "email" ? "email" : "url";
  return {
    kind,
    value: fieldValue("applicationValue"),
    provenance: fieldValue("applicationProvenance"),
  };
}

/** @returns {DraftPayload} */
function buildDraft() {
  const company = textLines("company");
  const stats = statPairs();
  const news = linkPairs("news");
  const preferred = textLines("preferred");
  const benefits = textLines("benefits");
  const conditions = textLines("conditions");
  const process = textLines("process");
  const notes = textLines("notes");
  const documents = linkPairs("documents");
  const closedState = fieldValue("closedState");
  const currentStatus = fieldValue("status") === "closed" ? "closed" : "open";
  const selectedRemote = fieldValue("remote");
  const remote =
    selectedRemote === "remote" || selectedRemote === "hybrid"
      ? selectedRemote
      : "onsite";
  const publisherApproval = control("publisherApproved");
  return {
    schemaVersion: 1,
    status: currentStatus,
    ...(closedState ? { closedState } : {}),
    datePosted: fieldValue("datePosted"),
    publisherAuthorization: {
      authorized:
        publisherApproval instanceof HTMLInputElement &&
        publisherApproval.checked,
      scope: "published-job",
      attestedAt: new Date().toISOString(),
    },
    title: fieldValue("title"),
    category: fieldValue("category"),
    employment: fieldValue("employment"),
    location: fieldValue("location"),
    remote,
    experience: fieldValue("experience"),
    tags: commaOrTextLines("tags"),
    ...(fieldValue("mapQuery") ? { mapQuery: fieldValue("mapQuery") } : {}),
    sections: {
      responsibilities: textLines("responsibilities"),
      qualifications: textLines("qualifications"),
      ...(stats.length ? { stats } : {}),
      ...(company.length ? { company } : {}),
      ...(news.length ? { news } : {}),
      ...(preferred.length ? { preferred } : {}),
      ...(benefits.length ? { benefits } : {}),
      ...(conditions.length ? { conditions } : {}),
      ...(process.length ? { process } : {}),
      ...(notes.length ? { notes } : {}),
    },
    ...(documents.length ? { documents } : {}),
  };
}

/** @param {string[]} names */
function validateNamedFields(names) {
  for (const name of names) {
    const element = control(name);
    if (element && !element.checkValidity()) {
      element.reportValidity();
      element.focus();
      return false;
    }
  }
  return true;
}

/** @param {string} name */
function hasValidLinkPairs(name) {
  return textLines(name).every((item) => {
    const [label, ...remaining] = item.split("|");
    return Boolean(label?.trim() && isHttpsUrl(remaining.join("|").trim()));
  });
}

function validateDraft() {
  if (!form.checkValidity()) {
    form.reportValidity();
    return false;
  }
  if (!hasValidLinkPairs("news") || !hasValidLinkPairs("documents")) {
    showClientError(
      "관련 소식과 첨부 문서 링크는 ‘제목 | https://주소’ 형식으로 입력해 주세요.",
    );
    return false;
  }
  const application = buildApplication();
  if (
    (application["kind"] === "url" &&
      !isHttpsUrl(readString(application["value"]))) ||
    (application["kind"] === "email" &&
      !isEmail(readString(application["value"])))
  ) {
    showClientError(
      "지원 경로는 HTTPS URL 또는 올바른 이메일 주소여야 합니다.",
    );
    return false;
  }
  return true;
}

/** @param {string} message */
function showClientError(message) {
  errorOutput.textContent = message;
  errorOutput.hidden = false;
  if (hasCoordinatorRecovery()) {
    renderCoordinatorRecovery();
    return;
  }
  retryPanel.hidden = true;
}

/** @param {unknown} error @param {RetryRequest} [retry] */
function showRequestError(error, retry) {
  const requestError = error instanceof AdminRequestError ? error : null;
  const message =
    requestError?.message ||
    "요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  const detail = requestError
    ? `${message} (${requestError.code}${requestError.correlationId ? ` · ${requestError.correlationId}` : ""})`
    : message;
  errorOutput.textContent = detail;
  errorOutput.hidden = false;

  const replay =
    error instanceof MutationUncertaintyError
      ? {
          label: retry?.label || "작업 상태 확인",
          execute: async () => {
            try {
              const result = await executeMutation(error.request);
              await reloadCurrentState();
              return result;
            } catch (replayError) {
              showRequestError(replayError, retry);
            }
          },
          kind: /** @type {"replay"} */ ("replay"),
        }
      : null;
  const existingRecovery = mutationCoordinator.recoveryAction();
  const retryRequest = replay || retry || existingRecovery;
  if (!retryRequest) {
    retryPanel.hidden = true;
    return;
  }

  const recoveryOperationId =
    ("operationId" in retryRequest ? retryRequest.operationId : "") ||
    requestError?.operationId;
  /** @type {RetryAction} */
  const nextRetryAction =
    existingRecovery && retryRequest === existingRecovery && !replay && !retry
      ? existingRecovery
      : {
          label: retryRequest.label,
          execute: retryRequest.execute,
          ...(recoveryOperationId ? { operationId: recoveryOperationId } : {}),
          kind: retryRequest.kind ?? "resubmit",
          reloaded: false,
        };
  const recovery = mutationCoordinator.setRecovery(nextRetryAction);
  if (recovery) {
    renderRecoveryAction(recovery);
    return;
  }
  if (renderCoordinatorRecovery()) return;
  retryPanel.hidden = true;
}

async function loadSession() {
  if (csrfToken && csrfExpiresAt > Date.now() + 60_000) return;
  const response = await fetch("/api/admin/session", {
    headers: { accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = await readResponseJson(response);
  if (!response.ok) throw new AdminRequestError(response.status, body);
  if (!isRecord(body)) throw new Error("Invalid session response");
  const token = readString(body["csrfToken"]);
  const expiresAt = Date.parse(readString(body["expiresAt"]));
  if (!token || !Number.isFinite(expiresAt))
    throw new Error("Invalid session response");
  csrfToken = token;
  csrfExpiresAt = expiresAt;
  const admin = body["admin"];
  identityOutput.textContent =
    isRecord(admin) && readString(admin["email"])
      ? `로그인: ${readString(admin["email"])}`
      : "관리자 세션이 확인되었습니다.";
}

/**
 * @param {Response} response
 * @returns {Promise<{ body: unknown, parsed: boolean }>}
 */
async function readJsonResponse(response) {
  try {
    return { body: await response.json(), parsed: true };
  } catch {
    return { body: null, parsed: false };
  }
}

/** @param {Response} response @returns {Promise<unknown>} */
async function readResponseJson(response) {
  return (await readJsonResponse(response)).body;
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: BodyInit | null, headers?: HeadersInit, idempotencyKey?: string }} [options]
 * @returns {Promise<{ response: Response, body: unknown, parsed: boolean }>}
 */
async function requestApi(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD") {
    await loadSession();
    headers.set("x-csrf-token", csrfToken);
  }
  if (options.idempotencyKey)
    headers.set("x-idempotency-key", options.idempotencyKey);

  const response = await fetch(path, {
    method,
    headers,
    body: options.body ?? null,
    cache: "no-store",
    credentials: "same-origin",
  });
  return { response, ...(await readJsonResponse(response)) };
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: BodyInit | null, headers?: HeadersInit, idempotencyKey?: string }} [options]
 * @returns {Promise<unknown>}
 */
async function api(path, options = {}) {
  const { response, body } = await requestApi(path, options);
  if (!response.ok || response.status === 202)
    throw new AdminRequestError(response.status, body);
  return body;
}

const mutationRetryMinimumMilliseconds = 250;
const mutationRetryMaximumMilliseconds = 5_000;
const mutationRetryMaximumAttempts = 4;

/** @param {number} milliseconds */
function boundedRetryDelay(milliseconds) {
  return Math.min(
    mutationRetryMaximumMilliseconds,
    Math.max(mutationRetryMinimumMilliseconds, Math.round(milliseconds)),
  );
}

/** @param {string | null} value @param {number} now */
function retryAfterDelay(value, now) {
  if (!value) return 0;
  if (/^\s*\d+\s*$/u.test(value))
    return boundedRetryDelay(Number.parseInt(value, 10) * 1_000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? boundedRetryDelay(Math.max(0, retryAt - now))
    : 0;
}

/** @param {number} attempt @param {string | null} retryAfter @param {number} now */
function mutationRetryDelay(attempt, retryAfter, now) {
  return (
    retryAfterDelay(retryAfter, now) ||
    boundedRetryDelay(mutationRetryMinimumMilliseconds * 2 ** attempt)
  );
}

/** @param {number} milliseconds */
function waitForRetry(milliseconds) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

/**
 * @param {string} path
 * @param {string} method
 * @param {BodyInit} body
 * @param {string} idempotencyKey
 * @returns {MutationRequest}
 */
function createMutationRequest(path, method, body, idempotencyKey) {
  return Object.freeze({ path, method, body, idempotencyKey });
}

/**
 * @param {string} path
 * @param {"POST" | "PATCH" | "DELETE"} method
 * @param {Record<string, unknown>} payload
 * @param {string | undefined} retryOf
 * @param {string} [idempotencyKey]
 * @returns {MutationRequest}
 */
function createJsonMutationRequest(
  path,
  method,
  payload,
  retryOf,
  idempotencyKey = crypto.randomUUID(),
) {
  return createMutationRequest(
    path,
    method,
    JSON.stringify({
      ...payload,
      idempotencyKey,
      ...(retryOf ? { retryOf } : {}),
    }),
    idempotencyKey,
  );
}

/** @param {MutationRequest} request */
async function requestMutation(request) {
  return requestApi(request.path, {
    method: request.method,
    body: request.body,
    idempotencyKey: request.idempotencyKey,
  });
}

/**
 * @param {string} expectedCode
 * @param {string} [valueKey]
 * @param {"record" | "string"} [valueType]
 * @returns {MutationSuccessValidator}
 */
function operationSuccess(expectedCode, valueKey = "", valueType = "record") {
  return (body) => {
    if (
      !isRecord(body) ||
      readString(body["code"]) !== expectedCode ||
      (valueKey &&
        (valueType === "record"
          ? !isRecord(body[valueKey])
          : !readString(body[valueKey])))
    ) {
      throw new MutationResponseError(200, body, expectedCode);
    }
    return body;
  };
}

/**
 * @param {{
 *   request?: (request: MutationRequest) => Promise<{ response: Response, body: unknown, parsed: boolean }>,
 *   sleep?: (milliseconds: number) => Promise<void>,
 *   now?: () => number,
 *   maxAttempts?: number,
 * }} [options]
 */
function createMutationTransport(options = {}) {
  const request = options.request ?? requestMutation;
  const sleep = options.sleep ?? waitForRetry;
  const now = options.now ?? Date.now;
  const maxAttempts = Number.isSafeInteger(options.maxAttempts)
    ? Math.min(
        mutationRetryMaximumAttempts,
        Math.max(1, options.maxAttempts ?? mutationRetryMaximumAttempts),
      )
    : mutationRetryMaximumAttempts;

  /**
   * @param {MutationRequest} mutation
   * @param {MutationSuccessValidator} validateSuccess
   */
  return async function transportMutation(mutation, validateSuccess) {
    /** @type {unknown} */
    let lastBody = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      /** @type {string | null} */
      let retryAfter = null;
      try {
        const result = await request(mutation);
        const response = result?.response;
        if (!response || typeof response.status !== "number")
          throw new TypeError("Mutation request returned an invalid response.");
        if (!response.ok && response.status !== 202)
          throw new AdminRequestError(response.status, result.body);
        if (response.status !== 202 && result.parsed)
          return validateSuccess(result.body);
        lastBody = result.body;
        retryAfter = response.headers.get("retry-after");
      } catch (error) {
        if (error instanceof AdminRequestError) throw error;
      }

      if (attempt + 1 < maxAttempts)
        await sleep(mutationRetryDelay(attempt, retryAfter, now()));
    }

    throw new MutationUncertaintyError(mutation, maxAttempts, lastBody);
  };
}

const mutationTransport = createMutationTransport();

/**
 * @param {() => MutationRequest} createRequest
 * @param {MutationSuccessValidator} validateSuccess
 */
async function executeFreshMutation(createRequest, validateSuccess) {
  const reservation = mutationCoordinator.reserveFresh(resubmissionPermit);
  try {
    const request = createRequest();
    mutationCoordinator.attach(reservation, request, validateSuccess);
    const result = await mutationTransport(request, validateSuccess);
    mutationCoordinator.succeed(reservation);
    return result;
  } catch (error) {
    mutationCoordinator.fail(reservation, error);
    throw error;
  }
}

/** @param {MutationRequest} request */
async function executeMutation(request) {
  const reservation = mutationCoordinator.beginReplay(request);
  const validateSuccess = reservation.validator;
  if (!validateSuccess) throw new MutationBusyError();
  try {
    const result = await mutationTransport(request, validateSuccess);
    mutationCoordinator.succeed(reservation);
    return result;
  } catch (error) {
    mutationCoordinator.fail(reservation, error);
    throw error;
  }
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} payload
 * @param {string | undefined} retryOf
 * @param {MutationSuccessValidator} validateSuccess
 */
async function jsonMutation(path, payload, retryOf, validateSuccess) {
  return executeFreshMutation(
    () => createJsonMutationRequest(path, "POST", payload, retryOf),
    validateSuccess,
  );
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} payload
 * @param {string | undefined} retryOf
 * @param {MutationSuccessValidator} validateSuccess
 */
async function jsonPatch(path, payload, retryOf, validateSuccess) {
  return executeFreshMutation(
    () => createJsonMutationRequest(path, "PATCH", payload, retryOf),
    validateSuccess,
  );
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} payload
 * @param {string | undefined} retryOf
 * @param {MutationSuccessValidator} validateSuccess
 */
async function jsonDelete(path, payload, retryOf, validateSuccess) {
  return executeFreshMutation(
    () => createJsonMutationRequest(path, "DELETE", payload, retryOf),
    validateSuccess,
  );
}

/** @param {string} path @param {string} key @returns {Promise<unknown[]>} */
async function readAll(path, key) {
  /** @type {unknown[]} */
  const items = [];
  const cursors = new Set();
  let cursor = "";
  let hasNextPage = true;
  while (hasNextPage) {
    const parameters = new URLSearchParams({ limit: "100" });
    if (cursor) parameters.set("cursor", cursor);
    const response = await api(`${path}?${parameters.toString()}`);
    if (!isRecord(response) || !Array.isArray(response[key])) {
      throw new Error("Invalid collection response");
    }
    items.push(...response[key]);
    const nextCursor = readString(response["nextCursor"]);
    hasNextPage = Boolean(nextCursor && !cursors.has(nextCursor));
    if (hasNextPage && nextCursor) {
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
  return items;
}

/** @param {unknown[]} values @returns {Company[]} */
function mapCompanies(values) {
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = readString(value["id"]);
    const name = readString(value["name"]);
    const website = readString(value["website"]);
    const summary = readString(value["summary"]);
    const version = readPositiveInteger(value["version"]);
    return id && name && website && summary && version
      ? [{ id, name, website, summary, version }]
      : [];
  });
}

/** @param {unknown[]} values @returns {Job[]} */
function mapJobs(values) {
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = readString(value["id"]);
    const slug = readString(value["slug"]);
    const activeGeneration =
      typeof value["activeGeneration"] === "number" &&
      Number.isSafeInteger(value["activeGeneration"])
        ? value["activeGeneration"]
        : 0;
    if (!id || !slug) return [];
    const companyId = readString(value["companyId"]);
    const draftVersionValue = readPositiveInteger(value["draftVersion"]);
    const activeRevision = readString(value["activeRevisionId"]);
    const status = readString(value["status"]);
    return [
      {
        id,
        slug,
        activeGeneration,
        ...(companyId ? { companyId } : {}),
        ...(draftVersionValue ? { draftVersion: draftVersionValue } : {}),
        ...(activeRevision ? { activeRevisionId: activeRevision } : {}),
        ...(status ? { status } : {}),
      },
    ];
  });
}

function renderCompanyOptions() {
  const selected = currentCompanyId || companySelect.value;
  companySelect.replaceChildren(new Option("회사 선택", ""));
  for (const company of companies)
    companySelect.add(new Option(company.name, company.id));
  companySelect.value = companies.some((company) => company.id === selected)
    ? selected
    : "";
}

function renderJobOptions() {
  const selected = currentJobId || jobSelect.value;
  jobSelect.replaceChildren(new Option("새 공고", ""));
  for (const job of jobs) jobSelect.add(new Option(job.slug, job.id));
  jobSelect.value = jobs.some((job) => job.id === selected) ? selected : "";
}

async function loadCollections() {
  const [companyValues, jobValues] = await Promise.all([
    readAll("/api/admin/companies", "companies"),
    readAll("/api/admin/jobs", "jobs"),
  ]);
  companies = mapCompanies(companyValues);
  jobs = mapJobs(jobValues);
  if (!currentJobId) {
    currentCompanyVersion = selectedCompanyVersion(companies, currentCompanyId);
  }
  renderCompanyOptions();
  renderJobOptions();
}

/** @param {Record<string, unknown>} envelope @param {string} fallbackId */
function loadDraftEnvelope(envelope, fallbackId) {
  const job = isRecord(envelope["job"]) ? envelope["job"] : {};
  const draftEnvelope = isRecord(envelope["draft"]) ? envelope["draft"] : {};
  const draft = isRecord(draftEnvelope["draft"])
    ? draftEnvelope["draft"]
    : isRecord(draftEnvelope["draftJson"])
      ? draftEnvelope["draftJson"]
      : {};
  const company = isRecord(draftEnvelope["companySnapshot"])
    ? draftEnvelope["companySnapshot"]
    : isRecord(draftEnvelope["companySnapshotJson"])
      ? draftEnvelope["companySnapshotJson"]
      : {};
  const application = isRecord(draftEnvelope["application"])
    ? draftEnvelope["application"]
    : isRecord(draftEnvelope["applicationJson"])
      ? draftEnvelope["applicationJson"]
      : {};
  const sections = isRecord(draft["sections"]) ? draft["sections"] : {};

  currentJobId = readString(job["id"]) || fallbackId;
  draftVersion = readPositiveInteger(draftEnvelope["version"]);
  activeGeneration =
    typeof job["activeGeneration"] === "number" &&
    Number.isSafeInteger(job["activeGeneration"])
      ? job["activeGeneration"]
      : 0;
  activeRevisionId = readString(job["activeRevisionId"]);
  activeStatus = readString(job["status"]) || activeStatus;
  const companyId =
    readString(draftEnvelope["companyId"]) || readString(job["companyId"]);
  currentCompanyId = companyId;
  currentCompanyVersion =
    companies.find((companyItem) => companyItem.id === companyId)?.version ?? 0;
  assets = Array.isArray(draftEnvelope["assets"])
    ? draftEnvelope["assets"].flatMap(mapAsset)
    : [];

  setField("slug", readString(job["slug"]));
  setField("status", readString(draft["status"]) || activeStatus || "open");
  setField("title", readString(draft["title"]));
  setField("category", readString(draft["category"]));
  setField("experience", readString(draft["experience"]));
  setField("employment", readString(draft["employment"]));
  setField("remote", readString(draft["remote"]) || "onsite");
  setField("location", readString(draft["location"]));
  setField("datePosted", readString(draft["datePosted"]));
  setField("closedState", readString(draft["closedState"]));
  setField("companyName", readString(company["name"]));
  setField("companyWebsite", readString(company["website"]));
  setField("companySummary", readString(company["summary"]));
  setField("mapQuery", readString(draft["mapQuery"]));
  setField(
    "applicationKind",
    readString(application["kind"]) === "email" ? "email" : "url",
  );
  setField("applicationValue", readString(application["value"]));
  setField("applicationProvenance", readString(application["provenance"]));
  setField(
    "tags",
    Array.isArray(draft["tags"])
      ? joinLines(draft["tags"].filter((item) => typeof item === "string"))
      : "",
  );
  setField("company", stringArray(sections["company"]));
  setField("stats", statArray(sections["stats"]));
  setField("news", linkArray(sections["news"]));
  setField("responsibilities", stringArray(sections["responsibilities"]));
  setField("qualifications", stringArray(sections["qualifications"]));
  setField("preferred", stringArray(sections["preferred"]));
  setField("benefits", stringArray(sections["benefits"]));
  setField("conditions", stringArray(sections["conditions"]));
  setField("process", stringArray(sections["process"]));
  setField("notes", stringArray(sections["notes"]));
  setField("documents", linkArray(draft["documents"]));
  setField("publisherApproved", false);
  const slug = control("slug");
  if (slug instanceof HTMLInputElement) slug.disabled = true;

  replacementAsset = null;
  companySelect.value = currentCompanyId;
  jobSelect.value = currentJobId;
  assetsSection.hidden = false;
  publishSection.hidden = false;
  updateApplicationControl();
  renderAssetList();
  renderPublishState();
  renderPreview();
}

/** @param {unknown} value */
function stringArray(value) {
  return Array.isArray(value)
    ? joinLines(value.filter((item) => typeof item === "string"))
    : "";
}

/** @param {unknown} value */
function linkArray(value) {
  if (!Array.isArray(value)) return "";
  return joinLinkPairs(
    value.flatMap((item) => {
      if (!isRecord(item)) return [];
      const label = readString(item["label"]);
      const url = readString(item["url"]);
      return label && url ? [{ label, url }] : [];
    }),
  );
}

/** @param {unknown} value */
function statArray(value) {
  if (!Array.isArray(value)) return "";
  return joinStatPairs(
    value.flatMap((item) => {
      if (!isRecord(item)) return [];
      const label = readString(item["label"]);
      const statValue = readString(item["value"]);
      return label && statValue ? [{ label, value: statValue }] : [];
    }),
  );
}

/** @param {unknown} value @returns {DraftAsset[]} */
function mapAsset(value) {
  if (!isRecord(value)) return [];
  const assetId = readString(value["assetId"]) || readString(value["id"]);
  const role = readString(value["role"]);
  if (!assetId || !role) return [];
  const ordinal =
    typeof value["ordinal"] === "number" &&
    Number.isSafeInteger(value["ordinal"])
      ? value["ordinal"]
      : undefined;
  const mimeType =
    readString(value["mimeType"]) || readString(value["detectedMime"]);
  const byteLength = readPositiveInteger(value["byteLength"]);
  return [
    {
      assetId,
      role,
      ...(ordinal === undefined ? {} : { ordinal }),
      ...(mimeType ? { mimeType } : {}),
      ...(byteLength ? { byteLength } : {}),
    },
  ];
}

async function loadCurrentJob() {
  if (!currentJobId) return;
  const response = await api(
    `/api/admin/jobs/${encodeURIComponent(currentJobId)}/draft`,
  );
  if (!isRecord(response)) throw new Error("Invalid draft response");
  loadDraftEnvelope(response, currentJobId);
}

function resetForNewJob() {
  currentJobId = "";
  draftVersion = 0;
  activeGeneration = 0;
  activeRevisionId = "";
  activeStatus = "";
  assets = [];
  replacementAsset = null;
  form.reset();
  setField("status", "open");
  setField("remote", "onsite");
  setField("datePosted", new Date().toISOString().slice(0, 10));
  setField("applicationKind", "url");
  setField("publisherApproved", false);
  const selectedCompany = companies.find(
    (company) => company.id === currentCompanyId,
  );
  if (selectedCompany) {
    setField("companyName", selectedCompany.name);
    setField("companyWebsite", selectedCompany.website);
    setField("companySummary", selectedCompany.summary);
  }
  const slug = control("slug");
  if (slug instanceof HTMLInputElement) slug.disabled = false;
  jobSelect.value = "";
  assetsSection.hidden = true;
  publishSection.hidden = true;
  updateApplicationControl();
  renderAssetList();
  renderPreview();
}

/** @param {HTMLElement} parent @param {string} title @param {string[] | undefined} items */
function appendList(parent, title, items) {
  if (!items?.length) return;
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  const list = document.createElement("ul");
  heading.textContent = title;
  for (const item of items) {
    const row = document.createElement("li");
    row.textContent = item;
    list.appendChild(row);
  }
  section.appendChild(heading);
  section.appendChild(list);
  parent.appendChild(section);
}

/** @param {HTMLElement} parent @param {string} title @param {LinkItem[] | undefined} items */
function appendLinks(parent, title, items) {
  if (!items?.length) return;
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  const list = document.createElement("ul");
  heading.textContent = title;
  for (const item of items) {
    const row = document.createElement("li");
    const link = document.createElement("a");
    link.href = item.url;
    link.textContent = item.label;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    row.appendChild(link);
    list.appendChild(row);
  }
  section.appendChild(heading);
  section.appendChild(list);
  parent.appendChild(section);
}

/** @param {HTMLElement} parent @param {string[] | undefined} items */
function appendConditions(parent, items) {
  if (!items?.length) return;
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  const list = document.createElement("dl");
  heading.textContent = "근무 조건";
  for (const item of items) {
    const separator = item.indexOf(":");
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent =
      separator > 0 ? item.slice(0, separator).trim() : "근무 조건";
    description.textContent =
      separator > 0 ? item.slice(separator + 1).trim() : item;
    row.appendChild(term);
    row.appendChild(description);
    list.appendChild(row);
  }
  section.appendChild(heading);
  section.appendChild(list);
  parent.appendChild(section);
}

/** @param {HTMLElement} parent @param {StatItem[] | undefined} items */
function appendStats(parent, items) {
  if (!items?.length) return;
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  const list = document.createElement("dl");
  heading.textContent = "성과 지표";
  for (const item of items) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = item.label;
    description.textContent = item.value;
    row.appendChild(term);
    row.appendChild(description);
    list.appendChild(row);
  }
  section.appendChild(heading);
  section.appendChild(list);
  parent.appendChild(section);
}

function renderPreview() {
  const draft = buildDraft();
  const header = document.createElement("header");
  const title = document.createElement("h2");
  const company = document.createElement("p");
  const summary = document.createElement("p");
  const facts = document.createElement("dl");
  title.textContent = readString(draft["title"]) || "공고 제목을 입력하세요";
  company.textContent = fieldValue("companyName") || "회사명";
  summary.className = "admin-preview__summary";
  summary.textContent = fieldValue("companySummary");
  /** @type {readonly (readonly [string, string])[]} */
  const factsData = [
    ["직군", readString(draft["category"])],
    ["경력사항", readString(draft["experience"])],
    ["고용형태", readString(draft["employment"])],
    ["근무방식", remoteLabel(readString(draft["remote"]))],
    ["근무지", readString(draft["location"])],
  ];
  for (const [label, value] of factsData) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value || "입력 대기";
    row.appendChild(term);
    row.appendChild(description);
    facts.appendChild(row);
  }
  header.appendChild(title);
  header.appendChild(company);
  if (summary.textContent) header.appendChild(summary);
  header.appendChild(facts);
  preview.replaceChildren(header);
  appendStats(preview, statPairs());
  appendList(preview, "회사 소개", textLines("company"));
  appendLinks(preview, "관련 소식", linkPairs("news"));
  appendList(preview, "주요 업무", textLines("responsibilities"));
  appendList(preview, "지원 자격", textLines("qualifications"));
  appendList(preview, "우대 사항", textLines("preferred"));
  appendList(preview, "복지 및 혜택", textLines("benefits"));
  appendConditions(preview, textLines("conditions"));
  appendList(preview, "채용 절차", textLines("process"));
  appendList(preview, "지원 안내", textLines("notes"));
  appendLinks(preview, "첨부 문서", linkPairs("documents"));
  previewStatus.textContent =
    activeStatus === "closed" || draft["status"] === "closed"
      ? "마감"
      : currentJobId
        ? "저장된 초안"
        : "새 초안";
}

/** @param {string} remote */
function remoteLabel(remote) {
  return remote === "remote"
    ? "원격 근무"
    : remote === "hybrid"
      ? "하이브리드"
      : "출근 근무";
}

function renderAssetList() {
  assetList.replaceChildren();
  if (!currentJobId) return;
  if (!assets.length) {
    const empty = document.createElement("p");
    empty.className = "admin-asset-list__empty";
    empty.textContent = "연결된 초안 자산이 없습니다.";
    assetList.appendChild(empty);
    return;
  }
  for (const asset of assets) {
    const card = document.createElement("article");
    card.className = "admin-asset";
    const heading = document.createElement("h3");
    const meta = document.createElement("p");
    const actions = document.createElement("div");
    heading.textContent = asset.role;
    meta.textContent =
      [asset.mimeType, asset.byteLength ? formatBytes(asset.byteLength) : ""]
        .filter(Boolean)
        .join(" · ") || "보호된 초안 자산";
    const contentUrl = `/api/admin/assets/${encodeURIComponent(asset.assetId)}/content`;
    if (asset.mimeType && imageMimeTypes.has(asset.mimeType)) {
      const image = document.createElement("img");
      image.src = contentUrl;
      image.alt = `${asset.role} 미리보기`;
      image.loading = "lazy";
      card.appendChild(image);
    } else {
      const link = document.createElement("a");
      link.href = contentUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "보호된 파일 미리보기";
      card.appendChild(link);
    }
    const replace = document.createElement("button");
    replace.type = "button";
    replace.className = "action action--secondary";
    replace.dataset["adminAssetReplace"] = asset.assetId;
    replace.dataset["adminAssetRole"] = asset.role;
    replace.textContent = "교체";
    const detach = document.createElement("button");
    detach.type = "button";
    detach.className = "action action--secondary";
    detach.dataset["adminAssetDetach"] = asset.assetId;
    detach.dataset["adminAssetRole"] = asset.role;
    detach.textContent = "연결 해제";
    actions.className = "admin-asset__actions";
    actions.appendChild(replace);
    actions.appendChild(detach);
    card.appendChild(heading);
    card.appendChild(meta);
    card.appendChild(actions);
    assetList.appendChild(card);
  }
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function renderPublishState() {
  publishState.replaceChildren();
  /** @type {readonly (readonly [string, string])[]} */
  const pairs = [
    ["초안 버전", draftVersion ? String(draftVersion) : "불러오는 중"],
    ["공개 세대", String(activeGeneration)],
    ["현재 공개본", activeRevisionId || "아직 공개되지 않음"],
  ];
  for (const [termContent, descriptionContent] of pairs) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = termContent;
    description.textContent = descriptionContent;
    publishState.appendChild(term);
    publishState.appendChild(description);
  }
}

/** @param {string} [retryOf] */
async function saveCompany(retryOf) {
  if (!validateNamedFields(["companyName", "companyWebsite", "companySummary"]))
    return;
  const company = buildCompanySnapshot();
  const label = currentCompanyId ? "회사 정보 저장" : "회사 생성";
  try {
    if (currentCompanyId) {
      if (!currentCompanyVersion) {
        throw new Error(
          "선택한 회사의 버전을 확인할 수 없습니다. 목록을 새로고침해 주세요.",
        );
      }
      await jsonPatch(
        `/api/admin/companies/${encodeURIComponent(currentCompanyId)}`,
        { expectedVersion: currentCompanyVersion, ...company },
        retryOf,
        operationSuccess("COMPANY_UPDATED", "company"),
      );
    } else {
      const result = await jsonMutation(
        "/api/admin/companies",
        company,
        retryOf,
        operationSuccess("COMPANY_CREATED", "company"),
      );
      if (isRecord(result) && isRecord(result["company"])) {
        currentCompanyId = readString(result["company"]["id"]);
      }
    }
    await loadCollections();
    const savedCompany =
      companies.find((item) => item.id === currentCompanyId) ||
      companies.find((item) => item.name === readString(company["name"]));
    if (savedCompany) {
      currentCompanyId = savedCompany.id;
      currentCompanyVersion = savedCompany.version;
      companySelect.value = savedCompany.id;
    }
    clearError();
    setStatus(`${label} 작업이 완료되었습니다.`);
  } catch (error) {
    showRequestError(error, { label, execute: saveCompany });
  }
}

/** @param {string} [retryOf] */
async function saveDraft(retryOf) {
  if (!validateDraft()) return;
  const draft = buildDraft();
  const companySnapshot = buildCompanySnapshot();
  const application = buildApplication();
  const label = currentJobId ? "초안 저장" : "새 공고 생성";
  try {
    if (currentJobId) {
      if (!draftVersion)
        throw new Error(
          "초안 버전을 확인할 수 없습니다. 현재 상태를 불러와 주세요.",
        );
      await jsonPatch(
        `/api/admin/jobs/${encodeURIComponent(currentJobId)}/draft`,
        {
          expectedDraftVersion: draftVersion,
          draft,
          companySnapshot,
          application,
        },
        retryOf,
        operationSuccess("DRAFT_UPDATED", "draft"),
      );
      await loadCurrentJob();
    } else {
      if (!currentCompanyId) {
        showClientError(
          "새 공고를 저장하려면 먼저 회사를 선택하거나 생성해 주세요.",
        );
        companySelect.focus();
        return;
      }
      const result = await jsonMutation(
        "/api/admin/jobs",
        {
          slug: fieldValue("slug"),
          companyId: currentCompanyId,
          draft,
          companySnapshot,
          application,
        },
        retryOf,
        operationSuccess("JOB_CREATED", "job"),
      );
      const job =
        isRecord(result) && isRecord(result["job"]) ? result["job"] : null;
      const createdId = job ? readString(job["id"]) : "";
      await loadCollections();
      currentJobId =
        createdId ||
        jobs.find((item) => item.slug === fieldValue("slug"))?.id ||
        "";
      if (!currentJobId)
        throw new Error("생성된 공고를 다시 불러올 수 없습니다.");
      await loadCurrentJob();
    }
    clearError();
    setStatus(
      `${label} 작업이 완료되었습니다. 공개하려면 아래 공개 작업을 사용해 주세요.`,
    );
  } catch (error) {
    showRequestError(error, { label, execute: saveDraft });
  }
}

/** @param {File} file */
function declaredMimeType(file) {
  if (supportedMimeTypes.has(file.type)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension === "png"
    ? "image/png"
    : extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : extension === "webp"
        ? "image/webp"
        : extension === "pdf"
          ? "application/pdf"
          : "";
}

/** @param {ArrayBuffer} bytes */
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** @param {string} [retryOf] */
async function uploadAsset(retryOf) {
  if (!currentJobId || !draftVersion) {
    showClientError("자산을 업로드하려면 저장된 공고 초안이 필요합니다.");
    return;
  }
  const fileControl = control("assetFile");
  const role = fieldValue("assetRole");
  const file =
    fileControl instanceof HTMLInputElement
      ? fileControl.files?.[0]
      : undefined;
  if (!file || !role) {
    showClientError("자산 역할과 파일을 선택해 주세요.");
    return;
  }
  const mimeType = declaredMimeType(file);
  if (!mimeType) {
    showClientError("PNG, JPEG, WebP 또는 PDF 파일만 업로드할 수 있습니다.");
    return;
  }
  if (
    (imageMimeTypes.has(mimeType) && file.size > maximumImageBytes) ||
    (mimeType === "application/pdf" && file.size > maximumPdfBytes)
  ) {
    showClientError("이미지는 5MB, PDF는 20MB 이하만 업로드할 수 있습니다.");
    return;
  }

  if (replacementAsset) {
    const assetToReplace = replacementAsset;
    replacementAsset = null;
    await detachAsset(assetToReplace);
    if (
      assets.some(
        (asset) =>
          asset.assetId === assetToReplace.assetId &&
          asset.role === assetToReplace.role,
      )
    )
      return;
  }

  const label = "자산 업로드";
  try {
    const bytes = await file.arrayBuffer();
    const sha256Digest = await sha256(bytes);
    const jobId = currentJobId;
    const expectedDraftVersion = draftVersion;
    await executeFreshMutation(() => {
      const idempotencyKey = crypto.randomUUID();
      const data = new FormData();
      data.set("file", file);
      data.set("role", role);
      data.set("expectedDraftVersion", String(expectedDraftVersion));
      data.set("sha256", sha256Digest);
      data.set("mimeType", mimeType);
      data.set("byteLength", String(file.size));
      data.set("idempotencyKey", idempotencyKey);
      if (retryOf) data.set("retryOf", retryOf);
      return createMutationRequest(
        `/api/admin/jobs/${encodeURIComponent(jobId)}/assets`,
        "POST",
        data,
        idempotencyKey,
      );
    }, operationSuccess("ASSET_ATTACHED"));
    if (fileControl instanceof HTMLInputElement) fileControl.value = "";
    await loadCurrentJob();
    clearError();
    setStatus(
      "자산을 초안에 연결했습니다. 공개 전까지 외부에 노출되지 않습니다.",
    );
  } catch (error) {
    showRequestError(error, { label, execute: uploadAsset });
  }
}

/** @param {DraftAsset} asset @param {string} [retryOf] */
async function detachAsset(asset, retryOf) {
  if (!currentJobId || !draftVersion) {
    showClientError("자산 연결을 해제할 현재 초안을 찾을 수 없습니다.");
    return;
  }
  const label = "자산 연결 해제";
  try {
    await jsonDelete(
      `/api/admin/jobs/${encodeURIComponent(currentJobId)}/assets`,
      {
        assetId: asset.assetId,
        role: asset.role,
        expectedDraftVersion: draftVersion,
      },
      retryOf,
      operationSuccess("ASSET_DETACHED"),
    );
    await loadCurrentJob();
    clearError();
    setStatus("자산 연결을 해제했습니다. 원본 파일은 삭제되지 않습니다.");
  } catch (error) {
    showRequestError(error, {
      label,
      execute: async (retryOfValue) => {
        const currentAsset = assets.find(
          (item) => item.assetId === asset.assetId && item.role === asset.role,
        );
        if (!currentAsset) {
          showClientError("해제할 자산 연결이 이미 없거나 바뀌었습니다.");
          return;
        }
        await detachAsset(currentAsset, retryOfValue);
      },
    });
  }
}

/** @param {"publish" | "close" | "rollback"} operation @param {string} [retryOf] */
async function runPublication(operation, retryOf) {
  if (!currentJobId || !draftVersion) {
    showClientError("공개 작업을 하려면 저장된 공고 초안이 필요합니다.");
    return;
  }
  const labels = {
    publish: "초안 공개",
    close: "공고 마감",
    rollback: "공개본 복원",
  };
  const label = labels[operation];
  /** @type {Record<string, unknown>} */
  let payload;
  if (operation === "publish") {
    payload = {
      expectedDraftVersion: draftVersion,
      expectedGeneration: activeGeneration,
    };
  } else if (operation === "close") {
    const closedState = fieldValue("closedState");
    if (!closedState) {
      showClientError("공고를 마감하려면 마감 안내를 입력해 주세요.");
      const field = control("closedState");
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }
    payload = { expectedGeneration: activeGeneration, closedState };
  } else {
    const sourceRevisionId = fieldValue("rollbackRevisionId");
    if (!sourceRevisionId) {
      showClientError("복원할 공개본 ID를 입력해 주세요.");
      const field = control("rollbackRevisionId");
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }
    payload = { expectedGeneration: activeGeneration, sourceRevisionId };
  }

  try {
    const result = await jsonMutation(
      `/api/admin/jobs/${encodeURIComponent(currentJobId)}/${operation}`,
      payload,
      retryOf,
      operationSuccess(
        operation === "publish"
          ? "PUBLISHED"
          : operation === "close"
            ? "CLOSED"
            : "ROLLED_BACK",
        "revision",
      ),
    );
    if (isRecord(result) && isRecord(result["revision"])) {
      activeRevisionId =
        readString(result["revision"]["id"]) || activeRevisionId;
      activeGeneration =
        readPositiveInteger(result["revision"]["activeGeneration"]) ||
        activeGeneration;
      activeStatus = readString(result["revision"]["status"]) || activeStatus;
    }
    await loadCollections();
    await loadCurrentJob();
    clearError();
    setStatus(
      `${label} 작업이 완료되었습니다. 공개 페이지는 최대 10초 안에 새 공개본을 반영합니다.`,
    );
  } catch (error) {
    showRequestError(error, {
      label,
      execute: (retryOfValue) => runPublication(operation, retryOfValue),
    });
  }
}

async function requestServerPreview() {
  if (!currentJobId || !draftVersion) {
    showClientError(
      "서버 미리보기는 먼저 초안을 저장한 뒤 확인할 수 있습니다.",
    );
    return;
  }
  if (!validateDraft()) return;
  try {
    await api(`/api/admin/jobs/${encodeURIComponent(currentJobId)}/preview`, {
      method: "POST",
      body: JSON.stringify({
        expectedDraftVersion: draftVersion,
        draft: buildDraft(),
        companySnapshot: buildCompanySnapshot(),
        application: buildApplication(),
      }),
    });
    clearError();
    setStatus(
      "현재 입력값으로 서버 미리보기를 확인했습니다. 공개하려면 먼저 초안을 저장해 주세요.",
    );
  } catch (error) {
    showRequestError(error);
  }
}

async function reloadCurrentState() {
  try {
    await loadCollections();
    if (currentJobId) await loadCurrentJob();
    else {
      currentCompanyVersion =
        companies.find((company) => company.id === currentCompanyId)?.version ??
        0;
      renderPreview();
    }
    clearError();
    setStatus("현재 저장 상태를 불러왔습니다.");
  } catch (error) {
    showRequestError(error);
  }
}

companySelect.addEventListener("change", () => {
  currentCompanyId = companySelect.value;
  currentCompanyVersion =
    companies.find((company) => company.id === currentCompanyId)?.version ?? 0;
  if (!currentJobId) {
    const company = companies.find((item) => item.id === currentCompanyId);
    if (company) {
      setField("companyName", company.name);
      setField("companyWebsite", company.website);
      setField("companySummary", company.summary);
    }
    renderPreview();
  }
});

jobSelect.addEventListener("change", async () => {
  const id = jobSelect.value;
  if (!id) {
    resetForNewJob();
    setStatus("새 공고 입력을 시작합니다.");
    return;
  }
  currentJobId = id;
  activeStatus = "";
  try {
    await loadCurrentJob();
    clearError();
    setStatus("저장된 초안을 불러왔습니다.");
  } catch (error) {
    showRequestError(error);
  }
});

form.addEventListener("input", () => {
  renderPreview();
});
form.addEventListener("change", (event) => {
  if (event.target === control("applicationKind")) updateApplicationControl();
  renderPreview();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveDraft();
});

document
  .querySelector("[data-admin-company-new]")
  ?.addEventListener("click", () => {
    currentCompanyId = "";
    currentCompanyVersion = 0;
    companySelect.value = "";
    setField("companyName", "");
    setField("companyWebsite", "");
    setField("companySummary", "");
    setField("mapQuery", "");
    renderPreview();
    const field = control("companyName");
    if (field instanceof HTMLInputElement) field.focus();
    setStatus("새 회사 정보를 입력해 주세요.");
  });
document
  .querySelector("[data-admin-company-save]")
  ?.addEventListener("click", async () => {
    await saveCompany();
  });
document
  .querySelector("[data-admin-job-new]")
  ?.addEventListener("click", () => {
    resetForNewJob();
    setStatus("새 공고 입력을 시작합니다.");
    const field = control("slug");
    if (field instanceof HTMLInputElement) field.focus();
  });
document
  .querySelector("[data-admin-reload]")
  ?.addEventListener("click", reloadCurrentState);
document
  .querySelector("[data-admin-preview-check]")
  ?.addEventListener("click", requestServerPreview);
document
  .querySelector("[data-admin-asset-upload]")
  ?.addEventListener("click", async () => {
    await uploadAsset();
  });
document
  .querySelector("[data-admin-publish]")
  ?.addEventListener("click", async () => {
    await runPublication("publish");
  });
document
  .querySelector("[data-admin-close]")
  ?.addEventListener("click", async () => {
    await runPublication("close");
  });
document
  .querySelector("[data-admin-rollback]")
  ?.addEventListener("click", async () => {
    await runPublication("rollback");
  });

assetList.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const assetId =
    target.dataset["adminAssetDetach"] || target.dataset["adminAssetReplace"];
  const role = target.dataset["adminAssetRole"];
  if (!assetId || !role) return;
  const asset = assets.find(
    (item) => item.assetId === assetId && item.role === role,
  );
  if (!asset) return;
  if (target.dataset["adminAssetReplace"]) {
    replacementAsset = asset;
    setField("assetRole", asset.role);
    const input = control("assetFile");
    if (input instanceof HTMLInputElement) input.focus();
    setStatus(
      "교체할 파일을 선택한 뒤 자산 업로드를 누르면 기존 연결을 해제하고 새 파일을 연결합니다.",
    );
    return;
  }
  await detachAsset(asset);
});

retryReload.addEventListener("click", async () => {
  const action = mutationCoordinator.recoveryAction();
  if (!action || action.kind === "replay") return;
  try {
    await loadCollections();
    if (currentJobId) await loadCurrentJob();
    const refreshedAction = mutationCoordinator.markRecoveryReloaded();
    if (!refreshedAction) return;
    renderRecoveryAction(refreshedAction);
    setStatus("현재 상태를 불러왔습니다. 재시도 전 입력값을 확인해 주세요.");
  } catch (error) {
    showRequestError(error);
  }
});
retrySubmit.addEventListener("click", async () => {
  const action = mutationCoordinator.recoveryAction();
  if (!action) return;
  if (action.kind !== "replay" && !action.reloaded) return;
  try {
    if (action.kind === "replay") {
      await action.execute();
      return;
    }
    const permit = mutationCoordinator.resubmissionPermit();
    if (!permit) return;
    resubmissionPermit = permit;
    await action.execute(action.operationId);
  } catch (error) {
    showRequestError(error);
  } finally {
    resubmissionPermit = null;
  }
});

async function initialize() {
  try {
    await loadSession();
    await loadCollections();
    resetForNewJob();
    clearError();
    setStatus("회사를 선택하거나 생성한 뒤 새 공고 초안을 작성해 주세요.");
  } catch (error) {
    showRequestError(error);
    setStatus("관리자 세션 또는 목록을 불러올 수 없습니다.");
  }
}

void initialize();
