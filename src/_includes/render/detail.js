import { assetUrl, escapeHtml } from "./escape.js";
import { renderJobSections } from "./sections.js";

/** @typedef {import("./types.js").Document} JobDocument */
/** @typedef {import("./types.js").Job} Job */
/** @typedef {import("./types.js").Site} Site */
/** @typedef {{ kind: "email" | "url", value: string }} PublicApplication */
/** @typedef {Job & { application?: PublicApplication }} PublicJob */
/** @typedef {JobDocument & { mimeType?: string }} PublicDocument */

const remoteLabels = {
  onsite: "출근 근무",
  hybrid: "하이브리드",
  remote: "원격 근무",
};

const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
const mediaPathPattern = /^\/media\/[A-Za-z0-9._~%-]+$/u;

/** @param {Site} site @param {Job} job */
export function createApplyMailto(site, job) {
  const role = job.title.replace(/^\[[^\]]+\]\s*/u, "");
  const subject = `[채용 문의] ${job.company.name} ${role}`;
  return `mailto:${encodeURIComponent(site.contactEmail).replaceAll("%40", "@")}?subject=${encodeURIComponent(subject)}`;
}

/** @param {Job} job @param {string} origin */
export function createJobPosting(job, origin) {
  if (job.status !== "open" || job.publisherAuthorization?.authorized !== true)
    return undefined;
  return {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description: job.company.summary,
    datePosted: job.datePosted,
    employmentType: job.employment,
    hiringOrganization: {
      "@type": "Organization",
      name: job.company.name,
      sameAs: job.company.website,
      logo: new URL(renderedAssetUrl(job.company.logo), origin).href,
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: job.location,
        addressCountry: "KR",
      },
    },
    url: new URL(`/${job.slug}/`, origin).href,
  };
}

/** @param {PublicDocument[] | undefined} documents */
function renderDocuments(documents) {
  if (!documents?.length) return "";
  const rendered = documents
    .map((document) => {
      const url = safeDocumentUrl(document.url);
      if (!url) return "";
      const preview =
        url.endsWith(".pdf") && !mediaPathPattern.test(url)
          ? `<details class="pdf-preview"><summary>PDF 미리보기</summary><object data="${escapeHtml(url)}" type="application/pdf" title="${escapeHtml(document.label)} PDF 미리보기"><p>미리보기를 지원하지 않는 브라우저입니다. <a href="${escapeHtml(url)}">PDF를 열어 확인하세요.</a></p></object></details>`
          : "";
      return `<div class="document"><a class="action action--secondary" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(document.label)}<span class="visually-hidden">(새 창)</span></a>${preview}</div>`;
    })
    .filter(Boolean)
    .join("");
  return rendered
    ? `<section class="detail-section documents" aria-labelledby="section-documents"><h2 id="section-documents">회사 자료</h2>${rendered}</section>`
    : "";
}

/** @param {Job} job */
function renderHeroMedia(job) {
  const source = job.company.heroImage;
  if (!source) {
    return `<section class="job-media job-media--brand" aria-label="${escapeHtml(job.company.name)} 소개"><img src="${escapeHtml(renderedAssetUrl(job.company.logo))}" alt="${escapeHtml(job.company.name)} 로고" width="184" height="88" data-fallback-image><span class="image-fallback" role="status">${escapeHtml(job.company.name)}</span><p>${escapeHtml(job.company.summary)}</p></section>`;
  }
  return `<figure class="job-media"><img src="${escapeHtml(renderedAssetUrl(source))}" alt="${escapeHtml(job.company.name)} 포지션 소개 이미지" data-fallback-image><figcaption class="image-fallback" role="status">소개 이미지를 불러오지 못했습니다.</figcaption></figure>`;
}

/** @param {Site} site @param {PublicJob} job */
function createApplicationLink(site, job) {
  const application = job.application;
  if (application?.kind === "url") {
    const url = safeHttpsUrl(application.value);
    return url ? { href: url, isExternal: true } : undefined;
  }
  if (application?.kind === "email") {
    return emailPattern.test(application.value)
      ? {
          href: createApplyMailto(
            { ...site, contactEmail: application.value },
            job,
          ),
          isExternal: false,
        }
      : undefined;
  }
  if (application) return undefined;

  const officialUrl = safeHttpsUrl(job.officialStartingApplicationUrl ?? "");
  if (officialUrl) return { href: officialUrl, isExternal: true };
  return emailPattern.test(site.contactEmail)
    ? { href: createApplyMailto(site, job), isExternal: false }
    : undefined;
}

/** @param {string} value */
function renderedAssetUrl(value) {
  return mediaPathPattern.test(value) ? value : assetUrl(value);
}

/** @param {string} value */
function safeDocumentUrl(value) {
  if (value.startsWith("src/")) return assetUrl(value);
  if (mediaPathPattern.test(value)) return value;
  return safeHttpsUrl(value);
}

/** @param {string} value */
function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** @param {{ job: PublicJob, site: Site }} input */
export function renderDetailContent(input) {
  const { job, site } = input;
  const coordinates = job.mapQuery?.match(
    /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/u,
  );
  const mapUrl =
    coordinates?.[1] && coordinates[2]
      ? `https://www.openstreetmap.org/?mlat=${encodeURIComponent(coordinates[1])}&mlon=${encodeURIComponent(coordinates[2])}#map=16/${encodeURIComponent(coordinates[1])}/${encodeURIComponent(coordinates[2])}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.mapQuery ?? job.location)}`;
  const map = job.mapImage
    ? `<a class="location-map" href="${escapeHtml(mapUrl)}" target="_blank" rel="noreferrer" aria-label="${escapeHtml(job.company.name)} 근무지를 지도에서 보기"><img src="${escapeHtml(renderedAssetUrl(job.mapImage))}" alt="${escapeHtml(job.company.name)} 근무지 지도" width="720" height="153"></a>`
    : `<a class="location-map location-map--fallback" href="${escapeHtml(mapUrl)}" target="_blank" rel="noreferrer">지도에서 근무지 보기</a>`;
  const application = createApplicationLink(site, job);
  const apply =
    job.status === "closed"
      ? `<p class="closed-message" role="status">${escapeHtml(job.closedState ?? "현재 채용이 마감된 포지션입니다.")}</p>`
      : application
        ? `<a class="action action--primary" data-apply-link href="${escapeHtml(application.href)}"${application.isExternal ? ' target="_blank" rel="noreferrer"' : ""}>지원하기${application.isExternal ? '<span class="visually-hidden">(새 창)</span>' : ""}</a>`
        : "";
  const utilities = `<div class="job-utilities"><button class="print-control" type="button" data-print-job>인쇄 / PDF 저장</button><p>게시일 <time datetime="${escapeHtml(job.datePosted)}">${escapeHtml(job.datePosted)}</time></p></div>`;
  return `<article class="job-detail">
  <div class="shell job-detail__frame">
    <div class="detail-layout">
      <header class="job-hero">
        <h1>${escapeHtml(job.title)}</h1>
      </header>
      <div class="detail-content">${renderHeroMedia(job)}${renderJobSections(job.sections)}${renderDocuments(job.documents)}${utilities}</div>
      <aside class="job-summary" aria-label="포지션 요약"><dl class="fact-list"><div><dt>직군</dt><dd>${escapeHtml(job.category)}</dd></div><div><dt>직무</dt><dd>${escapeHtml(job.title.replace(/^\[[^\]]+\]\s*/u, ""))}</dd></div><div><dt>경력사항</dt><dd>${escapeHtml(job.experience)}</dd></div><div><dt>고용형태</dt><dd>${escapeHtml(job.employment)}</dd></div><div><dt>근무방식</dt><dd>${escapeHtml(remoteLabels[job.remote] ?? "근무 방식 미기재")}</dd></div><div><dt>근무지</dt><dd>${escapeHtml(job.location)}</dd></div></dl>${map}${apply}</aside>
    </div>
  </div>
</article>`;
}
