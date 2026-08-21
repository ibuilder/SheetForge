/**
 * Stands in for an OCR engine SheetForge does not ship.
 *
 * The drawing engine offers several recognisers — Tesseract, PaddleOCR, Azure, Google Vision — and
 * imports each behind an optional dependency so a host pays only for the one it chooses. SheetForge
 * chooses Tesseract, on the device (see `../ocr.ts`), so PaddleOCR is not installed.
 *
 * Vite still tries to resolve the specifier while pre-bundling, and an unresolvable import is a
 * hard error even on a code path nothing calls. Aliasing it here turns "this module is missing" —
 * which looks like a broken build — into "this engine was not chosen", which is the truth and says
 * so if anybody ever reaches it.
 *
 * Bringing PaddleOCR back is a real option: it read 8 of 8 title-block strings where Tesseract read
 * 3 of 8, and was about five times faster. What it costs is `onnxruntime-web`, whose runtime assets
 * are an order of magnitude larger than everything else the application ships. That trade is on the
 * roadmap rather than settled.
 */

const message =
  "PaddleOCR is not bundled in SheetForge. The on-device recogniser is Tesseract — see " +
  "apps/ui/src/ocr.ts. To use PaddleOCR, install `ppu-paddle-ocr` and remove the alias in " +
  "vite.config.ts.";

export function createOCR(): never {
  throw new Error(message);
}

export default new Proxy(
  {},
  {
    get() {
      throw new Error(message);
    },
  },
);
