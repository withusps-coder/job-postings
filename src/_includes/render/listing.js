import { escapeHtml } from "./escape.js";
import { renderJobCard } from "./components.js";

/** @typedef {import("./types.js").Job} Job */
/** @typedef {import("./types.js").Site} Site */

/** @param {string[]} values @param {string} label */
function renderOptions(values, label) {
  return `<option value="">${label}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
}

/** @param {{ jobs: Job[], site: Site }} input */
export function renderListingContent(input) {
  const { jobs, site } = input;
  const openJobs = jobs.filter((job) => job.status === "open");
  const categories = [...new Set(openJobs.map((job) => job.category))].sort(
    (left, right) => left.localeCompare(right, "ko"),
  );
  const companies = [...new Set(openJobs.map((job) => job.company.name))].sort(
    (left, right) => left.localeCompare(right, "ko"),
  );
  const identity = site.identity;
  return `<section class="recruiter-hero shell" aria-labelledby="page-title">
  <p class="eyebrow">${escapeHtml(identity.affiliation)}</p>
  <h1 id="page-title">사람과 기회를<br><span>정확하게 연결합니다.</span></h1>
  <p class="recruiter-hero__intro">${escapeHtml(identity.name)} ${escapeHtml(identity.role)}가 직접 검토한 포지션을 소개합니다. 역할과 조직의 맥락을 확인하고 편하게 문의해 주세요.</p>
  <a class="action action--secondary" href="${escapeHtml(site.linkedinUrl)}" target="_blank" rel="noreferrer">경력 및 소개 보기<span class="visually-hidden">(새 창)</span></a>
</section>
<section class="positions shell" id="positions" aria-labelledby="positions-title">
  <div class="section-heading"><div><p class="eyebrow">Open positions</p><h2 id="positions-title">현재 채용 중인 포지션</h2></div><p>총 <strong data-result-count>${openJobs.length}</strong>개</p></div>
  <form class="filters" role="search" action="/" method="get" data-job-filters>
    <label class="search-field"><span>키워드</span><input type="search" name="q" autocomplete="off" placeholder="직무, 회사, 키워드 검색"></label>
    <label><span>직군</span><select name="category">${renderOptions(categories, "전체 직군")}</select></label>
    <label><span>회사</span><select name="company">${renderOptions(companies, "전체 회사")}</select></label>
    <button class="action action--primary" type="submit">검색</button>
  </form>
  <div class="job-grid" data-job-results>${openJobs.map(renderJobCard).join("")}</div>
  <div class="empty-state" data-empty-state hidden>
    <h3>조건에 맞는 포지션이 없습니다.</h3>
    <p>검색어 또는 필터를 바꾸어 다시 확인해 주세요.</p>
    <a class="action action--secondary" href="/" data-reset-filters>필터 초기화</a>
  </div>
  <noscript><p class="notice">검색 필터는 JavaScript 사용 시 적용됩니다. 현재 채용 중인 모든 포지션은 위 목록에서 확인할 수 있습니다.</p></noscript>
</section>
<section class="contact-band"><div class="shell"><div><p class="eyebrow">Selected opportunities</p><h2>관심 있는 포지션의 상세 정보를 확인하세요.</h2><p>회사와 역할의 맥락, 주요 업무, 지원 자격을 한 페이지에서 살펴볼 수 있습니다.</p></div><a class="action action--primary" href="#positions">채용 포지션 다시 보기</a></div></section>`;
}
