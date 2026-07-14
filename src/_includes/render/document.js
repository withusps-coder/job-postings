import { assetUrl, escapeHtml, serializeJson } from "./escape.js";
import {
  renderFooter,
  renderImageFallbackScript,
  renderMasthead,
} from "./components.js";
import { publicSiteOrigin } from "./site-origin.js";

/** @typedef {import("./types.js").Site} Site */

/** @param {{ site: Site, title?: string, description: string, origin?: string, path: string, structuredData?: object, content: string, bodyClass?: string, script?: string, robots?: string }} input */
export function renderDocument(input) {
  const title = input.title ?? input.site.identity.name;
  const description = input.description;
  const origin = input.origin ?? publicSiteOrigin;
  const canonical = new URL(input.path, origin).href;
  const socialImage = new URL(assetUrl(input.site.brand.faviconPath), origin)
    .href;
  const socialTitle = escapeHtml(title);
  const structuredData = input.structuredData
    ? `<script type="application/ld+json">${serializeJson(input.structuredData)}</script>`
    : "";
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${socialTitle}</title>
  <meta name="description" content="${escapeHtml(description)}">
${input.robots ? `  <meta name="robots" content="${escapeHtml(input.robots)}">\n` : ""}  <link rel="canonical" href="${escapeHtml(canonical)}">
  <link rel="icon" href="${escapeHtml(assetUrl(input.site.brand.faviconPath))}" type="image/png">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="ko_KR">
  <meta property="og:title" content="${socialTitle}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:image" content="${escapeHtml(socialImage)}">
  <meta property="og:image:width" content="150">
  <meta property="og:image:height" content="150">
  <meta name="twitter:card" content="summary">
  <link rel="stylesheet" href="/assets/styles/site.css">
${structuredData ? `  ${structuredData}\n` : ""}</head>
<body class="${escapeHtml(input.bodyClass ?? "")}">
  <a class="skip-link" href="#main-content">본문으로 건너뛰기</a>
  ${renderMasthead(input.site)}
  <main id="main-content">${input.content}</main>
  ${renderFooter(input.site)}
  ${renderImageFallbackScript()}
${input.script ? `  ${input.script}\n` : ""}</body>
</html>`;
}
