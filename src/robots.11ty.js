import { publicSiteOrigin } from "./_includes/render/site-origin.js";

export const data = { permalink: "/robots.txt" };

export function render() {
  return `User-agent: *
Allow: /
Disallow: /author/
Sitemap: ${publicSiteOrigin}/sitemap.xml
`;
}
