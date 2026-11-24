import { defineConfig } from "@playwright/test";

const port = 4183;
export default defineConfig({
  testDir: "./tests",
  testMatch: "browser-workflow.spec.ts",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 980 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    env: { HOST: "127.0.0.1", PORT: String(port) },
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 30_000,
  },
});
