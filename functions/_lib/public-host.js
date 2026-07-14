const canonicalResponseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/**
 * Allows a public request only from its exact environment canonical host or an
 * explicit loopback test host. When distinct, the environment's Pages default
 * host redirects safe reads to the canonical host; every other alias fails closed.
 *
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @returns {Response | undefined}
 */
export function enforcePublicHost(request, env) {
  let requestUrl;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return nonCanonicalHostResponse();
  }

  if (isLoopbackHost(requestUrl.hostname)) {
    return hasSafeRequestTarget(request, requestUrl, true)
      ? undefined
      : nonCanonicalHostResponse();
  }

  let config;
  try {
    config = getPublicHostConfig(env);
  } catch {
    return nonCanonicalHostResponse();
  }

  if (!hasSafeRequestTarget(request, requestUrl, false)) {
    return nonCanonicalHostResponse();
  }

  if (requestUrl.host === config.canonicalHost) return undefined;
  if (
    requestUrl.host === config.pagesHost &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    return canonicalRedirect(requestUrl, config.canonicalHost);
  }
  return nonCanonicalHostResponse();
}

/**
 * @param {Record<string, unknown>} env
 * @returns {{ canonicalHost: string, pagesHost: string }}
 */
export function getPublicHostConfig(env) {
  const environment = requiredEnvironment(env);
  const prefix = environment === "production" ? "PUBLIC" : "STAGING";
  const canonicalHost = requiredHost(env, `${prefix}_CANONICAL_HOST`);
  const pagesHost = requiredPagesHost(env, `${prefix}_PAGES_HOST`);
  return { canonicalHost, pagesHost };
}
/**
 * Returns the selected canonical host for generated public URLs. Loopback
 * development can proceed with only the existing public canonical setting.
 *
 * @param {Record<string, unknown>} env
 * @returns {string | undefined}
 */
export function resolvePublicCanonicalHost(env) {
  try {
    return getPublicHostConfig(env).canonicalHost;
  } catch {
    const host = env["PUBLIC_CANONICAL_HOST"];
    return typeof host === "string" ? host : undefined;
  }
}

/** @param {URL} requestUrl @param {string} canonicalHost */
function canonicalRedirect(requestUrl, canonicalHost) {
  const location = `https://${canonicalHost}${requestUrl.pathname}${requestUrl.search}`;
  return new Response(null, {
    status: 308,
    headers: {
      ...canonicalResponseHeaders,
      location,
    },
  });
}

function nonCanonicalHostResponse() {
  return new Response(null, {
    status: 421,
    headers: canonicalResponseHeaders,
  });
}

/** @param {Request} request @param {URL} requestUrl @param {boolean} loopback */
function hasSafeRequestTarget(request, requestUrl, loopback) {
  const protocol = requestUrl.protocol.slice(0, -1);
  if (
    (loopback && protocol !== "http" && protocol !== "https") ||
    (!loopback && protocol !== "https")
  ) {
    return false;
  }

  const host = request.headers.get("host");
  if (
    (!loopback && host === null) ||
    (host !== null && host !== requestUrl.host)
  ) {
    return false;
  }

  return (
    forwardedHostsMatch(
      request.headers.get("x-forwarded-host"),
      requestUrl.host,
    ) &&
    forwardedProtocolsMatch(
      request.headers.get("x-forwarded-proto"),
      protocol,
    ) &&
    forwardedHeaderMatches(
      request.headers.get("forwarded"),
      requestUrl.host,
      protocol,
    )
  );
}

/** @param {string | null} forwardedHost @param {string} expectedHost */
function forwardedHostsMatch(forwardedHost, expectedHost) {
  if (forwardedHost === null) return true;
  const hosts = forwardedHost.split(",").map((host) => host.trim());
  return hosts.length > 0 && hosts.every((host) => host === expectedHost);
}

/** @param {string | null} forwardedProtocol @param {string} expectedProtocol */
function forwardedProtocolsMatch(forwardedProtocol, expectedProtocol) {
  if (forwardedProtocol === null) return true;
  const protocols = forwardedProtocol
    .split(",")
    .map((protocol) => protocol.trim());
  return (
    protocols.length > 0 &&
    protocols.every((protocol) => protocol === expectedProtocol)
  );
}

/**
 * @param {string | null} forwarded
 * @param {string} expectedHost
 * @param {string} expectedProtocol
 */
function forwardedHeaderMatches(forwarded, expectedHost, expectedProtocol) {
  if (forwarded === null) return true;

  for (const element of forwarded.split(",")) {
    for (const parameter of element.split(";")) {
      const separator = parameter.indexOf("=");
      if (separator === -1) continue;
      const name = parameter.slice(0, separator).trim().toLowerCase();
      const value = unquoteForwardedValue(
        parameter.slice(separator + 1).trim(),
      );
      if (value === undefined) return false;
      if (name === "host" && value !== expectedHost) return false;
      if (name === "proto" && value !== expectedProtocol) return false;
    }
  }
  return true;
}

/** @param {string} value */
function unquoteForwardedValue(value) {
  if (value.startsWith('"') || value.endsWith('"')) {
    if (
      value.length < 2 ||
      !value.startsWith('"') ||
      !value.endsWith('"') ||
      value.slice(1, -1).includes('"')
    ) {
      return undefined;
    }
    return value.slice(1, -1);
  }
  return value;
}

/** @param {string} host */
function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/** @param {Record<string, unknown>} env */
function requiredEnvironment(env) {
  const value = requiredString(env, "DEPLOYMENT_ENVIRONMENT");
  if (value !== "production" && value !== "staging") {
    throw new TypeError("Invalid deployment environment");
  }
  return value;
}

/** @param {Record<string, unknown>} env @param {string} name */
function requiredHost(env, name) {
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

/** @param {Record<string, unknown>} env @param {string} name */
function requiredPagesHost(env, name) {
  const value = requiredHost(env, name);
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+pages\.dev$/u.test(value)) {
    throw new TypeError("Invalid Pages host");
  }
  return value;
}

/** @param {Record<string, unknown>} env @param {string} name */
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
