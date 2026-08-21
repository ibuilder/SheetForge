/**
 * Does OCR actually work, offline, from the files we ship?
 *
 * Every part of this setup fails *silently* rather than loudly, which is why it needs a test that
 * runs the real thing:
 *
 * - A missing worker or core is a 404 inside a Web Worker. The page carries on; recognition just
 *   never returns any words, which looks exactly like a drawing with nothing readable on it.
 * - A missing language pack behaves the same way.
 * - `tesseract.js` falls back to a CDN when its local paths are wrong, so a broken setup *passes*
 *   on a developer machine with a network and fails on the site with no signal — the one place
 *   this feature exists for.
 *
 * ## What is under test, and what is not
 *
 * The subject is the **staged assets**: that `/tesseract/worker.min.js`, the WebAssembly core
 * beside it and `/tessdata/eng.traineddata.gz` are served by the built application and can drive a
 * recognition end to end with nothing off-origin.
 *
 * `tesseract.js` itself is loaded into the page from `node_modules` rather than reached through the
 * application's bundle. That keeps this in the same project as the rest of the suite, running
 * against the built output, instead of needing a second dev server purely so a test could import a
 * module. The paths come from {@link OCR_ASSET_PATHS}, the same constants `src/ocr.ts` uses, so a
 * typo there fails here rather than drifting apart.
 */
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { OCR_ASSET_PATHS } from "../src/ocr-paths";

// Resolved rather than joined from a relative path: npm workspaces hoist this package to the
// repository root, so `node_modules/...` beside this file does not exist.
const tesseractUmd = createRequire(import.meta.url).resolve("tesseract.js/dist/tesseract.min.js");

// Loading an 11 MB core and a 2 MB model, then recognising, is not a two-second operation.
test.describe.configure({ timeout: 180_000 });

test.describe("on-device OCR", () => {
  test("reads text using only the files the application ships", async ({ page, baseURL }) => {
    const offOrigin: string[] = [];
    const origin = new URL(baseURL ?? "http://127.0.0.1:4173").origin;

    // Anything off-origin defeats the point. Blocking rather than merely observing means a CDN
    // fallback cannot quietly rescue a broken local path and leave us shipping OCR that only works
    // on a connected machine.
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith("blob:") || url.startsWith("data:")) {
        return route.continue();
      }
      offOrigin.push(url);
      return route.abort();
    });

    await page.goto("/");

    // The UMD build, injected from disk — this is the library, not one of the runtime assets under
    // test, and loading it this way avoids needing a second server for module resolution.
    await page.addScriptTag({ path: tesseractUmd });

    const words = await page.evaluate(async (paths) => {
      // Big, clean lettering. The question is whether the engine loads and returns coordinates at
      // all — not how it copes with a 1974 dyeline, which is a benchmark against real sheets and is
      // documented rather than asserted.
      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 220;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000000";
      ctx.font = "bold 96px Georgia, 'Times New Roman', serif";
      ctx.fillText("FIRESTOPPING", 40, 140);

      const tesseract = (window as unknown as {
        Tesseract: {
          createWorker: (
            lang: string,
            oem: number,
            config: Record<string, string>,
          ) => Promise<{
            recognize: (
              image: HTMLCanvasElement,
              options?: Record<string, unknown>,
              output?: Record<string, boolean>,
            ) => Promise<{ data: { blocks?: unknown } }>;
            terminate: () => Promise<void>;
          }>;
        };
      }).Tesseract;

      // OEM 1 — LSTM only — matching what the drawing engine's provider asks for, which is why
      // only the LSTM cores are staged.
      const worker = await tesseract.createWorker("eng", 1, {
        workerPath: paths.worker,
        corePath: paths.core,
        langPath: paths.lang,
      });
      try {
        const { data } = await worker.recognize(canvas, {}, { blocks: true });
        const found: string[] = [];
        for (const block of (data.blocks ?? []) as { paragraphs?: { lines?: { words?: { text: string }[] }[] }[] }[]) {
          for (const paragraph of block.paragraphs ?? []) {
            for (const line of paragraph.lines ?? []) {
              for (const word of line.words ?? []) found.push(word.text);
            }
          }
        }
        return found;
      } finally {
        await worker.terminate();
      }
    }, OCR_ASSET_PATHS);

    expect(offOrigin, "OCR reached for something off-origin; it must run entirely from bundled files")
      .toEqual([]);

    // Not an exact-string assertion: OCR is probabilistic, and pinning the output would make this a
    // test of one model version rather than of the wiring. What it must not return is nothing.
    expect(words.length, "the recogniser returned no words — worker, core or language pack missing")
      .toBeGreaterThan(0);
    expect(words.join(" ").toUpperCase()).toContain("FIRESTOP");
  });
});
