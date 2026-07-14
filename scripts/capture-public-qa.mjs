import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:9877";
const evidence = resolve(".omo/evidence/task-8-personal-recruiter-site");
const viewports = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 960 },
];
const routes = [
  ["home", "/"],
  ["ablearn-strategy", "/ablearn-strategy/"],
  ["404", "/route-that-does-not-exist"],
];

await mkdir(resolve(evidence, "screenshots"), { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = { baseUrl, routes: [], states: [], cleanup: {} };

for (const viewport of viewports) {
  for (const [name, path] of routes) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const response = await page.goto(`${baseUrl}${path}`, {
      waitUntil: "networkidle",
    });
    const axe = await new AxeBuilder({ page }).analyze();
    const screenshot = `screenshots/${viewport.width}-${name}.png`;
    await page.screenshot({
      path: resolve(evidence, screenshot),
      fullPage: true,
    });
    report.routes.push({
      viewport: viewport.width,
      name,
      path,
      status: response?.status(),
      title: await page.title(),
      axeViolations: axe.violations,
      consoleErrors: errors,
      screenshot,
    });
    await context.close();
  }

  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("searchbox", { name: "키워드" }).fill("사업 전략");
  await page.getByRole("button", { name: "검색" }).click();
  await page.screenshot({
    path: resolve(evidence, `screenshots/${viewport.width}-search.png`),
    fullPage: true,
  });
  const searchState = {
    url: page.url(),
    count: await page.locator("[data-result-count]").textContent(),
  };
  await page.getByRole("searchbox", { name: "키워드" }).fill("");
  await page.getByRole("combobox", { name: "직군" }).selectOption("기획");
  await page
    .getByRole("combobox", { name: "회사" })
    .selectOption("에이블런(ABLEARN)");
  await page.getByRole("button", { name: "검색" }).click();
  await page.screenshot({
    path: resolve(evidence, `screenshots/${viewport.width}-combined.png`),
    fullPage: true,
  });
  const combinedState = {
    url: page.url(),
    count: await page.locator("[data-result-count]").textContent(),
  };
  await page.goBack();
  const backState = {
    url: page.url(),
    count: await page.locator("[data-result-count]").textContent(),
  };
  await page.goForward();
  const forwardState = {
    url: page.url(),
    count: await page.locator("[data-result-count]").textContent(),
  };
  await page
    .getByRole("searchbox", { name: "키워드" })
    .fill("존재하지않는직무");
  await page.getByRole("combobox", { name: "직군" }).selectOption("");
  await page.getByRole("combobox", { name: "회사" }).selectOption("");
  await page.getByRole("button", { name: "검색" }).click();
  await page.screenshot({
    path: resolve(evidence, `screenshots/${viewport.width}-empty.png`),
    fullPage: true,
  });
  await page.getByRole("link", { name: "필터 초기화" }).focus();
  await page.screenshot({
    path: resolve(evidence, `screenshots/${viewport.width}-keyboard-focus.png`),
    fullPage: true,
  });
  await page.keyboard.press("Enter");
  const resetState = {
    url: page.url(),
    count: await page.locator("[data-result-count]").textContent(),
    focused: await page
      .getByRole("searchbox", { name: "키워드" })
      .evaluate((element) => element === document.activeElement),
  };
  const card = page.locator("[data-job-card]").first();
  await page.screenshot({
    path: resolve(evidence, `screenshots/${viewport.width}-motion-rest.png`),
  });
  await card.hover();
  await page.waitForTimeout(75);
  await page.screenshot({
    path: resolve(evidence, `screenshots/${viewport.width}-motion-mid.png`),
  });
  await page.waitForTimeout(100);
  await page.screenshot({
    path: resolve(evidence, `screenshots/${viewport.width}-motion-settled.png`),
  });
  report.states.push({
    viewport: viewport.width,
    searchState,
    combinedState,
    backState,
    forwardState,
    resetState,
  });
  await page.close();

  const noScript = await browser.newPage({
    viewport,
    javaScriptEnabled: false,
  });
  await noScript.goto(baseUrl, { waitUntil: "networkidle" });
  await noScript.screenshot({
    path: resolve(
      evidence,
      `screenshots/${viewport.width}-javascript-disabled.png`,
    ),
    fullPage: true,
  });
  report.states.push({
    viewport: viewport.width,
    javascriptDisabledCards: await noScript.locator("[data-job-card]").count(),
  });
  await noScript.close();

  const broken = await browser.newPage({ viewport });
  await broken.route("**/logo-ablearn.png", (route) => route.abort());
  await broken.goto(`${baseUrl}/ablearn-strategy/`, {
    waitUntil: "networkidle",
  });
  await broken.screenshot({
    path: resolve(evidence, `screenshots/${viewport.width}-broken-image.png`),
    fullPage: true,
  });
  report.states.push({
    viewport: viewport.width,
    brokenImageFallback: await broken
      .locator(".job-hero__logo .image-fallback")
      .isVisible(),
  });
  await broken.close();

  const preview = await browser.newPage({ viewport });
  await preview.goto(`${baseUrl}/ablearn-strategy/`, {
    waitUntil: "networkidle",
  });
  await preview.getByText("PDF 미리보기", { exact: true }).click();
  await preview.screenshot({
    path: resolve(evidence, `screenshots/${viewport.width}-pdf-preview.png`),
    fullPage: true,
  });
  report.states.push({
    viewport: viewport.width,
    pdfPreviewOpen: await preview.locator(".pdf-preview").getAttribute("open"),
    pdfStatus: await preview
      .locator("object")
      .evaluate(async (element) => (await fetch(element.data)).status),
  });
  await preview.close();

  const printPage = await browser.newPage({ viewport });
  await printPage.emulateMedia({ media: "print" });
  await printPage.goto(`${baseUrl}/ablearn-strategy/`, {
    waitUntil: "networkidle",
  });
  await printPage.screenshot({
    path: resolve(evidence, `screenshots/${viewport.width}-print.png`),
    fullPage: true,
  });
  report.states.push({
    viewport: viewport.width,
    printNavVisible: await printPage.locator(".site-header").isVisible(),
    printContentVisible: await printPage
      .locator("#section-responsibilities")
      .isVisible(),
    mailto: await printPage
      .locator("[data-apply-link]")
      .first()
      .getAttribute("href"),
  });
  await printPage.close();
}

await browser.close();
report.cleanup = {
  browserClosed: true,
  temporaryProfiles: "none",
  capturedAt: new Date().toISOString(),
};
await writeFile(
  resolve(evidence, "browser-qa.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `Captured ${report.routes.length} route views and ${report.states.length} state records.`,
);
