import { readPublicAsset } from "../_lib/db.js";
import { enforcePublicHost } from "../_lib/public-host.js";
import {
  MediaError,
  mediaUnavailable,
  opaqueMediaNotFound,
  serveStoredMedia,
} from "../_lib/media.js";

const immutableCacheControl = "public, max-age=31536000, immutable";

/**
 * Public immutable media is eligible only through a retained revision_assets
 * binding. This route is the sole public object origin; it never redirects to
 * or falls back to an R2 public bucket URL.
 *
 * @param {EventContext<MediaBindings, "assetId", unknown>} context
 */
export async function onRequest(context) {
  const hostResponse = enforcePublicHost(context.request, context.env);
  if (hostResponse) return hostResponse;

  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: {
        allow: "GET, HEAD",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const assetId = context.params.assetId;
  if (!isAssetId(assetId) || !hasMediaBindings(context.env)) {
    return opaqueMediaNotFound();
  }

  try {
    const asset = await readPublicAsset(context.env.DB, assetId);
    if (!asset) return opaqueMediaNotFound();
    return await serveStoredMedia({
      request: context.request,
      bucket: context.env.JOB_MEDIA,
      asset,
      cacheControl: immutableCacheControl,
    });
  } catch (error) {
    if (error instanceof MediaError && error.status === 404) {
      return opaqueMediaNotFound();
    }
    return mediaUnavailable();
  }
}

/** @param {unknown} value @returns {value is string} */
function isAssetId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

/** @param {MediaBindings} env */
function hasMediaBindings(env) {
  return Boolean(env.DB && env.JOB_MEDIA);
}

/** @typedef {{
  DB: D1Database,
  JOB_MEDIA: R2Bucket,
  DEPLOYMENT_ENVIRONMENT?: string,
  PUBLIC_CANONICAL_HOST?: string,
  PUBLIC_PAGES_HOST?: string,
  STAGING_CANONICAL_HOST?: string,
  STAGING_PAGES_HOST?: string
}} MediaBindings */
