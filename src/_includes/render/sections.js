import { escapeHtml } from "./escape.js";

/** @typedef {import("./types.js").Link} Link */
/** @typedef {import("./types.js").Sections} Sections */
/** @typedef {import("./types.js").Stat} Stat */

const labels = {
  company: "회사 소개",
  responsibilities: "주요 업무",
  qualifications: "지원 자격",
  preferred: "우대 사항",
  benefits: "복지 및 혜택",
  conditions: "근무 조건",
  process: "채용 절차",
  notes: "지원 안내",
};

/** @param {string} value */
function splitLabel(value) {
  const separator = value.indexOf(":");
  if (separator < 1) return { label: undefined, value: value.trim() };
  return {
    label: value.slice(0, separator).trim(),
    value: value.slice(separator + 1).trim(),
  };
}

/** @param {string[] | undefined} items */
function renderBullets(items) {
  if (!items?.length) return "";
  return `<ul class="detail-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

/** @param {"company" | "qualifications" | "preferred" | "notes"} key @param {string[] | undefined} items */
function renderListSection(key, items) {
  if (!items?.length) return "";
  return `<section class="detail-section detail-section--${key}" aria-labelledby="section-${key}"><h2 id="section-${key}">${labels[key]}</h2>${renderBullets(items)}</section>`;
}

/** @param {string[]} items */
function extractRoleOverview(items) {
  const overview = [];
  const responsibilities = [];
  for (const item of items) {
    const parsed = splitLabel(item);
    if (
      parsed.label &&
      /^(?:포지션 개요|이런 분(?:을 찾습니다)?|이렇게 일합니다)$/u.test(
        parsed.label,
      )
    ) {
      overview.push({ label: parsed.label, value: parsed.value });
    } else {
      responsibilities.push(item);
    }
  }
  return { overview, responsibilities };
}

/** @param {string[]} items */
function renderResponsibilities(items) {
  const extracted = extractRoleOverview(items);
  const overview = extracted.overview;
  const responsibilities = extracted.responsibilities.map((item) => {
    const parsed = splitLabel(item);
    return parsed.label === "주요 업무" ? parsed.value : item;
  });
  const overviewHtml = overview.length
    ? `<section class="detail-section role-overview" aria-labelledby="section-overview"><h2 id="section-overview">포지션 소개</h2>${overview
        .map(
          (item) =>
            `<div class="role-overview__item"><h3>${escapeHtml(item.label)}</h3><p>${escapeHtml(item.value)}</p></div>`,
        )
        .join("")}</section>`
    : "";
  const responsibilityHtml = responsibilities.length
    ? `<section class="detail-section" aria-labelledby="section-responsibilities"><h2 id="section-responsibilities">${labels.responsibilities}</h2>${renderBullets(responsibilities)}</section>`
    : "";
  return `${overviewHtml}${responsibilityHtml}`;
}

/** @param {string[] | undefined} items */
function renderBenefits(items) {
  if (!items?.length) return "";
  return `<section class="detail-section" aria-labelledby="section-benefits"><h2 id="section-benefits">${labels.benefits}</h2><ul class="benefit-list">${items
    .map((item) => {
      const parsed = splitLabel(item);
      return `<li class="benefit-group"><h3>${escapeHtml(parsed.label ?? "제공 혜택")}</h3><p>${escapeHtml(parsed.value)}</p></li>`;
    })
    .join("")}</ul></section>`;
}

/** @param {string[] | undefined} items */
function renderConditions(items) {
  if (!items?.length) return "";
  return `<section class="detail-section" aria-labelledby="section-conditions"><h2 id="section-conditions">${labels.conditions}</h2><dl class="condition-list">${items
    .map((item) => {
      const parsed = splitLabel(item);
      return `<div><dt>${escapeHtml(parsed.label ?? "근무 조건")}</dt><dd>${escapeHtml(parsed.value)}</dd></div>`;
    })
    .join("")}</dl></section>`;
}

/** @param {string[] | undefined} items */
function renderProcess(items) {
  if (!items?.length) return "";
  const note = items.at(-1)?.startsWith("선발 절차") ? items.at(-1) : undefined;
  const steps = note ? items.slice(0, -1) : items;
  const details = steps.flatMap((item) => {
    const parsed = splitLabel(item);
    return parsed.label ? [parsed] : [];
  });
  return `<section class="detail-section" aria-labelledby="section-process"><h2 id="section-process">${labels.process}</h2><ol class="process-list">${steps
    .map((item) => {
      const parsed = splitLabel(item);
      return `<li><div class="process-list__content"><strong>${escapeHtml(parsed.label ?? parsed.value)}</strong></div></li>`;
    })
    .join(
      "",
    )}</ol>${details.length ? `<ul class="process-details">${details.map((item) => `<li><strong>${escapeHtml(item.label)}</strong> ${escapeHtml(item.value)}</li>`).join("")}</ul>` : ""}${note ? `<p class="process-note">* ${escapeHtml(note)}</p>` : ""}</section>`;
}

/** @param {Stat[] | undefined} stats */
export function renderStats(stats) {
  if (!stats?.length) return "";
  return `<dl class="stats">${stats.map((stat) => `<div><dt>${escapeHtml(stat.label)}</dt><dd>${escapeHtml(stat.value)}</dd></div>`).join("")}</dl>`;
}

/** @param {Link[] | undefined} news */
export function renderNews(news) {
  if (!news?.length) return "";
  return `<section class="detail-section" aria-labelledby="section-news"><h2 id="section-news">관련 소식</h2><ul class="news-list">${news.map((item) => `<li><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer"><span>${escapeHtml(item.label)}</span><strong>기사 보기 <span aria-hidden="true">↗</span></strong><span class="visually-hidden">(새 창)</span></a></li>`).join("")}</ul></section>`;
}

/** @param {Sections} sections */
export function renderJobSections(sections) {
  return [
    renderListSection("company", sections.company),
    renderNews(sections.news),
    renderResponsibilities(sections.responsibilities),
    renderListSection("qualifications", sections.qualifications),
    renderListSection("preferred", sections.preferred),
    renderBenefits(sections.benefits),
    renderConditions(sections.conditions),
    renderProcess(sections.process),
    renderListSection("notes", sections.notes),
  ].join("");
}
