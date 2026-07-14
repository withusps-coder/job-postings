/**
 * Retires the repository-backed authoring UI for every /author path.
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
