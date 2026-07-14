import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const url = process.argv[2] ?? "http://127.0.0.1:9877";
const output =
  process.argv[3] ??
  ".omo/evidence/task-8-personal-recruiter-site/lighthouse.json";
const globalRoot = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const lighthouse = (
  await import(
    pathToFileURL(resolve(globalRoot, "lighthouse/core/index.js")).href
  )
).default;
const port = 9337;
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [`--remote-debugging-port=${port}`],
});

const baseSettings = {
  onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
  output: "json",
  logLevel: "error",
};
const presets = {
  mobile: { formFactor: "mobile" },
  desktop: {
    formFactor: "desktop",
    throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 },
    screenEmulation: {
      mobile: false,
      width: 1350,
      height: 940,
      deviceScaleFactor: 1,
      disabled: false,
    },
  },
};
const report = {
  url,
  browser: "Playwright channel=chrome",
  runsPerPreset: 3,
  presets: {},
};

for (const [preset, settings] of Object.entries(presets)) {
  const runs = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await lighthouse(
      url,
      { port, output: "json", logLevel: "error" },
      {
        extends: "lighthouse:default",
        settings: { ...baseSettings, ...settings },
      },
    );
    const scores = Object.fromEntries(
      Object.entries(result.lhr.categories).map(([key, category]) => [
        key,
        Math.round((category.score ?? 0) * 100),
      ]),
    );
    const failedAudits = Object.values(result.lhr.audits)
      .filter(
        (audit) =>
          audit.score !== null &&
          audit.score < 1 &&
          !["notApplicable", "manual", "informative"].includes(
            audit.scoreDisplayMode,
          ),
      )
      .map((audit) => ({
        id: audit.id,
        title: audit.title,
        score: audit.score,
        displayValue: audit.displayValue,
      }));
    runs.push({ index: index + 1, scores, failedAudits });
  }
  const median = Object.fromEntries(
    Object.keys(runs[0].scores).map((category) => [
      category,
      [...runs.map((run) => run.scores[category])].sort(
        (left, right) => left - right,
      )[1],
    ]),
  );
  report.presets[preset] = { runs, median };
}

await browser.close();
report.cleanup = { browserClosed: true, remoteDebuggingPortReleased: port };
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(report.presets).map(([preset, value]) => [
        preset,
        value.median,
      ]),
    ),
  ),
);
