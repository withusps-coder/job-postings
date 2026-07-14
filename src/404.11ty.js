import { escapeHtml } from "./_includes/render/escape.js";
import { renderDocument } from "./_includes/render/document.js";

/** @typedef {import("./_includes/render/types.js").Site} Site */

export const data = { permalink: "/404.html" };

/** @param {{ site: Site }} input */
export function render({ site }) {
  return renderDocument({
    site,
    title: `페이지를 찾을 수 없습니다 | ${site.identity.name} ${site.identity.role}`,
    description: "요청한 채용 페이지를 찾을 수 없습니다.",
    path: "/404.html",
    content: `<section class="message-page shell"><p class="eyebrow">404</p><h1>페이지를 찾을 수 없습니다.</h1><p>주소가 변경되었거나 더 이상 제공되지 않는 페이지입니다.</p><a class="action action--primary" href="/">${escapeHtml(site.identity.name)} 헤드헌터 홈으로</a></section>`,
    bodyClass: "error-page",
  });
}
