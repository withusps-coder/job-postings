import { parseRevisionSnapshot } from "./_lib/snapshot.js";
import { readActiveOpenRevisions } from "./_lib/db.js";
import {
  enforcePublicHost,
  resolvePublicCanonicalHost,
} from "./_lib/public-host.js";
import {
  publicSite,
  renderJobListing,
  renderPublicError,
  resolvePublicOrigin,
  validateImmutableSnapshot,
} from "../src/_includes/render/public-pages.js";

const publicCacheControl = "public, max-age=0, s-maxage=10, must-revalidate";
/** @typedef {Readonly<import("./_lib/db.js").ActiveRevisionRow>} PublicListRow */

/**
 * Renders the root list only from active, immutable D1 revision snapshots.
 *
 * @param {EventContext<PublicBindings, never, unknown>} context
 */
export async function onRequest(context) {
  const hostResponse = enforcePublicHost(context.request, context.env);
  if (hostResponse) return hostResponse;

  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    return methodNotAllowed();
  }

  const origin = resolvePublicOrigin(resolvePublicCanonicalHost(context.env));
  if (!context.env.DB) return publicError(503, origin, context.request.method);

  try {
    const rows = await readActiveOpenRevisions(context.env.DB);
    const jobs = rows.map((row) => activeSnapshot(row, "open"));
    const body = renderJobListing({
      jobs,
      site: publicSite,
      origin,
      immutable: true,
    });
    return htmlResponse(
      body,
      context.request.method,
      listRevisionMetadata(rows),
    );
  } catch {
    return publicError(503, origin, context.request.method);
  }
}

/** @param {PublicListRow} row @param {"open" | "closed"} expectedStatus */
function activeSnapshot(row, expectedStatus) {
  const snapshot = validateImmutableSnapshot(
    parseRevisionSnapshot(row.snapshotJson),
    publicSite,
  );
  if (
    row.status !== expectedStatus ||
    snapshot.slug !== row.slug ||
    snapshot.status !== row.status
  ) {
    throw new TypeError("Active revision snapshot is inconsistent.");
  }
  return snapshot;
}

/** @param {readonly PublicListRow[]} rows */
function listRevisionMetadata(rows) {
  const current = rows.at(0);
  return current
    ? `list-${rows.length}-${revisionMetadata(current)}`
    : "list-empty";
}

/** @param {PublicListRow} row */
function revisionMetadata(row) {
  const revision =
    Number.isSafeInteger(row.revisionNumber) && row.revisionNumber > 0
      ? row.revisionNumber
      : 0;
  const generation =
    Number.isSafeInteger(row.activeGeneration) && row.activeGeneration >= 0
      ? row.activeGeneration
      : 0;
  const hash = /^[0-9a-f]{64}$/u.test(row.snapshotHash)
    ? row.snapshotHash.slice(0, 12)
    : "invalid";
  return `r${revision}-g${generation}-${hash}`;
}

/** @param {string} body @param {string} method @param {string} revision */
function htmlResponse(body, method, revision) {
  return new Response(method === "HEAD" ? null : body, {
    headers: {
      "cache-control": publicCacheControl,
      "content-type": "text/html; charset=UTF-8",
      "x-content-revision": revision,
      "x-content-type-options": "nosniff",
    },
  });
}

/** @param {404 | 503} status @param {string} origin @param {string} method */
function publicError(status, origin, method) {
  const body = renderPublicError({ site: publicSite, origin, status });
  return new Response(method === "HEAD" ? null : body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=UTF-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function methodNotAllowed() {
  return new Response(null, {
    status: 405,
    headers: {
      allow: "GET, HEAD",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** @typedef {{
  DB: D1Database,
  DEPLOYMENT_ENVIRONMENT?: string,
  PUBLIC_CANONICAL_HOST?: string,
  PUBLIC_PAGES_HOST?: string,
  STAGING_CANONICAL_HOST?: string,
  STAGING_PAGES_HOST?: string
}} PublicBindings */
