/**
 * Where the OCR engine's runtime files are served from.
 *
 * Separate from `ocr.ts` because the browser test needs the same values, and a test that hard-codes
 * its own copy of a path is a test that keeps passing after the path changes.
 *
 * These are root-relative rather than imported as assets: `tesseract.js` fetches its WebAssembly by
 * URL from inside a Web Worker, which a bundler cannot follow. `scripts/stage-ocr-assets.mjs` puts
 * the files where these point.
 */
export const OCR_ASSET_PATHS = {
  /** The recognition worker. */
  worker: "/tesseract/worker.min.js",
  /** Directory; `tesseract.js` appends the core variant it picks for this browser's SIMD support. */
  core: "/tesseract/",
  /** Directory; the worker appends `<lang>.traineddata.gz`. */
  lang: "/tessdata",
} as const;
