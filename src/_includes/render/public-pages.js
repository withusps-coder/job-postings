import siteData from "../../_data/site.json" with { type: "json" };

import {
  createApplyMailto,
  createJobPosting,
  renderDetailContent,
} from "./detail.js";
import { renderDocument } from "./document.js";
import { renderListingContent } from "./listing.js";
import { publicSiteOrigin } from "./site-origin.js";

/** @typedef {import("./types.js").Job} Job */
/** @typedef {import("./types.js").Site} Site */
/** @typedef {import("./types.js").Company} Company */
/** @typedef {import("./types.js").Document} JobDocument */
/** @typedef {import("./types.js").PublisherAuthorization} PublisherAuthorization */
/** @typedef {import("./types.js").Sections} Sections */
/** @typedef {"open" | "closed"} JobStatus */
/** @typedef {{ kind: "email" | "url", value: string }} PublicApplication */
/** @typedef {Company & { mapUrl?: string }} PublicCompany */
/** @typedef {JobDocument & { mimeType?: string }} PublicDocument */
/** @typedef {Job & { company: PublicCompany, application?: PublicApplication }} PublicJob */
/** @typedef {Readonly<{ assetId: string, mimeType: string }>} PublicAsset */
/** @typedef {Readonly<{ assetId?: unknown, mimeType?: unknown }>} SnapshotAssetInput */
/** @typedef {Readonly<{ logo?: unknown, hero?: unknown, map?: unknown }>} SnapshotMediaInput */
/** @typedef {Readonly<{ assetId?: unknown, mimeType?: unknown }>} SnapshotMediaSourceInput */
/** @typedef {Readonly<{ name?: unknown, website?: unknown, summary?: unknown, logo?: unknown, heroImage?: unknown, media?: unknown }>} SnapshotCompanyInput */
/** @typedef {Readonly<{ authorized?: unknown, scope?: unknown, attestedAt?: unknown }>} SnapshotAuthorizationInput */
/** @typedef {Readonly<{ kind?: unknown, value?: unknown, provenance?: unknown }>} SnapshotApplicationInput */
/** @typedef {Readonly<{ label?: unknown, value?: unknown, url?: unknown }>} SnapshotSectionEntryInput */
/** @typedef {Readonly<{ stats?: unknown, company?: unknown, news?: unknown, responsibilities?: unknown, qualifications?: unknown, preferred?: unknown, benefits?: unknown, conditions?: unknown, process?: unknown, notes?: unknown }>} SnapshotSectionsInput */
/** @typedef {Readonly<{ label?: unknown, assetId?: unknown, url?: unknown }>} SnapshotDocumentInput */
/** @typedef {Readonly<{ snapshotSchemaVersion?: unknown, schemaVersion?: unknown, id?: unknown, slug?: unknown, status?: unknown, closedState?: unknown, datePosted?: unknown, publisherAuthorization?: unknown, title?: unknown, category?: unknown, company?: unknown, employment?: unknown, location?: unknown, mapQuery?: unknown, mapImage?: unknown, remote?: unknown, experience?: unknown, tags?: unknown, sections?: unknown, documents?: unknown, officialStartingApplicationUrl?: unknown, application?: unknown, assets?: unknown }>} PublicJobInput */
/** @typedef {PublicJobInput & Readonly<{ snapshotSchemaVersion: 1, slug: string, status: JobStatus }>} ImmutableSnapshot */

const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
const mediaMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const mediaUrlPattern = /^\/media\/[A-Za-z0-9._~%-]+$/u;
const reservedPublicSlugs = new Set([
  "admin",
  "author",
  "api",
  "assets",
  "media",
  "sitemap.xml",
  "robots.txt",
  "manifest.webmanifest",
  "favicon.ico",
  "404.html",
  "build-meta.json",
  "index.html",
]);

/** @type {Site} */
export const publicSite = siteData;

export { createApplyMailto };

/** @param {{ jobs: unknown[], site: Site, origin?: string, immutable?: boolean }} input */
export function renderJobListing(input) {
  const { site } = input;
  const jobs = input.jobs.map((job) =>
    normalizePublicJob(job, site, input.immutable === true),
  );
  return renderDocument({
    site,
    title: `${site.identity.name} ${site.identity.role} | 채용 포지션`,
    description: `${site.identity.name} ${site.identity.role}가 직접 검토한 채용 포지션을 소개합니다.`,
    path: "/",
    ...(input.origin ? { origin: input.origin } : {}),
    content: renderListingContent({ jobs, site }),
    script: '<script src="/assets/scripts/job-filters.js" defer></script>',
  });
}

/** @param {{ job: unknown, site: Site, origin?: string, immutable?: boolean }} input */
export function renderJobDetail(input) {
  const { site } = input;
  const job = normalizePublicJob(input.job, site, input.immutable === true);
  const origin = input.origin ?? publicSiteOrigin;
  const structuredData = createJobPosting(job, origin);
  return renderDocument({
    site,
    title: `${job.title} | ${site.identity.name} ${site.identity.role}`,
    description: job.company.summary,
    path: `/${job.slug}/`,
    ...(input.origin ? { origin } : {}),
    content: renderDetailContent({ job, site }),
    bodyClass: "job-page",
    ...(structuredData ? { structuredData } : {}),
    script: '<script src="/assets/scripts/job-detail.js" defer></script>',
  });
}

/** @param {{ site: Site, origin?: string, status: 404 | 503 }} input */
export function renderPublicError(input) {
  const unavailable = input.status === 503;
  const heading = unavailable
    ? "채용 정보를 불러올 수 없습니다."
    : "페이지를 찾을 수 없습니다.";
  const description = unavailable
    ? "잠시 후 다시 시도해 주세요."
    : "주소가 변경되었거나 더 이상 제공되지 않는 페이지입니다.";
  return renderDocument({
    site: input.site,
    title: `${heading} | ${input.site.identity.name} ${input.site.identity.role}`,
    description,
    path: unavailable ? "/" : "/404.html",
    ...(input.origin ? { origin: input.origin } : {}),
    robots: "noindex",
    bodyClass: "error-page",
    content: `<section class="message-page shell"><p class="eyebrow">${input.status}</p><h1>${heading}</h1><p>${description}</p><a class="action action--primary" href="/">${input.site.identity.name} 헤드헌터 홈으로</a></section>`,
  });
}

/** @param {unknown} configuredOrigin */
export function resolvePublicOrigin(configuredOrigin) {
  if (typeof configuredOrigin !== "string" || !configuredOrigin.trim()) {
    return publicSiteOrigin;
  }
  try {
    const value = configuredOrigin.startsWith("https://")
      ? configuredOrigin
      : `https://${configuredOrigin}`;
    const origin = new URL(value);
    return origin.protocol === "https:" && origin.hostname
      ? origin.origin
      : publicSiteOrigin;
  } catch {
    return publicSiteOrigin;
  }
}
/** @param {unknown} value */
export function isReservedPublicSlug(value) {
  return typeof value === "string" && reservedPublicSlugs.has(value);
}

/**
 * Validates a persisted immutable snapshot before a public function compares or
 * renders it. The returned value remains the original immutable JSON object.
 *
 * @param {unknown} value
 * @param {Site} site
 * @returns {ImmutableSnapshot}
 */
export function validateImmutableSnapshot(value, site) {
  const snapshot = requireImmutableSnapshot(value);
  normalizeImmutablePublicJob(snapshot, site);
  return snapshot;
}

/** @param {unknown} value @param {Site} site @param {boolean} [requireSnapshot] @returns {PublicJob} */
function normalizePublicJob(value, site, requireSnapshot = false) {
  const input = requirePublicJobInput(value);
  if (input.snapshotSchemaVersion !== undefined) {
    return normalizeImmutablePublicJob(requireImmutableSnapshot(input), site);
  }
  if (requireSnapshot) throw new TypeError("Immutable snapshot is invalid.");
  return normalizeSourcePublicJob(input);
}

/** @param {ImmutableSnapshot} snapshot @param {Site} site @returns {PublicJob} */
function normalizeImmutablePublicJob(snapshot, site) {
  const assets = normalizeAssets(snapshot.assets);
  const company = normalizeSnapshotCompany(
    requireSnapshotCompanyInput(snapshot.company, "company"),
    assets,
    site,
  );
  const status = requireStatus(snapshot.status);
  const documents = normalizeSnapshotDocuments(snapshot.documents, assets);
  /** @type {PublicJob} */
  const job = {
    schemaVersion: requireSchemaVersion(snapshot.schemaVersion),
    id: requireText(snapshot.id, "id"),
    slug: requireSlug(snapshot.slug),
    status,
    datePosted: requireText(snapshot.datePosted, "datePosted"),
    publisherAuthorization: normalizeAuthorization(
      snapshot.publisherAuthorization,
    ),
    title: requireText(snapshot.title, "title"),
    category: requireText(snapshot.category, "category"),
    company,
    employment: requireText(snapshot.employment, "employment"),
    location: requireText(snapshot.location, "location"),
    remote: requireRemote(snapshot.remote),
    experience: requireText(snapshot.experience, "experience"),
    tags: requireTextList(snapshot.tags, "tags"),
    sections: normalizeSections(snapshot.sections),
    application: normalizeApplication(snapshot.application),
  };
  if (status === "closed") {
    job.closedState = requireText(snapshot.closedState, "closedState");
  }
  const mapQuery = optionalText(snapshot.mapQuery);
  if (mapQuery) job.mapQuery = mapQuery;
  if (company.mapUrl) job.mapImage = company.mapUrl;
  if (documents.length) job.documents = documents;
  return job;
}

/** @param {PublicJobInput} source @returns {PublicJob} */
function normalizeSourcePublicJob(source) {
  const company = normalizeSourceCompany(
    requireSnapshotCompanyInput(source.company, "company"),
  );
  const status = requireStatus(source.status);
  const documents = normalizeSourceDocuments(source.documents);
  /** @type {PublicJob} */
  const job = {
    schemaVersion: requireSchemaVersion(source.schemaVersion),
    id: requireText(source.id, "id"),
    slug: requireSlug(source.slug),
    status,
    datePosted: requireText(source.datePosted, "datePosted"),
    publisherAuthorization: normalizeAuthorization(
      source.publisherAuthorization,
    ),
    title: requireText(source.title, "title"),
    category: requireText(source.category, "category"),
    company,
    employment: requireText(source.employment, "employment"),
    location: requireText(source.location, "location"),
    remote: requireRemote(source.remote),
    experience: requireText(source.experience, "experience"),
    tags: requireTextList(source.tags, "tags"),
    sections: normalizeSections(source.sections),
  };
  if (status === "closed") {
    job.closedState = requireText(source.closedState, "closedState");
  }
  const mapQuery = optionalText(source.mapQuery);
  if (mapQuery) job.mapQuery = mapQuery;
  const mapImage = optionalLocalImageSource(source.mapImage, "map image");
  if (mapImage) job.mapImage = mapImage;
  const applicationUrl = optionalHttpsUrl(
    source.officialStartingApplicationUrl,
    "application URL",
  );
  if (applicationUrl) job.officialStartingApplicationUrl = applicationUrl;
  if (documents.length) job.documents = documents;
  return job;
}

/** @param {unknown} value @returns {ReadonlyMap<string, PublicAsset>} */
function normalizeAssets(value) {
  if (!Array.isArray(value))
    throw new TypeError("Snapshot assets are invalid.");
  /** @type {Map<string, PublicAsset>} */
  const assets = new Map();
  for (const entry of value) {
    const asset = requireSnapshotAssetInput(entry);
    const assetId = requireAssetId(asset.assetId);
    const mimeType = requireText(asset.mimeType, "asset mime type");
    assets.set(assetId, { assetId, mimeType });
  }
  return assets;
}

/** @param {SnapshotCompanyInput} value @param {ReadonlyMap<string, PublicAsset>} assets @param {Site} site @returns {PublicCompany} */
function normalizeSnapshotCompany(value, assets, site) {
  const media = optionalSnapshotMediaInput(value.media);
  const logo =
    (media ? imageMediaSource(media.logo, assets) : undefined) ??
    site.brand.faviconPath;
  const heroImage = media ? imageMediaSource(media.hero, assets) : undefined;
  const mapUrl = media ? imageMediaSource(media.map, assets) : undefined;
  /** @type {PublicCompany} */
  const company = {
    name: requireText(value.name, "company name"),
    website: safeHttpsUrl(requireText(value.website, "company website")),
    summary: requireText(value.summary, "company summary"),
    logo,
  };
  if (heroImage) company.heroImage = heroImage;
  if (mapUrl) company.mapUrl = mapUrl;
  return company;
}

/** @param {SnapshotCompanyInput} value @returns {PublicCompany} */
function normalizeSourceCompany(value) {
  /** @type {PublicCompany} */
  const company = {
    name: requireText(value.name, "company name"),
    website: safeHttpsUrl(requireText(value.website, "company website")),
    summary: requireText(value.summary, "company summary"),
    logo: requireLocalImageSource(value.logo, "company logo"),
  };
  const heroImage = optionalLocalImageSource(value.heroImage, "company hero");
  if (heroImage) company.heroImage = heroImage;
  return company;
}

/** @param {unknown} value @param {ReadonlyMap<string, PublicAsset>} assets */
function imageMediaSource(value, assets) {
  const media = optionalSnapshotMediaSourceInput(value);
  if (
    !media ||
    typeof media.mimeType !== "string" ||
    !mediaMimeTypes.has(media.mimeType)
  ) {
    return undefined;
  }
  const asset = assets.get(requireAssetId(media.assetId));
  return asset && mediaMimeTypes.has(asset.mimeType)
    ? canonicalMediaSource(asset.assetId)
    : undefined;
}

/** @param {unknown} value @returns {PublisherAuthorization} */
function normalizeAuthorization(value) {
  const authorization = requireSnapshotAuthorizationInput(
    value,
    "publisher authorization",
  );
  if (
    authorization.authorized !== true ||
    authorization.scope !== "published-job"
  ) {
    throw new TypeError("Snapshot publisher authorization is invalid.");
  }
  return {
    authorized: true,
    scope: "published-job",
    attestedAt: requireText(
      authorization.attestedAt,
      "authorization timestamp",
    ),
  };
}

/** @param {unknown} value @returns {PublicApplication} */
function normalizeApplication(value) {
  const application = requireSnapshotApplicationInput(value, "application");
  const kind = application.kind;
  const rawValue = requireText(application.value, "application value");
  requireText(application.provenance, "application provenance");
  if (kind === "email" && emailPattern.test(rawValue)) {
    return { kind, value: rawValue };
  }
  if (kind === "url") return { kind, value: safeHttpsUrl(rawValue) };
  throw new TypeError("Snapshot application is invalid.");
}

/** @param {unknown} value @param {ReadonlyMap<string, PublicAsset>} assets @returns {PublicDocument[]} */
function normalizeSnapshotDocuments(value, assets) {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new TypeError("Snapshot documents are invalid.");
  return value.flatMap((entry) => {
    const document = requireSnapshotDocumentInput(entry, "document");
    const label = requireText(document.label, "document label");
    if (typeof document.assetId === "string") {
      const asset = assets.get(requireAssetId(document.assetId));
      return asset
        ? [
            {
              label,
              url: canonicalMediaUrl(asset.assetId),
              mimeType: asset.mimeType,
            },
          ]
        : [];
    }
    if (typeof document.url !== "string") return [];
    if (mediaUrlPattern.test(document.url)) {
      const asset = [...assets.values()].find(
        (candidate) => canonicalMediaUrl(candidate.assetId) === document.url,
      );
      return asset
        ? [
            {
              label,
              url: canonicalMediaUrl(asset.assetId),
              mimeType: asset.mimeType,
            },
          ]
        : [];
    }
    return [{ label, url: safeHttpsUrl(document.url) }];
  });
}

/** @param {unknown} value @returns {PublicDocument[]} */
function normalizeSourceDocuments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new TypeError("Source documents are invalid.");
  return value.map((entry) => {
    const document = requireSnapshotDocumentInput(entry, "document");
    return {
      label: requireText(document.label, "document label"),
      url: normalizeSourceDocumentUrl(document.url),
    };
  });
}

/** @param {unknown} value @returns {Sections} */
function normalizeSections(value) {
  const sections = requireSnapshotSectionsInput(value, "sections");
  /** @type {Sections} */
  const normalized = {
    responsibilities: requireTextList(
      sections.responsibilities,
      "responsibilities",
    ),
    qualifications: requireTextList(sections.qualifications, "qualifications"),
  };
  if (sections.stats !== undefined) {
    normalized.stats = requireSectionRecordList(sections.stats, "stats").map(
      (stat) => ({
        label: requireText(stat.label, "stat label"),
        value: requireText(stat.value, "stat value"),
      }),
    );
  }
  if (sections.company !== undefined) {
    normalized.company = requireTextList(sections.company, "company section");
  }
  if (sections.news !== undefined) {
    normalized.news = requireSectionRecordList(sections.news, "news").map(
      (news) => ({
        label: requireText(news.label, "news label"),
        url: safeHttpsUrl(requireText(news.url, "news URL")),
      }),
    );
  }
  if (sections.preferred !== undefined) {
    normalized.preferred = requireTextList(sections.preferred, "preferred");
  }
  if (sections.benefits !== undefined) {
    normalized.benefits = requireTextList(sections.benefits, "benefits");
  }
  if (sections.conditions !== undefined) {
    normalized.conditions = requireTextList(sections.conditions, "conditions");
  }
  if (sections.process !== undefined) {
    normalized.process = requireTextList(sections.process, "process");
  }
  if (sections.notes !== undefined) {
    normalized.notes = requireTextList(sections.notes, "notes");
  }
  return normalized;
}

/** @param {unknown} value @param {string} name @returns {SnapshotSectionEntryInput[]} */
function requireSectionRecordList(value, name) {
  if (!Array.isArray(value))
    throw new TypeError(`Snapshot ${name} is invalid.`);
  return value.map((entry) => requireSnapshotSectionEntryInput(entry, name));
}

/** @param {unknown} value @param {string} name */
function requireTextList(value, name) {
  if (!Array.isArray(value))
    throw new TypeError(`Snapshot ${name} is invalid.`);
  return value.map((entry) => requireText(entry, name));
}

/** @param {unknown} value @returns {JobStatus} */
function requireStatus(value) {
  if (value === "open" || value === "closed") return value;
  throw new TypeError("Snapshot status is invalid.");
}

/** @param {unknown} value @returns {"onsite" | "hybrid" | "remote"} */
function requireRemote(value) {
  if (value === "onsite" || value === "hybrid" || value === "remote") {
    return value;
  }
  throw new TypeError("Snapshot remote mode is invalid.");
}

/** @param {unknown} value */
function requireSchemaVersion(value) {
  if (value === 1) return value;
  throw new TypeError("Snapshot schema version is invalid.");
}

/** @param {unknown} value */
function requireSlug(value) {
  const slug = requireText(value, "slug");
  if (!isPublicSlug(slug) || isReservedPublicSlug(slug)) {
    throw new TypeError("Snapshot slug is invalid.");
  }
  return slug;
}

/** @param {unknown} value */
function isPublicSlug(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

/** @param {unknown} value */
function requireAssetId(value) {
  const assetId = requireText(value, "asset ID");
  if (assetId.length > 128)
    throw new TypeError("Snapshot asset ID is invalid.");
  return assetId;
}

/** @param {string} assetId */
function canonicalMediaUrl(assetId) {
  return `/media/${encodeURIComponent(assetId)}`;
}

/** @param {string} assetId */
function canonicalMediaSource(assetId) {
  return `media/${encodeURIComponent(assetId)}`;
}

/** @param {unknown} value @param {string} name */
function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Snapshot ${name} is invalid.`);
  }
  return value;
}

/** @param {unknown} value */
function optionalText(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** @param {unknown} value @param {string} name */
function requireLocalImageSource(value, name) {
  const source = requireText(value, name);
  if (
    !/^src\/assets\/(?!.*\.\.)[a-z0-9][a-z0-9._/-]*\.(?:png|jpe?g|webp)$/u.test(
      source,
    )
  ) {
    throw new TypeError(`Snapshot ${name} is invalid.`);
  }
  return source;
}

/** @param {unknown} value @param {string} name */
function optionalLocalImageSource(value, name) {
  return value === undefined ? undefined : requireLocalImageSource(value, name);
}

/** @param {unknown} value @param {string} name */
function optionalHttpsUrl(value, name) {
  return value === undefined
    ? undefined
    : safeHttpsUrl(requireText(value, name));
}

/** @param {unknown} value */
function normalizeSourceDocumentUrl(value) {
  const url = requireText(value, "document URL");
  if (/^src\/assets\/(?!.*\.\.)[a-z0-9][a-z0-9._/-]*\.pdf$/u.test(url)) {
    return url;
  }
  return safeHttpsUrl(url);
}

/** @param {unknown} value @returns {PublicJobInput} */
function requirePublicJobInput(value) {
  if (!isRecord(value)) throw new TypeError("Public job is invalid.");
  return value;
}

/** @param {unknown} value @returns {ImmutableSnapshot} */
function requireImmutableSnapshot(value) {
  if (!isImmutableSnapshot(value)) {
    throw new TypeError("Immutable snapshot is invalid.");
  }
  return value;
}

/** @param {unknown} value @returns {value is ImmutableSnapshot} */
function isImmutableSnapshot(value) {
  return (
    isRecord(value) &&
    value["snapshotSchemaVersion"] === 1 &&
    isPublicSlug(value["slug"]) &&
    !isReservedPublicSlug(value["slug"]) &&
    (value["status"] === "open" || value["status"] === "closed")
  );
}

/** @param {unknown} value @returns {SnapshotAssetInput} */
function requireSnapshotAssetInput(value) {
  if (!isRecord(value)) throw new TypeError("Snapshot asset is invalid.");
  return value;
}

/** @param {unknown} value @param {string} name @returns {SnapshotCompanyInput} */
function requireSnapshotCompanyInput(value, name) {
  if (!isRecord(value)) throw new TypeError(`Snapshot ${name} is invalid.`);
  return value;
}

/** @param {unknown} value @returns {SnapshotMediaInput | undefined} */
function optionalSnapshotMediaInput(value) {
  return isRecord(value) ? value : undefined;
}
/** @param {unknown} value @returns {SnapshotMediaSourceInput | undefined} */
function optionalSnapshotMediaSourceInput(value) {
  return isRecord(value) ? value : undefined;
}

/** @param {unknown} value @param {string} name @returns {SnapshotAuthorizationInput} */
function requireSnapshotAuthorizationInput(value, name) {
  if (!isRecord(value)) throw new TypeError(`Snapshot ${name} is invalid.`);
  return value;
}

/** @param {unknown} value @param {string} name @returns {SnapshotApplicationInput} */
function requireSnapshotApplicationInput(value, name) {
  if (!isRecord(value)) throw new TypeError(`Snapshot ${name} is invalid.`);
  return value;
}

/** @param {unknown} value @param {string} name @returns {SnapshotSectionsInput} */
function requireSnapshotSectionsInput(value, name) {
  if (!isRecord(value)) throw new TypeError(`Snapshot ${name} is invalid.`);
  return value;
}

/** @param {unknown} value @param {string} name @returns {SnapshotSectionEntryInput} */
function requireSnapshotSectionEntryInput(value, name) {
  if (!isRecord(value)) throw new TypeError(`Snapshot ${name} is invalid.`);
  return value;
}

/** @param {unknown} value @param {string} name @returns {SnapshotDocumentInput} */
function requireSnapshotDocumentInput(value, name) {
  if (!isRecord(value)) throw new TypeError(`Snapshot ${name} is invalid.`);
  return value;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} value */
function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname) {
      throw new TypeError("URL is not HTTPS.");
    }
    return url.href;
  } catch {
    throw new TypeError("Snapshot URL is invalid.");
  }
}
