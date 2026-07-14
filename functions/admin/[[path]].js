import { authenticateAdminRequest } from "../_lib/access.js";
import { adminError } from "../_lib/errors.js";

/**
 * Serves the static administrator workspace only after the same Access and host
 * checks used by the administrator API. Every nested route resolves to the
 * shell so client-side history cannot bypass document protection.
 *
 * @param {EventContext<AdminDocumentBindings, string, unknown>} context
 */
export async function onRequest(context) {
  const { request } = context;
  const pathname = new URL(request.url).pathname;

  if (pathname !== "/admin" && !pathname.startsWith("/admin/")) {
    return adminError("ADMIN_NOT_FOUND");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return adminError("METHOD_NOT_ALLOWED");
  }

  const authentication = await authenticateAdminRequest(request, context.env);
  if (!authentication.ok) return adminError(authentication.code);

  try {
    const shellUrl = new URL("/admin/index.html", request.url);
    const shellRequest = new Request(shellUrl, {
      method: request.method,
      headers: request.headers,
    });
    const response = await context.env.ASSETS.fetch(shellRequest);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return adminError("ADMIN_UNAVAILABLE");
  }
}

/**
 * @typedef {Record<string, unknown> & {
 *   ASSETS: { fetch(request: Request): Promise<Response> }
 * }} AdminDocumentBindings
 */
