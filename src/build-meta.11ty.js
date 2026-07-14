export const data = { permalink: "/build-meta.json" };

export function render() {
  return JSON.stringify({
    commit: process.env["CF_PAGES_COMMIT_SHA"] ?? "local",
    generatedBy: "Eleventy",
    schemaVersion: 1,
  });
}
