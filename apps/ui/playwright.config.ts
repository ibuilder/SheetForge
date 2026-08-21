import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for the things a headless DOM cannot reach: the drawing engine mounting, the
 * bundled pdf.js worker starting, real pixels landing on a canvas, and OCR loading its own
 * WebAssembly.
 *
 * Everything runs against the *built* bundle, so what is tested is what ships — including worker
 * URL resolution, which differs between a dev server and a build.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: { trace: "on-first-retry" },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4173" } }],

  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    // Never reuse. The command builds first, and reusing a server skips the build — so the suite
    // would quietly test whatever bundle happened to be there last time. A slow, honest suite
    // beats a fast one that lies.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
