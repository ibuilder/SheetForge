/**
 * The sheet, as a picture.
 *
 * A marked-up PDF is the right thing to issue and the wrong thing to put in a Tuesday email. The
 * question a superintendent actually asks is "send me a picture of the bit you clouded", and the
 * answer today is a screenshot — cropped to whatever was on screen, at whatever zoom the sender
 * happened to be at, with the markup list overlapping the corner of the drawing.
 *
 * So: render one sheet at a chosen resolution, with its markups drawn on, as a PNG.
 *
 * ## The markups are the point
 *
 * An image export that quietly dropped the markups would be worse than none. Somebody would send a
 * clean sheet believing they had sent their comments, and nothing downstream would tell them
 * otherwise. The overlay is therefore composited from the same {@link drawAnnotation} the viewer
 * paints with — not re-implemented here, which is how the two would drift into disagreeing about
 * what a cloud looks like.
 *
 * ## Resolution, and why it is asked rather than assumed
 *
 * A D-size sheet at 300 DPI is 10,800 by 7,200 pixels: 78 megapixels, and around 30 MB of PNG.
 * That is the right answer for a plot and the wrong one for an email, and no default is right for
 * both. The sizes are named for what they are for, and the pixel dimensions are computed and
 * refused before anything is allocated — a browser canvas has a hard area limit, and crossing it
 * yields a blank image rather than an error.
 */
import { drawAnnotation, SVG_NS, zip, type Viewer, type ZipEntry } from "@massingcloud/pdf-viewer";

import { asBlobPart } from "./bytes";
import { legendSheet, summarise } from "./legend";

/** What a chosen resolution is actually for. */
export interface Resolution {
  id: string;
  label: string;
  dpi: number;
  /** What somebody would use it for, shown beside the label. */
  purpose: string;
}

/**
 * Offered resolutions.
 *
 * Screen resolution first, because sending a picture is the common case and a 30 MB attachment is
 * a worse failure than a soft one.
 */
export const RESOLUTIONS: readonly Resolution[] = [
  { id: "screen", label: "Screen", dpi: 96, purpose: "email and reports" },
  { id: "print", label: "Print", dpi: 150, purpose: "a readable A3 print" },
  { id: "plot", label: "Plot", dpi: 300, purpose: "full-size plotting; a large file" },
];

/**
 * Chromium refuses to allocate a canvas past roughly 2^28 pixels, and does it by returning a blank
 * one rather than by throwing. Held well under, so the failure is a message rather than a picture
 * of nothing.
 */
export const MAX_PIXELS = 200_000_000;

/** Everything the caller needs to name the file and warn about the size. */
export interface SheetImage {
  blob: Blob;
  width: number;
  height: number;
  page: number;
}

/**
 * Render one page, with its markups, to a PNG.
 *
 * @throws if no document is open, or the requested size exceeds what a canvas can hold.
 */
export async function sheetAsPng(
  viewer: Viewer,
  page: number,
  dpi: number,
  stamp?: string,
): Promise<SheetImage> {
  const doc = viewer.doc;
  if (!doc) throw new Error("No drawing is open.");

  const info = await doc.pageInfo(page);
  // PDF user space is 72 units to the inch by definition, so this is the whole of the conversion.
  const scale = dpi / 72;
  const width = Math.round(info.width * scale);
  const height = Math.round(info.height * scale);

  if (width * height > MAX_PIXELS) {
    throw new Error(
      `That would be ${width} by ${height} pixels, which is more than a canvas can hold. ` +
        "Choose a lower resolution.",
    );
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This system could not provide a drawing surface.");

  // White, not transparent. A PDF page has no background of its own, and a transparent PNG pasted
  // into a dark-themed document renders as white linework on black — technically faithful and
  // completely unreadable.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  const proxy = await doc.page(page);
  await proxy.render({
    canvas,
    canvasContext: context,
    viewport: proxy.getViewport({ scale }),
  }).promise;

  const overlay = await markupOverlay(viewer, page, scale, width, height);
  if (overlay) {
    context.drawImage(overlay, 0, 0);
    // A bitmap holds GPU-side memory until it is closed, and these are large.
    overlay.close();
  }

  if (stamp) drawIssueStamp(context, width, height, stamp);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The image could not be encoded.");

  // Release the backing store rather than waiting for the collector; at plot resolution this is
  // hundreds of megabytes.
  canvas.width = 0;
  canvas.height = 0;

  return { blob, width, height, page };
}

/**
 * The markups for a page, rasterised at the same scale as the sheet.
 *
 * Built as an SVG and decoded through `createImageBitmap` rather than drawn with canvas calls,
 * because the shapes come from the engine as SVG elements and re-implementing them against a 2D
 * context is how an exported cloud ends up a different shape from the one on screen.
 *
 * Returns `undefined` when the page has no markups, so a clean sheet costs no work.
 */
async function markupOverlay(
  viewer: Viewer,
  page: number,
  scale: number,
  width: number,
  height: number,
): Promise<ImageBitmap | undefined> {
  const annotations = viewer.store.onPage(page);
  if (annotations.length === 0) return undefined;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  for (const annotation of annotations) {
    // `zoom: scale` puts the geometry in the same space as the rasterised page: both are page
    // units multiplied by the same factor.
    svg.append(drawAnnotation(annotation, { zoom: scale, feetInches: viewer.feetInches }));
  }

  // A blob URL rather than a data: URL. The markup on a busy sheet runs to hundreds of kilobytes
  // of path data, and base64 in a URL is a needless third copy of it.
  const source = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.width = width;
    image.height = height;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The markup overlay could not be rendered."));
      image.src = url;
    });
    return await createImageBitmap(image);
  } finally {
    URL.revokeObjectURL(url);
  }
}



/**
 * The issue status, across the sheet.
 *
 * Issuing a drawing without saying what it is for is a real mistake with real consequences: a
 * marked-up review copy that reaches a subcontractor looking like an issued drawing is how
 * somebody builds the wrong thing. On paper this is what the big diagonal red letters are for, and
 * the reason they are diagonal and enormous is that they must survive being photographed, printed
 * at the wrong size, and glanced at.
 *
 * Drawn *after* the markups, so nothing can be laid over it to hide it.
 *
 * Deliberately not subtle. A tasteful watermark is one that gets missed.
 */
function drawIssueStamp(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
): void {
  context.save();

  // Sized to the sheet rather than to a fixed point size, so it reads the same on an A4 detail as
  // on a D-size plan. The divisor is tuned so a ~20 character status spans most of the diagonal.
  const diagonal = Math.hypot(width, height);
  const size = diagonal / Math.max(text.length, 12) * 1.4;

  context.translate(width / 2, height / 2);
  context.rotate(-Math.atan2(height, width));
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `bold ${size}px Helvetica, Arial, sans-serif`;

  // A translucent fill with an opaque outline. Fill alone disappears over dark linework; outline
  // alone disappears over white. Together the text survives whatever is under it, which is the
  // whole job.
  context.fillStyle = "rgba(200, 32, 32, 0.18)";
  context.fillText(text, 0, 0);
  context.lineWidth = Math.max(size / 28, 1);
  context.strokeStyle = "rgba(200, 32, 32, 0.55)";
  context.strokeText(text, 0, 0);

  context.restore();
}

/**
 * How much of a set may be turned into pictures in one go.
 *
 * Not a limit on what the format can hold — the archive is uncompressed and the ceiling is four
 * gigabytes — but on what can be held in memory while it is being built. Every page is rasterised,
 * encoded, and kept until the last one is done, so a large set at a high resolution is a genuine
 * way to run a browser out of memory. Refused with a number rather than attempted and lost.
 */
const MAX_ARCHIVE_BYTES = 1_200 * 1024 * 1024;

/** What a bulk export produced, for the caller to name and report. */
export interface SheetSet {
  blob: Blob;
  pages: number;
}

/**
 * Every sheet in the open drawing, as PNGs in a ZIP.
 *
 * One archive rather than one save dialog per sheet. The alternative would be a folder picker,
 * which would mean a new command, a directory handle held across calls, and a second place for
 * the rule that no path crosses the boundary to be got wrong. A single file through the export
 * path that already exists is the same result with none of that.
 *
 * Uncompressed entries, because the engine's zip stores rather than deflates and PNGs are already
 * compressed — deflating them again would spend time to save almost nothing.
 *
 * The archive opens with a legend: what the colours mean, how many of each, and how much of the
 * set carries any markup at all. That last number is the one a recipient most needs and would
 * never think to ask for.
 *
 * @param onProgress Called before each page, and once for the cover. A 200-sheet set takes
 *   minutes, and a window that says nothing for minutes is indistinguishable from one that has
 *   hung.
 * @throws if no document is open, or the archive would be too large to hold in memory.
 */
export async function sheetsAsZip(
  viewer: Viewer,
  dpi: number,
  onProgress: (page: number, of: number) => void,
  stamp?: string,
): Promise<SheetSet> {
  const doc = viewer.doc;
  if (!doc) throw new Error("No drawing is open.");

  const pages = doc.numPages;
  const entries: ZipEntry[] = [];
  let total = 0;

  // The cover goes in first and sorts first. A set arriving with coloured markup and no key leaves
  // the recipient guessing which colour meant which discipline — and, more importantly, with no
  // way to tell an unmarked sheet that was reviewed from one nobody opened.
  onProgress(0, pages);
  const first = await doc.pageInfo(1);
  const cover = await legendSheet(
    summarise(viewer),
    viewer.doc?.name ?? "Drawing set",
    first.width,
    first.height,
    dpi,
  );
  entries.push({
    name: "000-legend.png",
    data: new Uint8Array(await cover.arrayBuffer()),
  });
  total += cover.size;

  for (let page = 1; page <= pages; page += 1) {
    onProgress(page, pages);
    const image = await sheetAsPng(viewer, page, dpi, stamp);
    total += image.blob.size;

    if (total > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `The archive passed ${Math.round(total / (1024 * 1024))} MB at sheet ${page} of ${pages}. ` +
          "Choose a lower resolution, or export the sheets you need one at a time.",
      );
    }

    entries.push({
      // Zero-padded so the archive sorts the way the set is ordered. `p10` before `p2` is the
      // kind of small wrongness that makes a deliverable look careless.
      name: `${String(page).padStart(3, "0")}.png`,
      data: new Uint8Array(await image.blob.arrayBuffer()),
    });
  }

  return { blob: new Blob([asBlobPart(zip(entries))], { type: "application/zip" }), pages };
}
