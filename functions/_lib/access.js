import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";

const accessAssertionHeader = "cf-access-jwt-assertion";
const jwksCacheLifetimeMilliseconds = 5 * 60 * 1000;
const accessSigningAlgorithm = "RS256";

/**
 * @typedef {JsonWebKey & {
 *   kid: string,
 *   kty: "RSA",
 *   n: string,
 *   e: string,
 *   alg?: "RS256",
 *   use?: "sig"
 * }} AccessJwk
 *
 * @typedef {{ keys: unknown[] }} AccessJwksDocument
 *
 * @typedef {{
 *   sub: string,
 *   email: string,
 *   aud: string | string[],
 *   iat: number,
 *   nbf: number,
 *   exp: number
 * }} AccessAssertionClaims
 */
/** @type {Map<string, { expiresAt: number, keys: Map<string, AccessJwk> }>} */
const jwksCache = new Map();

/**
 * @typedef {Object} AdminSecurityConfig
 * @property {"production" | "staging"} environment
 * @property {string} canonicalHost
 * @property {string} canonicalOrigin
 * @property {string} issuer
 * @property {string} audience
 * @property {string} administratorEmail
 * @property {URL} jwksUrl
 */

/**
 * @typedef {Object} VerifiedAdmin
 * @property {string} subject
 * @property {string} email
 * @property {number} issuedAt
 * @property {number} expiresAt
 */

/**
 * @typedef {Object} AccessAuthenticationSuccess
 * @property {true} ok
 * @property {AdminSecurityConfig} config
 * @property {VerifiedAdmin} admin
 */

/**
 * @typedef {Object} AccessAuthenticationFailure
 * @property {false} ok
 * @property {"ACCESS_INVALID" | "NON_CANONICAL_HOST" | "ADMIN_UNAVAILABLE"} code
 */

/**
 * @param {Record<string, unknown>} env
 * @returns {AdminSecurityConfig}
 */
export function getAdminSecurityConfig(env) {
  const environment = requiredEnvironment(env, "DEPLOYMENT_ENVIRONMENT");
  const prefix = environment === "production" ? "PUBLIC" : "STAGING";
  const canonicalHost = requiredCanonicalHost(env, `${prefix}_CANONICAL_HOST`);
  const canonicalOrigin = requiredCanonicalOrigin(
    env,
    `${prefix}_CANONICAL_ORIGIN`,
    canonicalHost,
  );
  const issuer = requiredIssuer(env, `${prefix}_ACCESS_ISSUER`);

  return {
    environment,
    canonicalHost,
    canonicalOrigin,
    issuer,
    audience: requiredOpaqueValue(env, `${prefix}_ACCESS_AUDIENCE`),
    administratorEmail: requiredEmail(env, `${prefix}_ADMIN_EMAIL`),
    jwksUrl: new URL(`${issuer}/cdn-cgi/access/certs`),
  };
}

/**
 * Verifies the canonical request host and Cloudflare Access assertion.
 *
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @param {{ fetchImpl?: typeof fetch, now?: number }} [options]
 * @returns {Promise<AccessAuthenticationSuccess | AccessAuthenticationFailure>}
 */
export async function authenticateAdminRequest(request, env, options = {}) {
  let config;
  try {
    config = getAdminSecurityConfig(env);
  } catch {
    return { ok: false, code: "ADMIN_UNAVAILABLE" };
  }

  if (!hasCanonicalRequestHost(request, config)) {
    return { ok: false, code: "NON_CANONICAL_HOST" };
  }

  try {
    const admin = await verifyAccessAssertion(
      request.headers.get(accessAssertionHeader),
      config,
      options,
    );
    return { ok: true, config, admin };
  } catch {
    return { ok: false, code: "ACCESS_INVALID" };
  }
}

/**
 * Verifies a Cloudflare Access JWT with a cached, rotation-safe JWKS lookup.
 *
 * @param {string | null} assertion
 * @param {AdminSecurityConfig} config
 * @param {{ fetchImpl?: typeof fetch, now?: number }} [options]
 * @returns {Promise<VerifiedAdmin>}
 */
export async function verifyAccessAssertion(assertion, config, options = {}) {
  if (!assertion) throw new TypeError("Missing Access assertion");

  const header = decodeProtectedHeader(assertion);
  if (
    header.alg !== accessSigningAlgorithm ||
    typeof header.kid !== "string" ||
    header.kid.length === 0
  ) {
    throw new TypeError("Invalid Access assertion header");
  }

  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const verificationKey = await getVerificationKey(
    config,
    header.kid,
    fetchImpl,
    now,
  );
  const verified = await jwtVerify(assertion, verificationKey, {
    algorithms: [accessSigningAlgorithm],
    issuer: config.issuer,
    audience: config.audience,
    requiredClaims: ["sub", "email", "aud", "exp", "nbf", "iat"],
    currentDate: new Date(now),
  });
  const { payload } = verified;
  const nowSeconds = Math.floor(now / 1000);

  if (!isAccessAssertionClaims(payload, config, nowSeconds)) {
    throw new TypeError("Invalid Access assertion claims");
  }

  return {
    subject: payload.sub,
    email: payload.email,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

/**
 * Clears cached JWKS keys. This is useful for isolate lifecycle tests and does
 * not alter any remote key material.
 */
export function clearAccessJwksCache() {
  jwksCache.clear();
}

/**
 * @param {Request} request
 * @param {AdminSecurityConfig} config
 * @returns {boolean}
 */
export function hasCanonicalRequestHost(request, config) {
  let requestUrl;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }

  if (
    requestUrl.protocol !== "https:" ||
    requestUrl.host !== config.canonicalHost ||
    request.headers.get("host") !== config.canonicalHost
  ) {
    return false;
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost !== null && forwardedHost !== config.canonicalHost) {
    return false;
  }

  return forwardedHostsMatch(
    request.headers.get("forwarded"),
    config.canonicalHost,
  );
}

/**
 * @param {AdminSecurityConfig} config
 * @param {string} kid
 * @param {typeof fetch} fetchImpl
 * @param {number} now
 * @returns {Promise<CryptoKey>}
 */
async function getVerificationKey(config, kid, fetchImpl, now) {
  const cacheKey = `${config.issuer}\u0000${config.jwksUrl.href}`;
  let entry = jwksCache.get(cacheKey);
  let fetchedCurrentKeys = false;

  if (!entry || entry.expiresAt <= now) {
    entry = await fetchJwks(config, fetchImpl, now);
    jwksCache.set(cacheKey, entry);
    fetchedCurrentKeys = true;
  }

  let jwk = entry.keys.get(kid);
  if (!jwk && !fetchedCurrentKeys) {
    entry = await fetchJwks(config, fetchImpl, now);
    jwksCache.set(cacheKey, entry);
    jwk = entry.keys.get(kid);
  }

  if (!jwk) throw new TypeError("Unknown Access key identifier");

  const key = await importJWK(jwk, accessSigningAlgorithm);
  if (!(key instanceof CryptoKey))
    throw new TypeError("Invalid Access verification key");
  return key;
}

/**
 * @param {AdminSecurityConfig} config
 * @param {typeof fetch} fetchImpl
 * @param {number} now
 * @returns {Promise<{ expiresAt: number, keys: Map<string, AccessJwk> }>}
 */
async function fetchJwks(config, fetchImpl, now) {
  const response = await fetchImpl(config.jwksUrl, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new TypeError("Access JWKS request failed");

  const body = await response.json();
  if (!isAccessJwksDocument(body)) {
    throw new TypeError("Access JWKS response is invalid");
  }

  /** @type {Map<string, AccessJwk>} */
  const keys = new Map();
  for (const candidate of body.keys) {
    if (!isUsableAccessJwk(candidate) || keys.has(candidate.kid)) {
      throw new TypeError("Access JWKS key is invalid");
    }
    keys.set(candidate.kid, candidate);
  }

  if (keys.size === 0) throw new TypeError("Access JWKS has no usable keys");

  return {
    expiresAt: now + jwksCacheLifetimeMilliseconds,
    keys,
  };
}

/**
 * @param {unknown} candidate
 * @returns {candidate is AccessJwksDocument}
 */
function isAccessJwksDocument(candidate) {
  return isRecord(candidate) && Array.isArray(candidate["keys"]);
}

/**
 * @param {unknown} candidate
 * @returns {candidate is AccessJwk}
 */
function isUsableAccessJwk(candidate) {
  return (
    isRecord(candidate) &&
    candidate["kty"] === "RSA" &&
    typeof candidate["kid"] === "string" &&
    candidate["kid"].length > 0 &&
    typeof candidate["n"] === "string" &&
    typeof candidate["e"] === "string" &&
    (candidate["alg"] === undefined ||
      candidate["alg"] === accessSigningAlgorithm) &&
    (candidate["use"] === undefined || candidate["use"] === "sig")
  );
}

/**
 * @param {Record<string, unknown>} payload
 * @param {AdminSecurityConfig} config
 * @param {number} nowSeconds
 * @returns {payload is AccessAssertionClaims}
 */
function isAccessAssertionClaims(payload, config, nowSeconds) {
  return (
    typeof payload["sub"] === "string" &&
    payload["sub"].length > 0 &&
    typeof payload["email"] === "string" &&
    payload["email"] === config.administratorEmail &&
    hasExactAudience(payload["aud"], config.audience) &&
    isValidJwtTime(payload["iat"]) &&
    isValidJwtTime(payload["nbf"]) &&
    isValidJwtTime(payload["exp"]) &&
    payload["iat"] <= nowSeconds &&
    payload["nbf"] <= nowSeconds &&
    payload["exp"] > nowSeconds &&
    payload["iat"] <= payload["exp"] &&
    payload["nbf"] <= payload["exp"]
  );
}
/**
 * @param {Record<string, unknown>} env
 * @param {string} name
 * @returns {"production" | "staging"}
 */
function requiredEnvironment(env, name) {
  const value = requiredString(env, name);
  if (value !== "production" && value !== "staging") {
    throw new TypeError("Invalid deployment environment");
  }
  return value;
}

/**
 * @param {Record<string, unknown>} env
 * @param {string} name
 * @returns {string}
 */
function requiredCanonicalHost(env, name) {
  const value = requiredString(env, name);
  if (
    value !== value.toLowerCase() ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
      value,
    )
  ) {
    throw new TypeError("Invalid canonical host");
  }
  return value;
}

/**
 * @param {Record<string, unknown>} env
 * @param {string} name
 * @param {string} host
 * @returns {string}
 */
function requiredCanonicalOrigin(env, name, host) {
  const value = requiredString(env, name);
  if (value !== `https://${host}`) {
    throw new TypeError("Invalid canonical origin");
  }
  return value;
}

/**
 * @param {Record<string, unknown>} env
 * @param {string} name
 * @returns {string}
 */
function requiredIssuer(env, name) {
  const value = requiredString(env, name);
  let issuer;
  try {
    issuer = new URL(value);
  } catch {
    throw new TypeError("Invalid Access issuer");
  }

  if (
    value !== issuer.origin ||
    issuer.protocol !== "https:" ||
    !issuer.hostname.endsWith(".cloudflareaccess.com")
  ) {
    throw new TypeError("Invalid Access issuer");
  }
  return value;
}

/**
 * @param {Record<string, unknown>} env
 * @param {string} name
 * @returns {string}
 */
function requiredEmail(env, name) {
  const value = requiredString(env, name);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value)) {
    throw new TypeError("Invalid administrator email");
  }
  return value;
}

/**
 * @param {Record<string, unknown>} env
 * @param {string} name
 * @returns {string}
 */
function requiredOpaqueValue(env, name) {
  const value = requiredString(env, name);
  if (/\s/u.test(value)) throw new TypeError("Invalid Access audience");
  return value;
}

/**
 * @param {Record<string, unknown>} env
 * @param {string} name
 * @returns {string}
 */
function requiredString(env, name) {
  const value = env[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new TypeError(`Missing or invalid ${name}`);
  }
  return value;
}

/**
 * @param {string | null} forwarded
 * @param {string} canonicalHost
 * @returns {boolean}
 */
function forwardedHostsMatch(forwarded, canonicalHost) {
  if (forwarded === null) return true;

  for (const element of forwarded.split(",")) {
    for (const parameter of element.split(";")) {
      const separator = parameter.indexOf("=");
      if (separator === -1) continue;
      const name = parameter.slice(0, separator).trim().toLowerCase();
      if (name !== "host") continue;

      const rawValue = parameter.slice(separator + 1).trim();
      const host =
        rawValue.startsWith('"') && rawValue.endsWith('"')
          ? rawValue.slice(1, -1)
          : rawValue;
      if (host !== canonicalHost) return false;
    }
  }

  return true;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/** @param {unknown} audience @param {string} expected @returns {boolean} */
function hasExactAudience(audience, expected) {
  return (
    audience === expected ||
    (Array.isArray(audience) &&
      audience.length === 1 &&
      audience[0] === expected)
  );
}
/** @param {unknown} value @returns {value is number} */
function isValidJwtTime(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
