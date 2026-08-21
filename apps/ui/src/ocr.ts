/**
 * Reading scanned drawings.
 *
 * A scan carries no text layer, so on one the search box finds nothing, the specification parser
 * finds no sections, and the title-block extractor reports no sheet number. On a refurbishment job
 * — where half the set is a photocopy of a drawing from 1974 — that is most of the product not
 * working, and the user has no way to tell whether the tool is broken or the drawing is.
 *
 * The engine owns the hard parts already: tiling the sheet, mapping recognised words back into page
 * space, and feeding them through the one seam that search, specs and the sheet register all read
 * from. What it deliberately does not ship is a recogniser, because whether a drawing may leave the
 * building is not knowable from inside a library.
 *
 * ## The choice made here, and why
 *
 * SheetForge runs **on the device**. Tesseract and its English model are bundled — about 8 MB of
 * WebAssembly and 2 MB of model — so a scan is recognised with the network unplugged and no page
 * is ever sent anywhere. That is the same promise the rest of the application makes, and an OCR
 * feature that quietly posted drawings to a cloud service would break it in the least visible way
 * possible.
 *
 * ## What this costs, stated plainly
 *
 * Tesseract is **weak on the small lettering a title block keeps its metadata in**. Benchmarked by
 * the engine against a generated title block at 300 DPI, Tesseract recovered 3 of 8 expected
 * strings where PaddleOCR recovered 8 of 8, and was roughly five times slower per tile. It reads
 * the large text and misses the 6pt labels.
 *
 * So this is honest-but-limited: good enough to make a scanned specification searchable, not good
 * enough to trust for automatic sheet numbering. A better on-device engine is on the roadmap; the
 * provider is a single value and swapping it is a small change, which is the point of the seam.
 *
 * Nothing recognised here is ever treated as verified. A scale read off a title block stays
 * provisional until a human confirms it — see `sf-domain`'s measurement model.
 */

import { tesseractProvider, type OcrProvider } from "@massingcloud/pdf-viewer";
import { OCR_ASSET_PATHS } from "./ocr-paths";

/**
 * Where the staged engine files live.
 *
 * Served from the static directory rather than imported, because `tesseract.js` fetches its
 * WebAssembly by URL at runtime and a bundler cannot follow that — see
 * `scripts/stage-ocr-assets.mjs`. `BASE_URL` rather than a leading slash so the paths survive being
 * served from a subdirectory, which is how the browser build is hosted.
 */
const base = import.meta.env.BASE_URL.replace(/\/$/, "");

/** The on-device recogniser. */
export function localOcrProvider(): OcrProvider {
  return tesseractProvider({
    lang: "eng",
    workerPath: `${base}${OCR_ASSET_PATHS.worker}`,
    corePath: `${base}${OCR_ASSET_PATHS.core}`,
    langPath: `${base}${OCR_ASSET_PATHS.lang}`,
    // Bundled rather than left to a bare specifier the browser cannot resolve. The engine keeps
    // its own import indirect so consumers who never enable OCR do not pay for it; we do enable it,
    // so we hand the module over directly.
    load: () => import("tesseract.js"),
  });
}

/**
 * OCR settings for `createViewer`.
 *
 * `auto` is off. Recognising every text-less page as a document opens would mean a hundred-sheet
 * scanned set spending several minutes at full CPU before anybody had asked for anything — on a
 * laptop, on battery, on site. It runs when somebody asks for it.
 *
 * 300 DPI is a floor rather than a default worth tuning down: recognition needs roughly 18–20
 * pixels of character height, and the 1/8" lettering on an ARCH D sheet is 37 px at 300 DPI and
 * 9 px at the 72 DPI a whole sheet fits into.
 */
export function ocrOptions(): {
  provider: OcrProvider;
  dpi: number;
  auto: boolean;
  minConfidence: number;
} {
  return {
    provider: localOcrProvider(),
    dpi: 300,
    auto: false,
    // Below this the word is more likely to be noise from a speckled scan than a reading, and a
    // wrong word in a search index is worse than a missing one: it produces a confident hit on a
    // sheet that does not contain the term.
    minConfidence: 0.6,
  };
}
