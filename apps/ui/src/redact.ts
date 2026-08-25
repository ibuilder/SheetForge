/**
 * Redaction that actually removes the content.
 *
 * A black rectangle drawn over a phone number in a PDF hides it from a reader and from nobody
 * else: the text is still an object in the content stream, still selectable, still recoverable by
 * copy-and-paste or by any of a hundred tools. Redaction of that kind is **worse than none**,
 * because it is believed. Somebody discloses a tender document confident the rates are covered,
 * and they are not.
 *
 * So this does not cover anything. A page carrying a redaction is **rasterised** — rendered to
 * pixels, with the redacted areas painted out before encoding — and the new document is built from
 * those pixels. The text does not survive because there is no text: the output page contains one
 * image and nothing else. That is a claim a test can check, and
 * `apps/ui/e2e/redaction.spec.ts` checks it by searching the exported bytes for the string that
 * was supposed to be gone.
 *
 * ## What it costs, and what it does not
 *
 * A rasterised page is not searchable and not selectable, and it is larger. That is the price of
 * the guarantee and there is no version of this that avoids it — anything that keeps the text
 * layer keeps the text.
 *
 * The price is charged **per page**. A page with no redaction on it is copied from the source
 * document unchanged, keeping its vector content, its text and its size. Redacting one phone
 * number on sheet 12 of a 200-sheet set costs sheet 12, not the set.
 *
 * ## What is deliberately not in the output
 *
 * Markups. A redacted copy is made to be handed to somebody outside the review, and the review's
 * own comments — "check this rate", "query with the client" — are exactly what you would not want
 * to send with it. Only the redactions themselves are burnt in.
 */
import { definePlugin, type Annotation, type Viewer } from "@massingcloud/pdf-viewer";
import { PDFDocument } from "pdf-lib";

import { asBlobPart } from "./bytes";
import { MAX_PIXELS } from "./sheet-image";

/** Marks a rectangle as a redaction rather than as ordinary markup. */
const REDACTION = "sfRedaction";

/**
 * Resolution the redacted pages are rasterised at.
 *
 * 200 DPI is a compromise nobody loves: high enough that a D-size sheet's dimension strings stay
 * legible when the page is reduced to pixels, low enough that a redacted set is not measured in
 * gigabytes. It is deliberately *not* configurable — a redaction export offering a "low quality"
 * option is offering somebody the chance to produce an unreadable legal document by accident.
 */
const REDACTION_DPI = 200;

/**
 * How large a redacted document may get before it is refused.
 *
 * Every rasterised page is held until the last one is encoded, so a set redacted throughout is a
 * genuine way to run a webview out of memory — and the failure is a dead tab with no message and
 * no partial output, after somebody has spent an hour drawing redactions. Refused with a number
 * and the sheet it gave up on, the same way the bulk image export refuses.
 */
const MAX_REDACTED_BYTES = 1_200 * 1024 * 1024;

/** Whether a markup is one of ours. */
export function isRedaction(annotation: Annotation): boolean {
  return annotation.ext?.[REDACTION] === true;
}

/** The redactions on a page. */
function redactionsOn(viewer: Viewer, page: number): Annotation[] {
  return viewer.store.onPage(page).filter(isRedaction);
}

/**
 * The tool and the export, as a plugin.
 *
 * Registered the same way the engine registers its own, so the tool appears in the toolbar and the
 * action appears in the export menu without the chrome being told about either.
 *
 * @param save Hands the finished bytes to the host, which puts them where the user says.
 * @param onProgress Reports which page is being worked on. Rasterising a large set takes minutes.
 */
export function redactionPlugin(
  save: (bytes: Uint8Array, filename: string) => Promise<void>,
  onProgress: (message: string) => void,
) {
  return definePlugin({
    id: "sheetforge-redaction",
    setup(context) {
      context.registerTool({
        id: "redact",
        label: "Redact",
        icon: "▮",
        group: "markup",
        input: "drag",
        kind: "rect",
        cursor: "crosshair",
        // Stays armed: redactions come in runs. Somebody clearing a schedule of rates is drawing
        // twenty of them, not one.
        sticky: true,
        create: (commit) => ({
          kind: "rect",
          points: commit.points,
          page: commit.page,
          subject: "Redaction",
          // Solid black on screen, so what you see is what the exported page will contain. A
          // redaction drawn in a translucent review colour would misrepresent its own effect.
          style: { color: "#000000", fill: "#000000", fillOpacity: 1, opacity: 1, width: 1 },
          ext: { [REDACTION]: true },
        }),
      });

      context.registerAction({
        id: "export.redacted",
        label: "Export redacted copy",
        group: "io",
        enabled: (viewer) => viewer.store.all().some(isRedaction),
        run: async (viewer) => {
          const bytes = await redactedCopy(viewer, onProgress);
          await save(bytes, "redacted.pdf");
        },
      });
    },
  });
}

/**
 * Build the redacted document.
 *
 * @throws if no document is open.
 */
export async function redactedCopy(
  viewer: Viewer,
  onProgress: (message: string) => void,
): Promise<Uint8Array> {
  const doc = viewer.doc;
  if (!doc) throw new Error("No drawing is open.");

  // Encrypted PDFs are routine on issued construction drawings — an owner password restricting
  // printing or extraction. pdf.js opens them, so the drawing renders and redactions can be drawn,
  // and without this the only sign of trouble is pdf-lib's own error arriving after all the work
  // is done. `ignoreEncryption` is deliberately *not* set: this produces a document to be handed
  // out, and quietly stripping someone else's protection is not this tool's decision to make.
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(doc.bytes.slice());
  } catch {
    throw new Error(
      "This drawing is protected, so a redacted copy cannot be built from it. Ask whoever issued " +
        "it for an unprotected copy. Marking up and measuring still work.",
    );
  }

  const out = await PDFDocument.create();
  // The source's own title and bookmarks are not carried across: `copyPages` moves pages, not the
  // document around them. Naming the output rather than leaving it blank is the part worth doing;
  // the outline is a known loss, recorded in docs/status.md.
  out.setTitle("Redacted copy");
  out.setProducer("SheetForge");

  let produced = 0;

  for (let page = 1; page <= doc.numPages; page += 1) {
    const redactions = redactionsOn(viewer, page);
    onProgress(
      redactions.length === 0
        ? `Copying page ${page} of ${doc.numPages}…`
        : `Redacting page ${page} of ${doc.numPages}…`,
    );

    if (redactions.length === 0) {
      // Untouched pages are copied, not re-rendered. They keep their vector content, their text
      // and their size, and the cost of the guarantee is charged only where it was asked for.
      const [copied] = await out.copyPages(source, [page - 1]);
      if (copied) out.addPage(copied);
      continue;
    }

    const info = await doc.pageInfo(page);
    const png = await rasteriseRedacted(viewer, page, info.width, info.height, redactions);

    produced += png.byteLength;
    if (produced > MAX_REDACTED_BYTES) {
      throw new Error(
        `The redacted copy passed ${Math.round(produced / (1024 * 1024))} MB at sheet ${page} of ` +
          `${doc.numPages}. Redact fewer sheets at a time, or export them in batches.`,
      );
    }

    const embedded = await out.embedPng(png);
    // Added at the source page's own size in points, so the redacted document plots at the same
    // scale as the original. A takeoff measured off a redacted copy has to come out the same.
    const sheet = out.addPage([info.width, info.height]);
    sheet.drawImage(embedded, { x: 0, y: 0, width: info.width, height: info.height });
  }

  return out.save();
}

/**
 * One page, rendered to pixels with its redactions painted out.
 *
 * The order is the point: the page is drawn first, the black rectangles are drawn over it second,
 * and only then are the pixels read out. Nothing that was under a rectangle is in the buffer that
 * gets encoded — which is the difference between this and drawing a box in a PDF.
 */
async function rasteriseRedacted(
  viewer: Viewer,
  page: number,
  widthPt: number,
  heightPt: number,
  redactions: readonly Annotation[],
): Promise<Uint8Array> {
  const doc = viewer.doc;
  if (!doc) throw new Error("No drawing is open.");

  const scale = REDACTION_DPI / 72;
  const width = Math.round(widthPt * scale);
  const height = Math.round(heightPt * scale);

  // Refused rather than attempted. A canvas past the browser's limit does not throw — it yields a
  // blank one — so without this a roll-plotted section too wide to rasterise would export as a
  // white page, the redaction would report success, and the blank sheet would go out in a
  // disclosure bundle. Silence is the worst possible failure for this particular feature.
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `Page ${page} is ${widthPt} by ${heightPt} points, which is too large to redact at ` +
        `${REDACTION_DPI} DPI. Redaction has to rasterise the page, and this one exceeds what a ` +
        "canvas can hold.",
    );
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This system could not provide a drawing surface.");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  try {
    const proxy = await doc.page(page);
    await proxy.render({
      canvas,
      canvasContext: context,
      viewport: proxy.getViewport({ scale }),
    }).promise;

    context.fillStyle = "#000000";
    for (const redaction of redactions) {
      const box = bounds(redaction);
      if (!box) continue;
      // Page space is y-up and canvas space is y-down, which is the classic way to paint a black
      // box over the wrong half of a document.
      context.fillRect(
        box.x * scale,
        canvas.height - (box.y + box.height) * scale,
        box.width * scale,
        box.height * scale,
      );
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The redacted page could not be encoded.");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    // Released whatever happened. A failure here is the one path somebody retries, and retrying
    // while the last attempt still holds its buffer is how a webview runs out of memory.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** The rectangle a redaction covers, in page space. */
function bounds(
  annotation: Annotation,
): { x: number; y: number; width: number; height: number } | undefined {
  const points = annotation.points;
  if (points.length < 2) return undefined;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** A blob of the redacted document, for the export path. */
export function asPdfBlob(bytes: Uint8Array): Blob {
  return new Blob([asBlobPart(bytes)], { type: "application/pdf" });
}
