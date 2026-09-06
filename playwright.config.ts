import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Never silently reuse a researcher's live process/data. CI and local runs get
// their own real VM service, worker pool and persistent job directory. Set an
// external base URL explicitly only when testing an authorized existing server.
const external = process.env.PLAYWRIGHT_BASE_URL;
const clientPort = process.env.PLAYWRIGHT_CLIENT_PORT ?? "5199";
const apiPort = process.env.PLAYWRIGHT_API_PORT ?? "8799";
const baseURL = external ?? `http://127.0.0.1:${clientPort}`;
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath,
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  webServer: external
    ? undefined
    : {
        command: "npm run dev",
        env: {
          CLIENT_PORT: clientPort,
          API_PORT: apiPort,
          POLYP_RUNS_DIR:
            process.env.PLAYWRIGHT_RUNS_DIR ??
            `.polyp/e2e/session-${process.pid}-${Date.now()}`,
        },
        // A static HTML shell is not readiness: the production API must answer.
        url: `${baseURL}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
