import { readFile } from "node:fs/promises";
import { collectRegularFiles, isBinaryFile } from "./audit-files.mjs";

const roots = [
  "src",
  "functions",
  "tests",
  "scripts",
  "_site",
  ".omo/evidence/task-2-personal-recruiter-site",
  ".gitignore",
  ".htmlvalidate.json",
  ".node-version",
  ".prettierignore",
  "eleventy.config.mjs",
  "eslint.config.mjs",
  "jsconfig.json",
  "package.json",
  "package-lock.json",
  "playwright.config.mjs",
  "wrangler.jsonc",
];
const tokenPattern = /(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/u;
const pinPattern = /\b\d{6}\b/u;
const urlPattern = /https?:\/\/[^\s"'<>]+/gu;

const files = await collectRegularFiles(roots);
const findings = [];

for (const path of files) {
  if (await isBinaryFile(path)) {
    continue;
  }

  const contents = await readFile(path, "utf8");
  const contentWithoutUrls = contents.replace(urlPattern, "");
  if (tokenPattern.test(contents) || pinPattern.test(contentWithoutUrls)) {
    findings.push(`${path}: possible secret material`);
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Secret audit passed for toolchain source, output, and task evidence.",
  );
}
