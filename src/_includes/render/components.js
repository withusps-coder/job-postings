import { assetUrl, escapeHtml } from "./escape.js";

/** @typedef {import("./types.js").Job} Job */
/** @typedef {import("./types.js").Site} Site */

const statusLabel = { open: "채용 중", closed: "마감" };

/** @param {Site} site */
export function renderMasthead(site) {
  const identity = site.identity;
  return `<header class="site-header" data-site-header>
  <div class="shell site-header__inner">
    <a class="affiliation" href="/" aria-label="${escapeHtml(identity.name)} 헤드헌터 홈">
      <img src="${escapeHtml(assetUrl(site.brand.wordmarkPath))}" alt="스타팅파트너스 소속" width="123" height="28" data-fallback-image>
      <span class="image-fallback" role="status">스타팅파트너스 소속</span>
    </a>
    <nav aria-label="주요 탐색">
      <a href="/#positions">채용 포지션</a>
      <a href="${escapeHtml(site.linkedinUrl)}" target="_blank" rel="noreferrer">LinkedIn<span class="visually-hidden">(새 창)</span></a>
    </nav>
    <a class="mobile-jobs-link" href="/#positions" aria-label="채용 공고 목록 열기"><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></a>
  </div>
</header>`;
}

/** @param {"open" | "closed"} status */
export function renderStatus(status) {
  return `<span class="status status--${status}"><span aria-hidden="true" class="status__dot"></span>${statusLabel[status]}</span>`;
}

/** @param {Job} job */
export function renderJobCard(job) {
  return `<article class="job-card" data-job-card data-job-slug="${escapeHtml(job.slug)}" data-keywords="${escapeHtml([job.title, job.company.name, job.category, ...job.tags].join(" ").toLocaleLowerCase("ko-KR"))}" data-category="${escapeHtml(job.category)}" data-company="${escapeHtml(job.company.name)}">
  <a class="job-card__link" href="/${escapeHtml(job.slug)}/">
    <div class="job-card__top">
      <span class="company-mark"><img src="${escapeHtml(assetUrl(job.company.logo))}" alt="" width="92" height="44" loading="lazy" data-fallback-image><span class="image-fallback" aria-hidden="true">${escapeHtml(job.company.name.slice(0, 1))}</span></span>
      ${renderStatus(job.status)}
    </div>
    <h3>${escapeHtml(job.title)}</h3>
    <p class="job-card__company">${escapeHtml(job.company.name)}</p>
    <ul class="tag-list">${job.tags
      .slice(0, 4)
      .map((tag) => `<li>${escapeHtml(tag)}</li>`)
      .join("")}</ul>
    <span class="job-card__more">상세 보기 <span aria-hidden="true">→</span></span>
  </a>
</article>`;
}

/** @param {Site} site */
export function renderFooter(site) {
  const identity = site.identity;
  return `<footer class="site-footer">
  <div class="shell site-footer__inner">
    <p><strong>${escapeHtml(identity.name)} ${escapeHtml(identity.role)}</strong><br>${escapeHtml(identity.affiliation)}</p>
    <a href="${escapeHtml(site.linkedinUrl)}" target="_blank" rel="noreferrer">LinkedIn 프로필<span class="visually-hidden">(새 창)</span></a>
    <p class="site-footer__copy">채용 정보는 각 기업의 사정에 따라 변경될 수 있습니다.</p>
  </div>
</footer>`;
}

export function renderImageFallbackScript() {
  return `<script src="/assets/scripts/image-fallback.js" defer></script>`;
}
