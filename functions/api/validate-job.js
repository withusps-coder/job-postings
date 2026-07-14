/**
 * Retires the parallel repository-backed validator in favor of protected D1 drafts.
 *
 * @returns {Response}
 */
export function onRequest() {
  return Response.json(
    {
      code: "AUTHORING_RETIRED",
      message: "This authoring endpoint has been retired.",
    },
    {
      status: 410,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
