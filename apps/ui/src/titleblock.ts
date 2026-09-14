/**
 * Reading sheet numbers off title blocks, for drawings nobody has opened yet.
 *
 * The engine reads title blocks while a drawing is open in the viewer, and until now that was the
 * only time it happened. Importing a set of sixty drawings therefore filled the register for one of
 * them — the one that was opened afterwards — and left all sixty named after their filenames. This
 * reads every drawing an import files, the same way, without opening it.
 *
 * ## Why the engine's own reader, through a stand-in
 *
 * `extractSheetMeta` is typed to take a viewer, and uses exactly two things from it: the document's
 * page boxes, and the positioned text of a page. A headless `PdfDocument` has both. Writing a second
 * title-block reader here would give the register two readers that disagree the moment either one
 * changes; handing the engine's reader a stand-in keeps one.
 *
 * The stand-in's `pageText` is the document's `textItems`, and that is not a naming accident to
 * tidy up: a viewer's `pageText` returns positioned text items, a document's `pageText` returns one
 * flat string, and handing the reader the string reads every title block as blank. The browser test
 * for importing a set fails if either this mapping breaks or the engine starts reaching for
 * anything the stand-in does not have.
 */
import {
  configureWorker,
  extractSheetMeta,
  PdfDocument,
  workerConfigured,
  type SheetMeta,
  type Viewer,
} from "@massingcloud/pdf-viewer";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * Every page's title block, as the engine reads it when the drawing is open.
 *
 * The document is loaded, read and destroyed here: a set is read one drawing at a time, and a pdf.js
 * document left undestroyed holds its worker tasks and its parsed pages for the life of the window.
 */
export async function readTitleBlocks(bytes: Uint8Array): Promise<SheetMeta[]> {
  if (!workerConfigured()) configureWorker(workerUrl);
  // A copy, because pdf.js takes ownership of the buffer it is handed.
  const doc = await PdfDocument.load(bytes.slice());
  try {
    const standIn = { doc, pageText: (page: number) => doc.textItems(page) } as unknown as Viewer;
    const sheets: SheetMeta[] = [];
    for (let page = 1; page <= doc.numPages; page += 1) {
      const sheet = await extractSheetMeta(standIn, page);
      if (sheet) sheets.push(sheet);
    }
    return sheets;
  } finally {
    doc.destroy();
  }
}
