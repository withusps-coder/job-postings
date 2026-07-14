import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

/** @param {string} path */
const output = (path) =>
  readFile(new URL(`../_site/${path}`, import.meta.url), "utf8");

/** @param {string} path */
const source = (path) => new URL(`../src/${path}`, import.meta.url);

/** @param {string} path */
const generated = (path) => new URL(`../_site/${path}`, import.meta.url);

test("Given a D1-owned public runtime, when Eleventy emits its shell, then only the admin workspace is static", async () => {
  const html = await output("admin/index.html");

  assert.match(
    html,
    /<meta name="robots" content="noindex, nofollow, noarchive">/u,
  );
  assert.match(html, /data-admin-form/u);
  await Promise.all(
    ["404.html", "robots.txt", "manifest.webmanifest", "build-meta.json"].map(
      (path) => access(generated(path)),
    ),
  );
  await Promise.all(
    [
      "index.html",
      "ablearn-strategy/index.html",
      "author/index.html",
      "sitemap.xml",
    ].map((path) =>
      assert.rejects(() => access(generated(path)), { code: "ENOENT" }),
    ),
  );
});

test("Given the Pages route manifest, when public paths are resolved, then Functions own the root, detail, sitemap, and retired author routes", async () => {
  const routes = JSON.parse(await output("_routes.json"));

  assert.deepEqual(routes, {
    version: 1,
    include: ["/*"],
    exclude: [
      "/assets/*",
      "/robots.txt",
      "/manifest.webmanifest",
      "/favicon.ico",
      "/404.html",
      "/build-meta.json",
    ],
  });
});

test("Given the D1 cutover, when retired publishing sources are inspected, then no filesystem authority remains", async () => {
  await Promise.all(
    [
      "_data/jobs.js",
      "index.11ty.js",
      "job.11ty.js",
      "sitemap.11ty.js",
      "author.11ty.js",
      "jobs/ablearn-strategy.json",
    ].map((path) =>
      assert.rejects(() => access(source(path)), { code: "ENOENT" }),
    ),
  );
});
