/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{ readonly instancePath: string, readonly message: string }} ValidationError */
/** @typedef {{ readonly valid: true, readonly errors: readonly [] } | { readonly valid: false, readonly errors: readonly ValidationError[] }} ValidationResult */

/** @param {unknown} value @returns {value is JsonObject} */
export function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {readonly import("ajv").ErrorObject[]} errors @returns {readonly ValidationError[]} */
export function toSafeErrors(errors) {
  return errors.map((error) => ({
    instancePath: error.instancePath || "/",
    message: error.message ?? "failed validation",
  }));
}

/** @param {unknown} input @param {import("ajv").ValidateFunction} validator @returns {ValidationResult} */
export function validateWithSchema(input, validator) {
  return validator(input)
    ? { valid: true, errors: [] }
    : { valid: false, errors: toSafeErrors(validator.errors ?? []) };
}
