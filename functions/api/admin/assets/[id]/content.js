import { adminError } from "../../../../_lib/errors.js";
import {
  MediaError,
  readDraftMediaAsset,
  serveStoredMedia,
} from "../../../../_lib/media.js";

/**
 * Serves a private draft asset only after the admin middleware has verified
 * Cloudflare Access. A live non-detached draft reference is required; R2 is
 * never exposed as a public fallback.
 *
 * @param {EventContext<MediaBindings, "id", import("../../_middleware.js").AdminMiddlewareData>} context
 */
export async function onRequestGet(context) {
  if (!context.data.admin) return adminError("ACCESS_INVALID");

  const assetId = context.params.id;
  if (!isAssetId(assetId)) return adminError("ADMIN_NOT_FOUND");
  if (!hasMediaBindings(context.env)) return adminError("ADMIN_UNAVAILABLE");

  try {
    const asset = await readDraftMediaAsset(context.env.DB, assetId);
    if (!asset) return adminError("ADMIN_NOT_FOUND");
    return await serveStoredMedia({
      request: context.request,
      bucket: context.env.JOB_MEDIA,
      asset,
      cacheControl: "no-store",
    });
  } catch (error) {
    if (error instanceof MediaError && error.status === 404) {
      return adminError("ADMIN_NOT_FOUND");
    }
    return adminError("ADMIN_UNAVAILABLE");
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

/** @typedef {{ DB: D1Database, JOB_MEDIA: R2Bucket }} MediaBindings */
