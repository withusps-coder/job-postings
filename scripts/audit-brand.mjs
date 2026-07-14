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
const blocked = [
  "support@" + "starting.kr",
  "kms@" + "step-up.kr",
  "Step" + "Up",
  "스텝" + "업",
];

const files = await collectRegularFiles(roots);
const findings = [];

for (const path of files) {
  if (await isBinaryFile(path)) {
    continue;
  }

  const contents = await readFile(path, "utf8");
  for (const term of blocked) {
    if (contents.includes(term)) {
      findings.push(`${path}: prohibited legacy brand/contact term`);
    }
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Brand audit passed for toolchain source, output, and task evidence.",
  );
}
