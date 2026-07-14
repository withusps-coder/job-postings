import { expect, test } from "@playwright/test";

test("Given the D1-owned listing, when empty filters run, then query state and the empty result remain deterministic", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("searchbox", { name: "키워드" }).fill("없는 공고");
  await page.getByRole("button", { name: "검색" }).click();

  await expect(page).toHaveURL(/\?q=%EC%97%86%EB%8A%94\+%EA%B3%B5%EA%B3%A0$/u);
  await expect(page.locator("[data-result-count]")).toHaveText("0");
  await expect(page.locator("[data-empty-state]")).toBeVisible();

  await page.getByRole("link", { name: "필터 초기화" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.locator("[data-job-card]")).toHaveCount(0);
});

test("Given an unknown public slug, when requested, then a branded non-cacheable 404 is returned", async ({
  page,
}) => {
  const response = await page.goto("/not-a-published-job/");

  expect(response?.status()).toBe(404);
  expect(response?.headers()["cache-control"]).toBe("no-store");
  await expect(
    page.getByRole("heading", { name: "페이지를 찾을 수 없습니다." }),
  ).toBeVisible();
});

test("Given an empty active revision set, when the sitemap is requested, then only the canonical root is emitted", async ({
  request,
}) => {
  const response = await request.get("/sitemap.xml");
  const body = await response.text();

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe(
    "application/xml; charset=UTF-8",
  );
  expect(response.headers()["x-content-revision"]).toBe("list-empty");
  expect(body.match(/<url>/gu)).toHaveLength(1);
  expect(body).not.toContain("ablearn-strategy");
});

test("Given retired filesystem authoring routes, when requested, then they cannot become a parallel authority", async ({
  request,
}) => {
  const [author, validator] = await Promise.all([
    request.get("/author/"),
    request.post("/api/validate-job", { data: {} }),
  ]);

  expect(author.status()).toBe(410);
  expect(author.headers()["cache-control"]).toBe("no-store");
  expect(validator.status()).toBe(410);
  expect(validator.headers()["cache-control"]).toBe("no-store");
});

test("Given no local Access configuration, when an admin document is requested, then the shell fails closed", async ({
  request,
}) => {
  const response = await request.get("/admin/");

  expect(response.status()).toBe(503);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toMatchObject({ code: "ADMIN_UNAVAILABLE" });
});

test("Given public read endpoints, when HEAD is used, then status and cache metadata match GET without a body", async ({
  request,
}) => {
  const [root, sitemap] = await Promise.all([
    request.head("/"),
    request.head("/sitemap.xml"),
  ]);

  expect(root.status()).toBe(200);
  expect(root.headers()["x-content-revision"]).toBe("list-empty");
  expect(await root.body()).toHaveLength(0);
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["x-content-revision"]).toBe("list-empty");
  expect(await sitemap.body()).toHaveLength(0);
});
