import { authenticateAdminRequest } from "../../_lib/access.js";
import {
  getAdminBodyPolicy,
  getCsrfSigningSecret,
  validateAdminBodyEnvelope,
  verifyAdminCsrfToken,
} from "../../_lib/csrf.js";
import { adminError } from "../../_lib/errors.js";

/**
 * @typedef {import("../../_lib/access.js").VerifiedAdmin} VerifiedAdmin
 */

/**
 * @typedef {Object} AdminMiddlewareData
 * @property {VerifiedAdmin=} admin
 * @property {import("../../_lib/access.js").AdminSecurityConfig=} adminSecurity
 */

/**
 * Protects the exact /api/admin parent route and every descendant route.
 *
 * @param {EventContext<Record<string, unknown>, string, AdminMiddlewareData>} context
 * @returns {Promise<Response>}
 */
export async function onRequest(context) {
  const { request } = context;
  let pathname;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return adminError("ADMIN_NOT_FOUND");
  }

  if (!isAdminApiPath(pathname)) return adminError("ADMIN_NOT_FOUND");
  if (request.method === "OPTIONS") return adminError("METHOD_NOT_ALLOWED");

  const authentication = await authenticateAdminRequest(request, context.env);
  if (!authentication.ok) return adminError(authentication.code);

  if (isMutationMethod(request.method)) {
    const integrityError = await validateMutationIntegrity(
      request,
      authentication.config.canonicalOrigin,
      authentication.admin.subject,
      context.env,
    );
    if (integrityError) return adminError(integrityError);
  }

  context.data.admin = authentication.admin;
  context.data.adminSecurity = authentication.config;

  try {
    return withoutCors(await context.next());
  } catch {
    return adminError("ADMIN_UNAVAILABLE");
  }
}

/**
 * @param {Request} request
 * @param {string} canonicalOrigin
 * @param {string} subject
 * @param {Record<string, unknown>} env
 * @returns {Promise<"ADMIN_UNAVAILABLE" | "BODY_TOO_LARGE" | "CSRF_REJECTED" | "INVALID_REQUEST" | "UNSUPPORTED_MEDIA_TYPE" | null>}
 */
async function validateMutationIntegrity(
  request,
  canonicalOrigin,
  subject,
  env,
) {
  if (
    request.headers.get("origin") !== canonicalOrigin ||
    request.headers.get("sec-fetch-site") !== "same-origin"
  ) {
    return "CSRF_REJECTED";
  }

  let csrfSigningSecret;
  try {
    csrfSigningSecret = getCsrfSigningSecret(env);
  } catch {
    return "ADMIN_UNAVAILABLE";
  }

  try {
    const csrfValid = await verifyAdminCsrfToken(
      request.headers.get("x-csrf-token"),
      { subject, secret: csrfSigningSecret },
    );
    if (!csrfValid) return "CSRF_REJECTED";
  } catch {
    return "ADMIN_UNAVAILABLE";
  }

  return validateAdminBodyEnvelope(request, getAdminBodyPolicy(request));
}

/** @param {string} pathname @returns {boolean} */
function isAdminApiPath(pathname) {
  return pathname === "/api/admin" || pathname.startsWith("/api/admin/");
}

/** @param {string} method @returns {boolean} */
function isMutationMethod(method) {
  return method !== "GET" && method !== "HEAD";
}

/** @param {Response} response @returns {Response} */
function withoutCors(response) {
  const headers = new Headers(response.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("access-control-")) headers.delete(name);
  }
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
