import { readActiveOpenRevisions } from "./_lib/db.js";
import { parseRevisionSnapshot } from "./_lib/snapshot.js";
import {
  enforcePublicHost,
  resolvePublicCanonicalHost,
} from "./_lib/public-host.js";
import {
  isReservedPublicSlug,
  publicSite,
  resolvePublicOrigin,
  validateImmutableSnapshot,
} from "../src/_includes/render/public-pages.js";

const publicCacheControl = "public, max-age=0, s-maxage=10, must-revalidate";
/** @typedef {Readonly<import("./_lib/db.js").ActiveRevisionRow>} PublicSitemapRow */

/**
 * Emits the canonical root and active-open revision URLs from a first-primary D1
 * read. Closed, draft, and source-file jobs are intentionally absent.
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
  if (!context.env.DB) return sitemapUnavailable(context.request.method);

  try {
    const rows = await readActiveOpenRevisions(context.env.DB);
    for (const row of rows) verifyOpenSnapshot(row);
    const body = renderSitemap(origin, rows);
    return xmlResponse(
      body,
      context.request.method,
      listRevisionMetadata(rows),
    );
  } catch {
    return sitemapUnavailable(context.request.method);
  }
}

/** @param {string} origin @param {readonly PublicSitemapRow[]} rows */
function renderSitemap(origin, rows) {
  const urls = ["/", ...rows.map((row) => `/${row.slug}/`)];
  const entries = urls
    .map((path, index) => {
      const loc = escapeXml(new URL(path, origin).href);
      const lastmod = index === 0 ? "" : sitemapLastmod(rows[index - 1]);
      return `<url><loc>${loc}</loc>${lastmod}</url>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

/** @param {PublicSitemapRow} row */
function verifyOpenSnapshot(row) {
  const snapshot = validateImmutableSnapshot(
    parseRevisionSnapshot(row.snapshotJson),
    publicSite,
  );
  if (
    row.status !== "open" ||
    snapshot.status !== "open" ||
    snapshot.slug !== row.slug ||
    !isPublicSlug(row.slug) ||
    isReservedPublicSlug(row.slug)
  ) {
    throw new TypeError("Active revision snapshot is inconsistent.");
  }
}
/** @param {string} value */
function isPublicSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

/** @param {PublicSitemapRow | undefined} row */
function sitemapLastmod(row) {
  if (!row || !Number.isSafeInteger(row.revisionCreatedAt)) return "";
  const date = new Date(row.revisionCreatedAt);
  return Number.isNaN(date.valueOf())
    ? ""
    : `<lastmod>${date.toISOString()}</lastmod>`;
}

/** @param {readonly PublicSitemapRow[]} rows */
function listRevisionMetadata(rows) {
  const current = rows.at(0);
  return current
    ? `list-${rows.length}-${revisionMetadata(current)}`
    : "list-empty";
}

/** @param {PublicSitemapRow} row */
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

/** @param {string} value */
function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** @param {string} body @param {string} method @param {string} revision */
function xmlResponse(body, method, revision) {
  return new Response(method === "HEAD" ? null : body, {
    headers: {
      "cache-control": publicCacheControl,
      "content-type": "application/xml; charset=UTF-8",
      "x-content-revision": revision,
      "x-content-type-options": "nosniff",
    },
  });
}

/** @param {string} method */
function sitemapUnavailable(method) {
  return new Response(
    method === "HEAD" ? null : "Sitemap temporarily unavailable.",
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=UTF-8",
        "x-content-type-options": "nosniff",
      },
    },
  );
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
