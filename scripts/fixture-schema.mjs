export const emptySiteSchema = {
  $id: "https://majesty-recruiting.example/schema/empty-site.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "jobs"],
  properties: {
    schemaVersion: { const: 1 },
    jobs: {
      type: "array",
      maxItems: 0,
    },
  },
};
