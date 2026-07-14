import assert from "node:assert/strict";
import test from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  authenticateAdminRequest,
  clearAccessJwksCache,
  getAdminSecurityConfig,
  hasCanonicalRequestHost,
  verifyAccessAssertion,
} from "../functions/_lib/access.js";
import {
  CSRF_TOKEN_LIFETIME_SECONDS,
  issueAdminCsrfToken,
  issueCsrfToken,
  verifyAdminCsrfToken,
  verifyCsrfToken,
} from "../functions/_lib/csrf.js";
import { onRequest as onAdminMiddleware } from "../functions/api/admin/_middleware.js";
import { onRequestGet as onAdminSessionGet } from "../functions/api/admin/session.js";
import { onRequest as onAdminDocument } from "../functions/admin/[[path]].js";

/** @typedef {Parameters<typeof onAdminMiddleware>[0]} AdminMiddlewareContext */
/** @typedef {Parameters<typeof onAdminSessionGet>[0]} AdminSessionContext */
/** @typedef {Parameters<typeof onAdminDocument>[0]} AdminDocumentContext */

const productionHost = "admin.example.test";
const stagingHost = "admin-staging.example.test";
const productionOrigin = `https://${productionHost}`;
const stagingOrigin = `https://${stagingHost}`;
const administratorEmail = "admin@example.test";
const administratorSubject = "access-subject";

/**
 * @typedef {Object} AccessAssertionOptions
 * @property {string} [subject]
 * @property {string} [email]
 * @property {string} [issuer]
 * @property {string | string[]} [audience]
 * @property {number} [issuedAt]
 * @property {number} [notBefore]
 * @property {number} [expiresAt]
 */

/** @returns {string} */
function createCsrfSecret() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
}

/**
 * @param {{ issuer: string, csrfSecret: string, environment?: "production" | "staging" }} options
 * @returns {Record<string, unknown>}
 */
function createAdminEnvironment(options) {
  return {
    DEPLOYMENT_ENVIRONMENT: options.environment ?? "production",
    PUBLIC_CANONICAL_HOST: productionHost,
    PUBLIC_CANONICAL_ORIGIN: productionOrigin,
    PUBLIC_ACCESS_ISSUER: options.issuer,
    PUBLIC_ACCESS_AUDIENCE: "production-access-audience",
    PUBLIC_ADMIN_EMAIL: administratorEmail,
    STAGING_CANONICAL_HOST: stagingHost,
    STAGING_CANONICAL_ORIGIN: stagingOrigin,
    STAGING_ACCESS_ISSUER: "https://staging.cloudflareaccess.com",
    STAGING_ACCESS_AUDIENCE: "staging-access-audience",
    STAGING_ADMIN_EMAIL: "staging-admin@example.test",
    CSRF_SIGNING_SECRET: options.csrfSecret,
  };
}

/**
 * @param {CryptoKey} privateKey
 * @param {string} kid
 * @param {AccessAssertionOptions} [options]
 * @returns {Promise<string>}
 */
async function createAccessAssertion(privateKey, kid, options = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: options.email ?? administratorEmail })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject(options.subject ?? administratorSubject)
    .setIssuer(options.issuer ?? "https://access.cloudflareaccess.com")
    .setAudience(options.audience ?? "production-access-audience")
    .setIssuedAt(options.issuedAt ?? nowSeconds - 1)
    .setNotBefore(options.notBefore ?? nowSeconds - 1)
    .setExpirationTime(options.expiresAt ?? nowSeconds + 5 * 60)
    .sign(privateKey);
}

/**
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @param {AdminMiddlewareContext["next"]} next
 * @returns {AdminMiddlewareContext}
 */
function createMiddlewareContext(request, env, next) {
  return /** @type {AdminMiddlewareContext} */ (
    /** @type {unknown} */ ({
      request,
      functionPath: "/api/admin",
      waitUntil(/** @type {Promise<unknown>} */ promise) {
        void promise;
      },
      passThroughOnException() {},
      next,
      env,
      params: {},
      data: {},
    })
  );
}

/**
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @returns {AdminSessionContext}
 */
function createSessionContext(request, env) {
  return /** @type {AdminSessionContext} */ (
    /** @type {unknown} */ ({
      request,
      functionPath: "/api/admin/session",
      waitUntil(/** @type {Promise<unknown>} */ promise) {
        void promise;
      },
      passThroughOnException() {},
      async next() {
        return new Response(null, { status: 404 });
      },
      env,
      params: {},
      data: undefined,
    })
  );
}

/**
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @param {() => Promise<Response>} handler
 * @returns {Promise<{ response: Response, nextCalls: number, context: AdminMiddlewareContext }>}
 */
async function runAdminMiddleware(request, env, handler) {
  let nextCalls = 0;
  const context = createMiddlewareContext(request, env, async () => {
    nextCalls += 1;
    return handler();
  });
  const response = await onAdminMiddleware(context);
  return { response, nextCalls, context };
}

/**
 * @param {string} path
 * @param {string} assertion
 * @param {RequestInit} [init]
 * @returns {Request}
 */
function adminRequest(path, assertion, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", productionHost);
  headers.set("cf-access-jwt-assertion", assertion);
  return new Request(`${productionOrigin}${path}`, { ...init, headers });
}

/**
 * @param {Response} response
 * @param {string} code
 * @param {number} status
 * @returns {Promise<void>}
 */
async function assertAdminError(response, code, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.json();
  assert.equal(body.code, code);
}

test("Given Cloudflare Access assertions, when verifying admin access, then RS256 claims, host selection, and key rotation fail closed", async () => {
  clearAccessJwksCache();
  const issuer = "https://access.cloudflareaccess.com";
  const csrfSecret = createCsrfSecret();
  const env = createAdminEnvironment({ issuer, csrfSecret });
  const stagingEnv = createAdminEnvironment({
    issuer,
    csrfSecret,
    environment: "staging",
  });
  const productionConfig = getAdminSecurityConfig(env);
  const stagingConfig = getAdminSecurityConfig(stagingEnv);

  assert.deepEqual(
    {
      environment: productionConfig.environment,
      host: productionConfig.canonicalHost,
      origin: productionConfig.canonicalOrigin,
      audience: productionConfig.audience,
    },
    {
      environment: "production",
      host: productionHost,
      origin: productionOrigin,
      audience: "production-access-audience",
    },
  );
  assert.deepEqual(
    {
      environment: stagingConfig.environment,
      host: stagingConfig.canonicalHost,
      origin: stagingConfig.canonicalOrigin,
      audience: stagingConfig.audience,
    },
    {
      environment: "staging",
      host: stagingHost,
      origin: stagingOrigin,
      audience: "staging-access-audience",
    },
  );
  assert.equal(
    hasCanonicalRequestHost(
      new Request(`${productionOrigin}/api/admin`, {
        headers: { host: productionHost },
      }),
      productionConfig,
    ),
    true,
  );
  assert.equal(
    hasCanonicalRequestHost(
      new Request(`${productionOrigin}/api/admin`, {
        headers: { host: productionHost },
      }),
      stagingConfig,
    ),
    false,
  );
  assert.equal(
    hasCanonicalRequestHost(
      new Request(`${stagingOrigin}/api/admin`, {
        headers: { host: stagingHost },
      }),
      stagingConfig,
    ),
    true,
  );

  const firstPair = await generateKeyPair("RS256");
  const secondPair = await generateKeyPair("RS256");
  const firstKey = {
    ...(await exportJWK(firstPair.publicKey)),
    kid: "first-key",
    alg: "RS256",
    use: "sig",
  };
  const secondKey = {
    ...(await exportJWK(secondPair.publicKey)),
    kid: "rotated-key",
    alg: "RS256",
    use: "sig",
  };
  const firstAssertion = await createAccessAssertion(
    firstPair.privateKey,
    firstKey.kid,
  );
  const rotatedAssertion = await createAccessAssertion(
    secondPair.privateKey,
    secondKey.kid,
  );
  const now = Date.now();
  const documents = [{ keys: [firstKey] }, { keys: [secondKey] }];
  let fetchCalls = 0;
  /** @type {typeof fetch} */
  const fetchJwks = async (input, init) => {
    assert.equal(String(input), productionConfig.jwksUrl.href);
    assert.equal(init?.cache, "no-store");
    const document = documents[fetchCalls];
    assert.ok(document);
    fetchCalls += 1;
    return Response.json(document);
  };

  const authenticated = await authenticateAdminRequest(
    adminRequest("/api/admin/session", firstAssertion),
    env,
    { fetchImpl: fetchJwks, now },
  );
  assert.deepEqual(authenticated, {
    ok: true,
    config: productionConfig,
    admin: {
      subject: administratorSubject,
      email: administratorEmail,
      issuedAt: Math.floor(now / 1000) - 1,
      expiresAt: Math.floor(now / 1000) + 5 * 60,
    },
  });

  const rotatedAdmin = await verifyAccessAssertion(
    rotatedAssertion,
    productionConfig,
    { fetchImpl: fetchJwks, now },
  );
  assert.equal(rotatedAdmin.subject, administratorSubject);
  assert.equal(fetchCalls, 2);

  const missing = await authenticateAdminRequest(
    new Request(`${productionOrigin}/api/admin`, {
      headers: { host: productionHost },
    }),
    env,
    { fetchImpl: fetchJwks, now },
  );
  assert.deepEqual(missing, { ok: false, code: "ACCESS_INVALID" });

  const nowSeconds = Math.floor(now / 1000);
  const denials = await Promise.all([
    createAccessAssertion(secondPair.privateKey, secondKey.kid, {
      expiresAt: nowSeconds - 1,
      issuedAt: nowSeconds - 60,
      notBefore: nowSeconds - 60,
    }),
    createAccessAssertion(secondPair.privateKey, secondKey.kid, {
      issuer: "https://wrong.cloudflareaccess.com",
    }),
    createAccessAssertion(secondPair.privateKey, secondKey.kid, {
      audience: "unexpected-audience",
    }),
    createAccessAssertion(secondPair.privateKey, secondKey.kid, {
      email: "not-an-administrator@example.test",
    }),
  ]);
  for (const assertion of denials) {
    const result = await authenticateAdminRequest(
      adminRequest("/api/admin", assertion),
      env,
      { fetchImpl: fetchJwks, now },
    );
    assert.deepEqual(result, { ok: false, code: "ACCESS_INVALID" });
  }
  assert.equal(fetchCalls, 2);
});

test("Given signed CSRF state, when its subject, method, path, or lifetime changes, then it cannot authorize a mutation", async () => {
  const secret = createCsrfSecret();
  const issuedAt = 1_700_000_000_000;
  const csrf = await issueCsrfToken({
    subject: administratorSubject,
    method: "PATCH",
    path: "/api/admin/jobs/job-1/draft",
    secret,
    now: issuedAt,
  });

  assert.equal(
    await verifyCsrfToken(csrf.token, {
      subject: administratorSubject,
      method: "PATCH",
      path: "/api/admin/jobs/job-1/draft",
      secret,
      now: issuedAt + 1_000,
    }),
    true,
  );
  for (const binding of [
    {
      subject: "other-subject",
      method: "PATCH",
      path: "/api/admin/jobs/job-1/draft",
    },
    {
      subject: administratorSubject,
      method: "POST",
      path: "/api/admin/jobs/job-1/draft",
    },
    {
      subject: administratorSubject,
      method: "PATCH",
      path: "/api/admin/jobs/job-2/draft",
    },
  ]) {
    assert.equal(
      await verifyCsrfToken(csrf.token, {
        ...binding,
        secret,
        now: issuedAt + 1_000,
      }),
      false,
    );
  }
  assert.equal(
    await verifyCsrfToken(csrf.token, {
      subject: administratorSubject,
      method: "PATCH",
      path: "/api/admin/jobs/job-1/draft",
      secret,
      now: issuedAt + (CSRF_TOKEN_LIFETIME_SECONDS + 1) * 1_000,
    }),
    false,
  );
});

test("Given admin routes, when session and middleware process requests, then exact paths and mutation guards reject before handlers without CORS", async () => {
  clearAccessJwksCache();
  const issuer = "https://access.cloudflareaccess.com";
  const csrfSecret = createCsrfSecret();
  const env = createAdminEnvironment({ issuer, csrfSecret });
  const config = getAdminSecurityConfig(env);
  const pair = await generateKeyPair("RS256");
  const key = {
    ...(await exportJWK(pair.publicKey)),
    kid: "middleware-key",
    alg: "RS256",
    use: "sig",
  };
  const assertion = await createAccessAssertion(pair.privateKey, key.kid);
  /** @type {typeof fetch} */
  const fetchJwks = async () => Response.json({ keys: [key] });

  await verifyAccessAssertion(assertion, config, { fetchImpl: fetchJwks });
  let fetchedAdminShellUrl = "";
  const adminDocumentEnv = {
    ...env,
    ASSETS: {
      /** @param {Request} request */
      async fetch(request) {
        fetchedAdminShellUrl = request.url;
        return new Response("<h1>Protected workspace</h1>", {
          headers: { "content-type": "text/html; charset=UTF-8" },
        });
      },
    },
  };
  const adminDocumentContext = /** @type {AdminDocumentContext} */ (
    /** @type {unknown} */ ({
      request: adminRequest("/admin/history", assertion),
      env: adminDocumentEnv,
    })
  );
  const adminDocument = await onAdminDocument(adminDocumentContext);
  assert.equal(adminDocument.status, 200);
  assert.equal(adminDocument.headers.get("cache-control"), "no-store");
  assert.equal(adminDocument.headers.get("x-content-type-options"), "nosniff");
  assert.equal(new URL(fetchedAdminShellUrl).pathname, "/admin/index.html");
  assert.equal(await adminDocument.text(), "<h1>Protected workspace</h1>");

  const sessionResponse = await onAdminSessionGet(
    createSessionContext(adminRequest("/api/admin/session", assertion), env),
  );
  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.headers.get("cache-control"), "no-store");
  assert.equal(
    sessionResponse.headers.get("access-control-allow-origin"),
    null,
  );
  const session = await sessionResponse.json();
  assert.deepEqual(Object.keys(session).sort(), [
    "admin",
    "csrfToken",
    "expiresAt",
  ]);
  assert.deepEqual(session.admin, { email: administratorEmail });
  assert.equal(
    await verifyAdminCsrfToken(session.csrfToken, {
      subject: administratorSubject,
      secret: csrfSecret,
    }),
    true,
  );

  const invalidAssertion = "untrusted-assertion-value";
  const rejectedSession = await onAdminSessionGet(
    createSessionContext(
      adminRequest("/api/admin/session", invalidAssertion),
      env,
    ),
  );
  const rejectedSessionBody = await rejectedSession.clone().text();
  await assertAdminError(rejectedSession, "ACCESS_INVALID", 401);
  assert.equal(rejectedSessionBody.includes(invalidAssertion), false);

  const csrf = await issueAdminCsrfToken({
    subject: administratorSubject,
    secret: csrfSecret,
  });
  const mutationHeaders = {
    origin: productionOrigin,
    "sec-fetch-site": "same-origin",
    "x-csrf-token": csrf.token,
    "content-type": "application/json",
  };

  const exactAdmin = await runAdminMiddleware(
    adminRequest("/api/admin", assertion),
    env,
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: {
          "access-control-allow-origin": "https://untrusted.example.test",
          "access-control-expose-headers": "x-internal",
          "cache-control": "public, max-age=3600",
        },
      }),
  );
  assert.equal(exactAdmin.response.status, 200);
  assert.equal(exactAdmin.nextCalls, 1);
  assert.equal(exactAdmin.context.data.admin?.subject, administratorSubject);
  assert.equal(
    exactAdmin.response.headers.get("access-control-allow-origin"),
    null,
  );
  assert.equal(
    exactAdmin.response.headers.get("access-control-expose-headers"),
    null,
  );
  assert.equal(exactAdmin.response.headers.get("cache-control"), "no-store");

  const outsideAdmin = await runAdminMiddleware(
    adminRequest("/api/administrator", assertion),
    env,
    async () => new Response("handler should not run"),
  );
  assert.equal(outsideAdmin.nextCalls, 0);
  await assertAdminError(outsideAdmin.response, "ADMIN_NOT_FOUND", 404);

  const rejectedMutations = [
    {
      request: adminRequest("/api/admin/jobs", assertion, {
        method: "POST",
        headers: { ...mutationHeaders, origin: "https://evil.example.test" },
        body: "{}",
      }),
      code: "CSRF_REJECTED",
      status: 403,
    },
    {
      request: adminRequest("/api/admin/jobs", assertion, {
        method: "OPTIONS",
      }),
      code: "METHOD_NOT_ALLOWED",
      status: 405,
    },
    {
      request: adminRequest("/api/admin/jobs", assertion, {
        method: "POST",
        headers: { ...mutationHeaders, "content-type": "text/plain" },
        body: "{}",
      }),
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
    },
    {
      request: adminRequest("/api/admin/jobs", assertion, {
        method: "POST",
        headers: mutationHeaders,
        body: "x".repeat(16 * 1024 + 1),
      }),
      code: "BODY_TOO_LARGE",
      status: 413,
    },
  ];
  for (const rejected of rejectedMutations) {
    const result = await runAdminMiddleware(
      rejected.request,
      env,
      async () => new Response("handler should not run"),
    );
    assert.equal(result.nextCalls, 0);
    await assertAdminError(result.response, rejected.code, rejected.status);
  }
});
