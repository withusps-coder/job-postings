import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as renderJobDetail } from "../functions/[slug].js";
import { onRequest as renderJobListing } from "../functions/index.js";
import { onRequest as servePublicMedia } from "../functions/media/[assetId].js";
import { enforcePublicHost } from "../functions/_lib/public-host.js";
import { onRequest as renderSitemap } from "../functions/sitemap.xml.js";

/** @typedef {Parameters<typeof renderJobListing>[0]} RootContext */
/** @typedef {Parameters<typeof renderJobDetail>[0]} DetailContext */
/** @typedef {Parameters<typeof renderSitemap>[0]} SitemapContext */
/** @typedef {Parameters<typeof servePublicMedia>[0]} MediaContext */
/** @typedef {{ d1Reads: number, r2Reads: number }} BindingReads */
/**
 * @typedef {{
 *   label: string,
 *   path: string,
 *   params: Record<string, string>,
 *   invoke: (context: unknown) => Promise<Response>
 * }} HostProtectedRoute
 */

const canonicalHost = "jobs.example.test";
const pagesHost = "careers-production.pages.dev";
const canonicalOrigin = `https://${canonicalHost}`;
const publicHostEnvironment = {
  DEPLOYMENT_ENVIRONMENT: "production",
  PUBLIC_CANONICAL_HOST: canonicalHost,
  PUBLIC_PAGES_HOST: pagesHost,
};
const mediaAssetId = "00000000-0000-4000-8000-000000000001";

/**
 * @param {string} url
 * @param {Record<string, string>} [headers]
 */
function publicRequest(url, headers = {}) {
  const requestUrl = new URL(url);
  return new Request(url, {
    headers: {
      host: requestUrl.host,
      ...headers,
    },
  });
}

/**
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @param {Record<string, string>} params
 */
function handlerContext(request, env, params) {
  return {
    request,
    functionPath: new URL(request.url).pathname,
    /** @param {Promise<unknown>} promise */
    waitUntil(promise) {
      void promise;
    },
    passThroughOnException() {},
    async next() {
      return new Response(null, { status: 404 });
    },
    env,
    params,
    data: undefined,
  };
}

/** @param {unknown} context @returns {RootContext} */
function asRootContext(context) {
  return /** @type {RootContext} */ (context);
}

/** @param {unknown} context @returns {DetailContext} */
function asDetailContext(context) {
  return /** @type {DetailContext} */ (context);
}

/** @param {unknown} context @returns {SitemapContext} */
function asSitemapContext(context) {
  return /** @type {SitemapContext} */ (context);
}

/** @param {unknown} context @returns {MediaContext} */
function asMediaContext(context) {
  return /** @type {MediaContext} */ (context);
}

/** @type {readonly HostProtectedRoute[]} */
const hostProtectedRoutes = [
  {
    label: "root",
    path: "/?source=host-test",
    params: {},
    invoke(context) {
      return renderJobListing(asRootContext(context));
    },
  },
  {
    label: "detail",
    path: "/a-role/?source=host-test",
    params: { slug: "a-role" },
    invoke(context) {
      return renderJobDetail(asDetailContext(context));
    },
  },
  {
    label: "sitemap",
    path: "/sitemap.xml?source=host-test",
    params: {},
    invoke(context) {
      return renderSitemap(asSitemapContext(context));
    },
  },
  {
    label: "media",
    path: `/media/${mediaAssetId}?source=host-test`,
    params: { assetId: mediaAssetId },
    invoke(context) {
      return servePublicMedia(asMediaContext(context));
    },
  },
];

function createBindingReadProbe() {
  /** @type {BindingReads} */
  const reads = { d1Reads: 0, r2Reads: 0 };
  const database = {
    withSession() {
      reads.d1Reads += 1;
      throw new Error("The public-host gate must run before D1 reads.");
    },
    prepare() {
      reads.d1Reads += 1;
      throw new Error("The public-host gate must run before D1 reads.");
    },
  };
  const bucket = {
    get() {
      reads.r2Reads += 1;
      throw new Error("The public-host gate must run before R2 reads.");
    },
  };

  return {
    reads,
    env: {
      ...publicHostEnvironment,
      DB: database,
      JOB_MEDIA: bucket,
    },
  };
}

/**
 * @param {Response | undefined} response
 * @param {421 | 308} expectedStatus
 * @returns {Response}
 */
function assertHostGateResponse(response, expectedStatus) {
  if (response === undefined) {
    throw new Error("Expected the public-host gate to return a response.");
  }
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  if (expectedStatus === 421) {
    assert.equal(response.headers.get("location"), null);
  }
  return response;
}

/** @param {string} host @param {421 | 308} expectedStatus */
async function assertEveryPublicHandlerStopsBeforeBindings(
  host,
  expectedStatus,
) {
  for (const route of hostProtectedRoutes) {
    const { reads, env } = createBindingReadProbe();
    const response = await route.invoke(
      handlerContext(
        publicRequest(`https://${host}${route.path}`),
        env,
        route.params,
      ),
    );

    assertHostGateResponse(response, expectedStatus);
    assert.deepEqual(
      reads,
      { d1Reads: 0, r2Reads: 0 },
      `${route.label} must enforce the public-host gate before bindings`,
    );
  }
}

test("Given the exact production canonical HTTPS host, when the public-host gate runs, then it proceeds", () => {
  assert.equal(
    enforcePublicHost(
      publicRequest(`${canonicalOrigin}/open-roles/?category=engineering`),
      publicHostEnvironment,
    ),
    undefined,
  );
});

test("Given the Pages default host as canonical, when no custom domain exists, then exact HTTPS reads proceed", () => {
  const pagesOnlyEnvironment = {
    DEPLOYMENT_ENVIRONMENT: "production",
    PUBLIC_CANONICAL_HOST: pagesHost,
    PUBLIC_PAGES_HOST: pagesHost,
  };

  assert.equal(
    enforcePublicHost(
      publicRequest(`https://${pagesHost}/open-roles/`),
      pagesOnlyEnvironment,
    ),
    undefined,
  );
});

test("Given a branch Pages host as staging canonical, when the public-host gate runs, then exact HTTPS reads proceed", () => {
  const stagingPagesHost = "staging.majesty-recruiting.pages.dev";
  const stagingEnvironment = {
    DEPLOYMENT_ENVIRONMENT: "staging",
    STAGING_CANONICAL_HOST: stagingPagesHost,
    STAGING_PAGES_HOST: stagingPagesHost,
  };

  assert.equal(
    enforcePublicHost(
      publicRequest(`https://${stagingPagesHost}/open-roles/`),
      stagingEnvironment,
    ),
    undefined,
  );
});

test("Given the production Pages default host, when it receives a safe read, then it permanently redirects to the canonical target", () => {
  const pathAndQuery = "/open-roles/?category=engineering&source=pages";
  const response = assertHostGateResponse(
    enforcePublicHost(
      publicRequest(`https://${pagesHost}${pathAndQuery}`),
      publicHostEnvironment,
    ),
    308,
  );

  assert.equal(
    response.headers.get("location"),
    `${canonicalOrigin}${pathAndQuery}`,
  );
});

test("Given hash, branch, and custom aliases, when the public-host gate runs, then every alias fails closed", () => {
  for (const aliasHost of [
    `c0ffee12.${pagesHost}`,
    `feature-branch.${pagesHost}`,
    "preview.jobs.example.test",
  ]) {
    assertHostGateResponse(
      enforcePublicHost(
        publicRequest(
          `https://${aliasHost}/open-roles/?next=https%3A%2F%2Fevil.example`,
        ),
        publicHostEnvironment,
      ),
      421,
    );
  }
});

test("Given a mismatched forwarded host or HTTP canonical request, when the public-host gate runs, then it fails closed", () => {
  assertHostGateResponse(
    enforcePublicHost(
      publicRequest(`${canonicalOrigin}/`, {
        "x-forwarded-host": "evil.example.test",
      }),
      publicHostEnvironment,
    ),
    421,
  );
  assertHostGateResponse(
    enforcePublicHost(
      publicRequest(`http://${canonicalHost}/`),
      publicHostEnvironment,
    ),
    421,
  );
});

test("Given explicit loopback development hosts, when the public-host gate runs, then local HTTP proceeds without deployment configuration", () => {
  for (const localUrl of [
    "http://127.0.0.1:8788/open-roles/",
    "http://localhost:8788/open-roles/",
  ]) {
    assert.equal(enforcePublicHost(publicRequest(localUrl), {}), undefined);
  }
});

test("Given a Pages request with an unsafe-looking target, when it redirects, then its origin remains canonical", () => {
  const request = publicRequest(
    `https://${pagesHost}//evil.example/%2Fescape?next=https%3A%2F%2Fevil.example&return=%2F%2Fevil.example`,
  );
  const response = assertHostGateResponse(
    enforcePublicHost(request, publicHostEnvironment),
    308,
  );
  const location = response.headers.get("location");
  assert.ok(location);

  const redirected = new URL(location);
  const source = new URL(request.url);
  assert.equal(redirected.origin, canonicalOrigin);
  assert.equal(redirected.username, "");
  assert.equal(redirected.password, "");
  assert.equal(redirected.pathname, source.pathname);
  assert.equal(redirected.search, source.search);
});

test("Given a rejected public alias, when root, detail, sitemap, and media handlers run, then all stop before D1 or R2", async () => {
  await assertEveryPublicHandlerStopsBeforeBindings(
    "preview.jobs.example.test",
    421,
  );
});

test("Given the production Pages host, when root, detail, sitemap, and media handlers run, then all redirect before D1 or R2", async () => {
  await assertEveryPublicHandlerStopsBeforeBindings(pagesHost, 308);
});
