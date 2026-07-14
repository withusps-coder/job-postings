/** @typedef {{ instancePath: string, message: string }} JobUrlError */

export const reservedRootSlugs = Object.freeze([
  "admin",
  "author",
  "api",
  "media",
  "assets",
  "sitemap.xml",
  "robots.txt",
  "manifest.webmanifest",
  "favicon.ico",
  "404.html",
]);

const reservedRootSlugSet = new Set(reservedRootSlugs);

/** @param {unknown} input @returns {JobUrlError[]} */
export function validateJobUrls(input) {
  /** @type {JobUrlError[]} */
  const errors = [];
  validateReservedRootSlug(input, errors);
  visitUrls(input, [], errors);
  return errors;
}

/** @param {unknown} input @param {JobUrlError[]} errors */
function validateReservedRootSlug(input, errors) {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return;
  const slug = Reflect.get(input, "slug");
  if (typeof slug !== "string" || !reservedRootSlugSet.has(slug)) return;
  errors.push({
    instancePath: "/slug",
    message: "must not use a reserved root slug",
  });
}

/** @param {unknown} value @param {readonly string[]} path @param {JobUrlError[]} errors */
function visitUrls(value, path, errors) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      visitUrls(item, [...path, String(index)], errors);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (
      typeof child === "string" &&
      [
        "website",
        "url",
        "officialStartingApplicationUrl",
        "logo",
        "heroImage",
      ].includes(key) &&
      child.startsWith("https://") &&
      !isSafeHttpsUrl(child)
    ) {
      errors.push({
        instancePath: `/${childPath.join("/")}`,
        message: "must be an HTTPS URL with a hostname and no credentials",
      });
    }
    visitUrls(child, childPath, errors);
  }
}

/** @param {string} value */
function isSafeHttpsUrl(value) {
  if (!/^https:\/\/[^/@\s]+(?:[/:?#]|$)/u.test(value) || !URL.canParse(value))
    return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname.length > 0 &&
    url.username.length === 0 &&
    url.password.length === 0
  );
}
