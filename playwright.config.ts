import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration.
 *
 * E2E runs against a real `next start`, because the session cookie, the
 * middleware and the route handlers are exactly what these tests exist to cover —
 * a mocked server would test nothing that is not already unit-tested.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: { width: 390, height: 780 },
  },
  projects: [
    { name: "mobile-chromium", use: { ...devices["Pixel 5"] } },
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // The app is the repository root now, so Playwright can drive the real
        // scripts directly instead of going through a workspace filter.
        command: "pnpm run build && pnpm run start --port 3000",
        url: "http://127.0.0.1:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
          RAGDOLL_SESSION_SECRET: "playwright-session-secret-value-0123456789",
          RAGDOLL_API_TOKEN: "playwright-engine-token-0123456789",
        },
      },
});
