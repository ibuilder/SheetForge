/**
 * Stages the OCR engine's runtime files into `apps/ui/public/tesseract/`.
 *
 * `tesseract.js` loads its worker and its WebAssembly core by URL at runtime, fetching a `.wasm`
 * that sits next to a `.js` loader. A bundler cannot follow that: it hashes and relocates the `.js`
 * and the `.wasm` beside it is left behind, so the worker 404s at the moment somebody asks to
 * recognise a page. Copying the pair verbatim into the static directory is the fix, and it is why
 * this script exists rather than an `import … ?url`.
 *
 * Copied from `node_modules`, never downloaded — the build must work with the network off, the same
 * promise the application makes. The staged directory is generated output and is not committed.
 *
 * Only the **LSTM** cores are staged. The engine asks for OEM 1 (LSTM only), so the legacy cores
 * are about 3.5 MB each of weight nothing will ever load. Three variants remain because
 * `tesseract.js` picks between them at runtime on the browser's SIMD support, and guessing wrong
 * here means no OCR on whichever machine we guessed against.
 */
import { copyFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps", "ui", "public", "tesseract");

/** [package, file] pairs, relative to `node_modules`. */
const FILES = [
  ["tesseract.js", "dist/worker.min.js"],
  // Only the `.wasm.js` loaders. Each embeds its WebAssembly as base64 — a 3.8 MB run inside a
  // 3.9 MB file — so staging the standalone `.wasm` beside it would ship every core twice, for
  // 8.6 MB nothing loads. Verified rather than assumed: see the OCR browser test.
  ["tesseract.js-core", "tesseract-core-lstm.wasm.js"],
  ["tesseract.js-core", "tesseract-core-simd-lstm.wasm.js"],
  ["tesseract.js-core", "tesseract-core-relaxedsimd-lstm.wasm.js"],
];

mkdirSync(OUT, { recursive: true });

let copied = 0;
let bytes = 0;
const missing = [];

for (const [pkg, file] of FILES) {
  const from = join(ROOT, "node_modules", pkg, file);
  if (!existsSync(from)) {
    missing.push(`${pkg}/${file}`);
    continue;
  }
  // Flattened: `tesseract.js` asks for `<corePath>/tesseract-core-simd-lstm.wasm.js`, so the
  // directory layout it expects is one flat folder rather than the package structure.
  const to = join(OUT, file.split("/").pop());
  copyFileSync(from, to);
  copied += 1;
  bytes += statSync(to).size;
}

if (missing.length > 0) {
  console.error(
    `OCR assets missing from node_modules:\n  ${missing.join("\n  ")}\n` +
      "Run `npm install` first. OCR would fail at runtime with a 404 rather than at build time, " +
      "which is why this is an error and not a warning.",
  );
  process.exit(1);
}

const langPack = join(ROOT, "apps", "ui", "public", "tessdata", "eng.traineddata.gz");
if (!existsSync(langPack)) {
  console.error(
    "The English language pack is missing from apps/ui/public/tessdata/.\n" +
      "It is committed to the repository so that OCR works offline out of the box; if it has been " +
      "removed, restore it from git rather than downloading it, so the checksum is the reviewed one.",
  );
  process.exit(1);
}

console.log(
  `Staged ${copied} OCR files (${(bytes / 1024 / 1024).toFixed(1)} MB) into apps/ui/public/tesseract/.`,
);
console.log(`Language pack present (${(statSync(langPack).size / 1024 / 1024).toFixed(1)} MB).`);
console.log(`Files in ${OUT}: ${readdirSync(OUT).length}`);
