import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("Given an initialized empty D1, when the public root loads, then the D1-owned listing is accessible", async ({
  page,
}) => {
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toBe(
    "public, max-age=0, s-maxage=10, must-revalidate",
  );
  expect(response?.headers()["x-content-revision"]).toBe("list-empty");
  await expect(
    page.getByRole("heading", { name: "현재 채용 중인 포지션" }),
  ).toBeVisible();
  await expect(page.locator("[data-result-count]")).toHaveText("0");
  await expect(page.locator("[data-job-card]")).toHaveCount(0);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("Given the Pages runtime, when health is requested, then the Function responds without caching", async ({
  request,
}) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  await expect(response.json()).resolves.toEqual({
    status: "ok",
    method: "GET",
  });
});
