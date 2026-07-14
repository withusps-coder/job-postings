export const CSRF_TOKEN_LIFETIME_SECONDS = 10 * 60;
export const ADMIN_MUTATION_METHOD_SCOPE = "ADMIN_MUTATION";
export const ADMIN_MUTATION_PATH_SCOPE = "/api/admin";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const csrfSecretName = "CSRF_SIGNING_SECRET";

/**
 * @typedef {Object} CsrfBinding
 * @property {string} subject
 * @property {string} method
 * @property {string} path
 */

/**
 * @typedef {Object} CsrfPayload
 * @property {1} v
 * @property {string} sub
 * @property {string} method
 * @property {string} path
 * @property {number} iat
 * @property {number} exp
 * @property {string} nonce
 */
/**
 * @typedef {Object} AdminBodyPolicy
 * @property {number} maximumBytes
 * @property {"application/json" | "multipart/form-data"} contentType
 */

/**
 * @param {Record<string, unknown>} env
 * @returns {string}
 */
export function getCsrfSigningSecret(env) {
  const secret = env[csrfSecretName];
  if (typeof secret !== "string" || !isValidCsrfSecret(secret)) {
    throw new TypeError("CSRF signing secret is not configured");
  }
  return secret;
}

/**
 * Issues a signed CSRF token with a maximum ten-minute lifetime.
 *
 * @param {CsrfBinding & { secret: string, now?: number }} options
 * @returns {Promise<{ token: string, expiresAt: string }>}
 */
export async function issueCsrfToken(options) {
  const { subject, method, path, secret } = options;
  assertBinding({ subject, method, path });
  const secretBytes = decodeCsrfSecret(secret);
  if (!secretBytes) throw new TypeError("CSRF signing secret is invalid");

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const expiresAt = nowSeconds + CSRF_TOKEN_LIFETIME_SECONDS;
  const payload = encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        v: 1,
        sub: subject,
        method,
        path,
        iat: nowSeconds,
        exp: expiresAt,
        nonce: createNonce(),
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importSigningKey(secretBytes, ["sign"]),
    encoder.encode(payload),
  );

  return {
    token: `${payload}.${encodeBase64Url(new Uint8Array(signature))}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

/**
 * Verifies a CSRF token against its exact subject, method, and path binding.
 *
 * @param {string | null} token
 * @param {CsrfBinding & { secret: string, now?: number }} options
 * @returns {Promise<boolean>}
 */
export async function verifyCsrfToken(token, options) {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return false;
  }

  const secretBytes = decodeCsrfSecret(options.secret);
  if (!secretBytes) throw new TypeError("CSRF signing secret is invalid");

  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) return false;

  const payloadBytes = decodeBase64Url(segments[0]);
  const signature = decodeBase64Url(segments[1]);
  if (!payloadBytes || !signature || signature.byteLength !== 32) return false;

  const validSignature = await crypto.subtle.verify(
    "HMAC",
    await importSigningKey(secretBytes, ["verify"]),
    toBufferSource(signature),
    toBufferSource(encoder.encode(segments[0])),
  );
  if (!validSignature) return false;

  let payload;
  try {
    payload = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return false;
  }

  if (!isCsrfPayload(payload)) return false;

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  return (
    payload.sub === options.subject &&
    payload.method === options.method &&
    payload.path === options.path &&
    payload.iat <= nowSeconds &&
    payload.exp > nowSeconds &&
    payload.exp - payload.iat <= CSRF_TOKEN_LIFETIME_SECONDS
  );
}

/**
 * Issues the admin mutation-family token returned from the session endpoint.
 * The token cannot be used outside the protected admin mutation family.
 *
 * @param {{ subject: string, secret: string, now?: number }} options
 * @returns {Promise<{ token: string, expiresAt: string }>}
 */
export function issueAdminCsrfToken(options) {
  return issueCsrfToken({
    ...options,
    method: ADMIN_MUTATION_METHOD_SCOPE,
    path: ADMIN_MUTATION_PATH_SCOPE,
  });
}

/**
 * @param {string | null} token
 * @param {{ subject: string, secret: string, now?: number }} options
 * @returns {Promise<boolean>}
 */
export function verifyAdminCsrfToken(token, options) {
  return verifyCsrfToken(token, {
    ...options,
    method: ADMIN_MUTATION_METHOD_SCOPE,
    path: ADMIN_MUTATION_PATH_SCOPE,
  });
}

/**
 * @param {Request} request
 * @returns {AdminBodyPolicy}
 */
export function getAdminBodyPolicy(request) {
  const pathname = new URL(request.url).pathname;
  if (
    request.method === "POST" &&
    /^\/api\/admin\/jobs\/[^/]+\/assets$/u.test(pathname)
  ) {
    return {
      maximumBytes: 20 * 1024 * 1024,
      contentType: "multipart/form-data",
    };
  }

  if (
    /^\/api\/admin\/jobs\/[^/]+\/(?:draft|preview)$/u.test(pathname) &&
    (request.method === "PATCH" || request.method === "POST")
  ) {
    return {
      maximumBytes: 256 * 1024,
      contentType: "application/json",
    };
  }

  return {
    maximumBytes: 16 * 1024,
    contentType: "application/json",
  };
}

/**
 * Checks content type and body length without parsing the request body.
 *
 * @param {Request} request
 * @param {AdminBodyPolicy} policy
 * @returns {Promise<"BODY_TOO_LARGE" | "INVALID_REQUEST" | "UNSUPPORTED_MEDIA_TYPE" | null>}
 */
export async function validateAdminBodyEnvelope(request, policy) {
  if (
    !hasExpectedContentType(
      request.headers.get("content-type"),
      policy.contentType,
    )
  ) {
    return "UNSUPPORTED_MEDIA_TYPE";
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) return "INVALID_REQUEST";
    if (Number(contentLength) > policy.maximumBytes) return "BODY_TOO_LARGE";
  }

  try {
    return (await requestBodyExceedsLimit(request, policy.maximumBytes))
      ? "BODY_TOO_LARGE"
      : null;
  } catch {
    return "BODY_TOO_LARGE";
  }
}

/**
 * Reads a request body with a hard byte limit. Route handlers must use this
 * before JSON or multipart parsing when they consume the original stream.
 *
 * @param {Request} request
 * @param {number} maximumBytes
 * @returns {Promise<Uint8Array>}
 */
export async function readBoundedBody(request, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("Invalid body size limit");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) throw new TypeError("INVALID_REQUEST");
    if (Number(contentLength) > maximumBytes)
      throw new RangeError("BODY_TOO_LARGE");
  }

  const body = request.body;
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        void reader.cancel();
        throw new RangeError("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * @param {Request} request
 * @param {number} maximumBytes
 * @returns {Promise<boolean>}
 */
async function requestBodyExceedsLimit(request, maximumBytes) {
  const body = request.clone().body;
  if (!body) return false;

  const reader = body.getReader();
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        void reader.cancel();
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * @param {string | null} value
 * @param {AdminBodyPolicy["contentType"]} expectedType
 * @returns {boolean}
 */
function hasExpectedContentType(value, expectedType) {
  if (!value) return false;
  const [mediaType, ...parameters] = value.split(";");
  if (mediaType?.trim().toLowerCase() !== expectedType) return false;
  if (expectedType !== "multipart/form-data") return true;

  return parameters.some((parameter) =>
    /^\s*boundary=(?:[^\s;]+|"[^"]+")\s*$/u.test(parameter),
  );
}

/** @param {CsrfBinding} binding */
function assertBinding(binding) {
  if (
    typeof binding.subject !== "string" ||
    binding.subject.length === 0 ||
    typeof binding.method !== "string" ||
    binding.method.length === 0 ||
    typeof binding.path !== "string" ||
    !binding.path.startsWith("/")
  ) {
    throw new TypeError("Invalid CSRF binding");
  }
}

/** @returns {string} */
function createNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/**
 * @param {unknown} payload
 * @returns {payload is CsrfPayload}
 */
function isCsrfPayload(payload) {
  return (
    isRecord(payload) &&
    payload["v"] === 1 &&
    typeof payload["sub"] === "string" &&
    payload["sub"].length > 0 &&
    typeof payload["method"] === "string" &&
    payload["method"].length > 0 &&
    typeof payload["path"] === "string" &&
    payload["path"].startsWith("/") &&
    typeof payload["iat"] === "number" &&
    Number.isSafeInteger(payload["iat"]) &&
    typeof payload["exp"] === "number" &&
    Number.isSafeInteger(payload["exp"]) &&
    typeof payload["nonce"] === "string" &&
    /^[A-Za-z0-9_-]{22}$/u.test(payload["nonce"])
  );
}

/** @param {string} secret @returns {boolean} */
function isValidCsrfSecret(secret) {
  return (
    /^[A-Za-z0-9_-]{43}$/u.test(secret) && decodeCsrfSecret(secret) !== null
  );
}

/** @param {string} secret @returns {Uint8Array | null} */
function decodeCsrfSecret(secret) {
  const bytes = decodeBase64Url(secret);
  return bytes && bytes.byteLength === 32 ? bytes : null;
}

/**
 * @param {Uint8Array} secret
 * @param {KeyUsage[]} usages
 * @returns {Promise<CryptoKey>}
 */
function importSigningKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    toBufferSource(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}
/**
 * @param {Uint8Array} bytes
 * @returns {BufferSource}
 */
function toBufferSource(bytes) {
  return /** @type {BufferSource} */ (bytes);
}

/** @param {Uint8Array} bytes @returns {string} */
function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** @param {string} value @returns {Uint8Array | null} */
function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;

  try {
    const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
      (4 - (value.length % 4)) % 4,
    )}`;
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
