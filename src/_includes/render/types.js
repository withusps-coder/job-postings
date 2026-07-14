/** @typedef {{ name: string, role: string, affiliation: string }} Identity */
/** @typedef {{ wordmarkPath: string, faviconPath: string }} Brand */
/** @typedef {{ schemaVersion: number, identity: Identity, contactEmail: string, linkedinUrl: string, brand: Brand }} Site */
/** @typedef {{ name: string, website: string, summary: string, logo: string, heroImage?: string }} Company */
/** @typedef {{ label: string, value: string }} Stat */
/** @typedef {{ label: string, url: string }} Link */
/** @typedef {{ label: string, url: string }} Document */
/** @typedef {{ authorized: true, scope: "published-job", attestedAt: string }} PublisherAuthorization */
/**
 * @typedef {object} Sections
 * @property {Stat[]=} stats
 * @property {string[]=} company
 * @property {Link[]=} news
 * @property {string[]} responsibilities
 * @property {string[]} qualifications
 * @property {string[]=} preferred
 * @property {string[]=} benefits
 * @property {string[]=} conditions
 * @property {string[]=} process
 * @property {string[]=} notes
 */
/**
 * @typedef {object} Job
 * @property {number} schemaVersion
 * @property {string} id
 * @property {string} slug
 * @property {"open" | "closed"} status
 * @property {string=} closedState
 * @property {string} datePosted
 * @property {PublisherAuthorization} publisherAuthorization
 * @property {string} title
 * @property {string} category
 * @property {Company} company
 * @property {string} employment
 * @property {string} location
 * @property {string=} mapQuery
 * @property {string=} mapImage
 * @property {"onsite" | "hybrid" | "remote"} remote
 * @property {string} experience
 * @property {string[]} tags
 * @property {Sections} sections
 * @property {Document[]=} documents
 * @property {string=} officialStartingApplicationUrl
 */

export {};
