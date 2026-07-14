import { createHash } from "node:crypto";
import { isJsonObject } from "./data-validation-utils.mjs";

const approvedContactDigest =
  "68453698ed2f77dd23ef960cad3fd74752d9b770a1e384fb8beef5df7be26a8b";
const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/iu;

/** @typedef {import("./data-validation-utils.mjs").ValidationError} ValidationError */

/** @param {unknown} input @returns {import("./data-validation-utils.mjs").ValidationResult} */
export function validateSite(input) {
  if (!isJsonObject(input))
    return {
      valid: false,
      errors: [{ instancePath: "/", message: "must be an object" }],
    };
  /** @type {ValidationError[]} */
  const errors = [];
  validateObject(
    input,
    [
      "schemaVersion",
      "identity",
      "contactEmail",
      "linkedinUrl",
      "brand",
      "approvalReceipt",
    ],
    "/",
    errors,
  );
  if (input["schemaVersion"] !== 1)
    errors.push({
      instancePath: "/schemaVersion",
      message: "must equal constant",
    });
  const contact = input["contactEmail"];
  if (
    typeof contact !== "string" ||
    !emailPattern.test(contact) ||
    createHash("sha256").update(contact).digest("hex") !== approvedContactDigest
  ) {
    errors.push({
      instancePath: "/contactEmail",
      message: "must be the approved contact",
    });
  }
  if (
    typeof input["linkedinUrl"] !== "string" ||
    !isHttpsUrl(input["linkedinUrl"]) ||
    !input["linkedinUrl"].startsWith("https://www.linkedin.com/")
  ) {
    errors.push({
      instancePath: "/linkedinUrl",
      message: "must be an HTTPS LinkedIn URL",
    });
  }
  validateObject(
    input["identity"],
    ["name", "role", "affiliation"],
    "/identity",
    errors,
    { name: "string", role: "string", affiliation: "string" },
  );
  validateObject(
    input["brand"],
    ["wordmarkPath", "faviconPath"],
    "/brand",
    errors,
    { wordmarkPath: "string", faviconPath: "string" },
  );
  validateObject(
    input["approvalReceipt"],
    ["scope", "contactConfirmed", "approvedAt"],
    "/approvalReceipt",
    errors,
    { scope: "string", contactConfirmed: "boolean", approvedAt: "string" },
  );
  const receipt = input["approvalReceipt"];
  if (
    isJsonObject(receipt) &&
    (receipt["scope"] !== "personal-recruiter-site" ||
      receipt["contactConfirmed"] !== true ||
      receipt["approvedAt"] !== "2026-07-11")
  ) {
    errors.push({
      instancePath: "/approvalReceipt",
      message: "must be the approved receipt",
    });
  }
  if (containsUnexpectedEmail(input, []))
    errors.push({
      instancePath: "/",
      message: "must not contain an alternative email",
    });
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

/** @param {unknown} input @param {readonly string[]} keys @param {string} path @param {ValidationError[]} errors @param {Record<string, string>=} types */
function validateObject(input, keys, path, errors, types) {
  if (!isJsonObject(input)) {
    errors.push({ instancePath: path, message: "must be an object" });
    return;
  }
  for (const key of keys) {
    if (!(key in input))
      errors.push({
        instancePath: path,
        message: `must have required property '${key}'`,
      });
    if (types?.[key] && typeof input[key] !== types[key])
      errors.push({
        instancePath: `${path}/${key}`,
        message: `must be ${types[key]}`,
      });
  }
  for (const key of Object.keys(input))
    if (!keys.includes(key))
      errors.push({
        instancePath: path,
        message: "must NOT have additional properties",
      });
}

/** @param {string} value @returns {boolean} */
function isHttpsUrl(value) {
  if (!/^https:\/\/[^/@\s]+(?:[/:?#]|$)/.test(value) || !URL.canParse(value))
    return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname.length > 0 &&
    url.username.length === 0 &&
    url.password.length === 0
  );
}

/** @param {unknown} value @param {readonly string[]} path @returns {boolean} */
function containsUnexpectedEmail(value, path) {
  if (typeof value === "string")
    return path.join("/") !== "contactEmail" && emailPattern.test(value);
  if (Array.isArray(value))
    return value.some((item, index) =>
      containsUnexpectedEmail(item, [...path, String(index)]),
    );
  return (
    isJsonObject(value) &&
    Object.entries(value).some(([key, child]) =>
      containsUnexpectedEmail(child, [...path, key]),
    )
  );
}
