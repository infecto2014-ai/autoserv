import { defineConfig } from "@playwright/test";
if (
  !process.env.DATABASE_URL ||
  !new URL(process.env.DATABASE_URL).pathname.includes("_test")
)
  throw new Error("E2E разрешены только с DATABASE_URL отдельной БД *_test");
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 10000 },
  use: {
    baseURL: process.env.APP_ORIGIN || "http://localhost:3000",
    viewport: { width: 1366, height: 900 },
    trace: "retain-on-failure",
  },
  reporter: "list",
  webServer: {
    command: "npm run start",
    url: process.env.APP_ORIGIN || "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
