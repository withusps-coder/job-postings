/** @param {EventContext<unknown, string, unknown>} context */
export async function onRequestGet(context) {
  return Response.json(
    {
      status: "ok",
      method: context.request.method,
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
