import { defineConfig, devices } from "@playwright/test";

const workspacePort =
  [...process.cwd()].reduce(
    (value, character) => (value * 31 + character.codePointAt(0)) % 1_000,
    0,
  ) + 9_000;
const pagesPort = Number(process.env["PAGES_PORT"] ?? workspacePort);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: `http://127.0.0.1:${pagesPort}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-375",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 812 },
      },
    },
    {
      name: "chromium-768",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 768, height: 1_024 },
      },
    },
    {
      name: "chromium-1280",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1_280, height: 960 },
      },
    },
  ],
  webServer: {
    command: `npx wrangler d1 migrations apply DB --local && PAGES_PORT=${pagesPort} npm run dev:pages`,
    url: `http://127.0.0.1:${pagesPort}/robots.txt`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
