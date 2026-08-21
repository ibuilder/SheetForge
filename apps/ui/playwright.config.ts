import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for the things a headless DOM cannot reach: the drawing engine mounting, the
 * bundled pdf.js worker starting, and real pixels landing on a canvas.
 *
 * These run against the **built** bundle rather than the dev server, so what is tested is what
 * ships — including the worker URL resolution, which differs between the two.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env["CI"],
    // The build is part of the command, so the first start is slow by design.
    timeout: 180_000,
  },
});
