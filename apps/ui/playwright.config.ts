import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for the things a headless DOM cannot reach: the drawing engine mounting, the
 * bundled pdf.js worker starting, real pixels landing on a canvas, and OCR loading its own
 * WebAssembly.
 *
 * Everything runs against the *built* bundle, so what is tested is what ships — including worker
 * URL resolution, which differs between a dev server and a build.
 */
/**
 * The port the built bundle is served on.
 *
 * Overridable because 4173 is Vite's default preview port and the one most likely to be taken by
 * something else a developer is running — an editor's preview, another project's `vite preview`.
 * `--strictPort` makes a collision fail loudly rather than drift, and this lets it be moved instead
 * of stopping somebody else's process. CI leaves it alone.
 */
const PORT = Number(process.env["SF_E2E_PORT"] ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: { trace: "on-first-retry" },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], baseURL: ORIGIN } }],

  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: ORIGIN,
    // Never reuse. The command builds first, and reusing a server skips the build — so the suite
    // would quietly test whatever bundle happened to be there last time. A slow, honest suite
    // beats a fast one that lies.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
