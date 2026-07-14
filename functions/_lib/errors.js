const errorDetails = Object.freeze({
  ACCESS_INVALID: {
    status: 401,
    message: "Administrative access could not be verified.",
  },
  NON_CANONICAL_HOST: {
    status: 421,
    message: "This administrative endpoint is not available on this host.",
  },
  CSRF_REJECTED: {
    status: 403,
    message: "The request integrity check failed.",
  },
  ADMIN_NOT_FOUND: {
    status: 404,
    message: "The administrative endpoint was not found.",
  },
  METHOD_NOT_ALLOWED: {
    status: 405,
    message: "The request method is not allowed.",
  },
  BODY_TOO_LARGE: {
    status: 413,
    message: "The request body is too large.",
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: "The request content type is not supported.",
  },
  INVALID_REQUEST: {
    status: 400,
    message: "The request is invalid.",
  },
  ADMIN_UNAVAILABLE: {
    status: 503,
    message: "The administrative service is temporarily unavailable.",
  },
});

/** Stable error codes returned by administrative endpoints. */
export const ADMIN_ERROR_CODES = Object.freeze({
  ACCESS_INVALID: "ACCESS_INVALID",
  NON_CANONICAL_HOST: "NON_CANONICAL_HOST",
  CSRF_REJECTED: "CSRF_REJECTED",
  ADMIN_NOT_FOUND: "ADMIN_NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  BODY_TOO_LARGE: "BODY_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  INVALID_REQUEST: "INVALID_REQUEST",
  ADMIN_UNAVAILABLE: "ADMIN_UNAVAILABLE",
});

/** @returns {string} */
export function createCorrelationId() {
  return crypto.randomUUID();
}

/**
 * Creates a redacted, non-cacheable administrative error response.
 *
 * @param {keyof typeof ADMIN_ERROR_CODES} code
 * @param {string} [correlationId]
 * @returns {Response}
 */
export function adminError(code, correlationId = createCorrelationId()) {
  const detail = errorDetails[code];
  if (!detail)
    throw new TypeError(`Unknown administrative error code: ${code}`);

  return Response.json(
    {
      code,
      message: detail.message,
      correlationId,
    },
    {
      status: detail.status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/**
 * Creates a non-cacheable JSON response for a successful administrative request.
 *
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
export function adminJson(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
