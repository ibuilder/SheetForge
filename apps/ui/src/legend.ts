/**
 * The cover sheet that explains a set somebody is about to be sent.
 *
 * An exported drawing set arrives full of coloured markup and no key. The recipient sees a teal
 * cloud and a blue one and has to guess that one is mechanical and the other structural — or, more
 * often, does not notice there is a distinction at all. The colours mean something to the person
 * who drew them and nothing to the person who opens the file.
 *
 * So a set goes out behind a cover: what the colours mean, how many of each, and — the part that
 * is easy to leave out and most worth including — **how much of the set anybody actually looked
 * at**. A recipient who knows that 14 of 200 sheets carry markups reads the other 186 correctly,
 * as unreviewed rather than as approved.
 *
 * ## Colour is never the only carrier
 *
 * Every entry names its discipline in words beside the swatch, and the counts are numbers. That is
 * the house rule, and a legend is exactly the wrong place to break it: somebody who cannot
 * distinguish the teal from the blue is the person the key exists for.
 */
import { DISCIPLINE_COLORS, STATUS_COLORS, type Viewer } from "@massingcloud/pdf-viewer";

import { isRedaction } from "./redact";

/** What the cover says, gathered before anything is drawn. */
export interface SetSummary {
  /** Discipline, its colour, and how many markups carry it. Ordered by count, most first. */
  disciplines: { name: string; colour: string; count: number }[];
  /** Status and how many are in it. */
  statuses: { name: string; colour: string; count: number }[];
  /** How many markups carry a measured quantity. */
  measurements: number;
  /** Pages that carry at least one markup. */
  reviewed: number;
  /** Pages in the document. */
  pages: number;
  /** Markups in total. */
  total: number;
}

/** Read the set. */
export function summarise(viewer: Viewer): SetSummary {
  // Redactions are excluded throughout. They are an instruction to the exporter rather than a
  // review comment, and counting them would inflate the tally with marks nobody made about the
  // drawing.
  const markups = viewer.store.all().filter((each) => !isRedaction(each));

  const byDiscipline = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const pagesTouched = new Set<number>();
  let measurements = 0;

  for (const markup of markups) {
    const discipline = markup.discipline ?? "general";
    byDiscipline.set(discipline, (byDiscipline.get(discipline) ?? 0) + 1);
    byStatus.set(markup.status, (byStatus.get(markup.status) ?? 0) + 1);
    pagesTouched.add(markup.page);
    if (markup.quantity) measurements += 1;
  }

  const rank = <T extends { count: number }>(rows: T[]) => rows.sort((a, b) => b.count - a.count);

  return {
    disciplines: rank(
      [...byDiscipline].map(([name, count]) => ({
        name,
        colour: DISCIPLINE_COLORS[name as keyof typeof DISCIPLINE_COLORS] ?? "#5c6670",
        count,
      })),
    ),
    statuses: rank(
      [...byStatus].map(([name, count]) => ({
        name,
        colour: STATUS_COLORS[name as keyof typeof STATUS_COLORS] ?? "#5c6670",
        count,
      })),
    ),
    measurements,
    reviewed: pagesTouched.size,
    pages: viewer.doc?.numPages ?? 0,
    total: markups.length,
  };
}

/** Sentence case, for a discipline stored as a lower-case key. */
function readable(name: string): string {
  const spaced = name.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Draw the cover.
 *
 * Sized from the document's first page, so an archive does not open with one item a different
 * shape from the rest. On a set of mixed sizes — a D-size plan set behind an A4 cover — it matches
 * the first page rather than all of them, which is the best a single cover can do.
 *
 * @throws if a drawing surface cannot be obtained.
 */
export async function legendSheet(
  summary: SetSummary,
  title: string,
  widthPt: number,
  heightPt: number,
  dpi: number,
): Promise<Blob> {
  const scale = dpi / 72;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(widthPt * scale);
  canvas.height = Math.round(heightPt * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This system could not provide a drawing surface.");

  // Everything below is in points and scaled once, so the layout reads at any resolution.
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, widthPt, heightPt);

  const margin = Math.min(widthPt, heightPt) * 0.06;
  let y = margin + 40;

  context.fillStyle = "#0d1725";
  context.font = "bold 34px Helvetica, Arial, sans-serif";
  context.fillText(title, margin, y);

  y += 26;
  context.font = "15px Helvetica, Arial, sans-serif";
  context.fillStyle = "#55636f";
  context.fillText("Markup legend and review summary", margin, y);

  y += 18;
  context.fillText(
    // The date the export was made, not the date of issue: those are different facts and only one
    // of them is knowable from here.
    `Exported ${new Date().toISOString().slice(0, 10)}`,
    margin,
    y,
  );

  y += 46;

  // The tally first, because it is the fact a recipient most needs and the one they will not think
  // to ask for.
  context.fillStyle = "#0d1725";
  context.font = "bold 19px Helvetica, Arial, sans-serif";
  context.fillText("How much of this set was reviewed", margin, y);
  y += 26;

  context.font = "15px Helvetica, Arial, sans-serif";
  context.fillStyle = "#55636f";
  const tally =
    summary.pages === 0
      ? `${summary.total} markups.`
      : `${summary.reviewed} of ${summary.pages} sheets carry markups. ` +
        `${summary.total} markups in total, ${summary.measurements} of them measured.`;
  context.fillText(tally, margin, y);
  y += 20;
  context.fillText(
    "Sheets with no markups were not necessarily reviewed and found correct — they may simply not",
    margin,
    y,
  );
  y += 18;
  context.fillText("have been looked at. This count says which is which.", margin, y);

  y += 46;
  y = drawKey(context, "Colours by discipline", summary.disciplines, margin, y);
  y += 26;
  y = drawKey(context, "Colours by status", summary.statuses, margin, y);

  y += 30;
  context.font = "13px Helvetica, Arial, sans-serif";
  context.fillStyle = "#55636f";
  context.fillText(
    "Every measurement carries the scale it was taken at. A quantity whose scale is missing reads",
    margin,
    y,
  );
  y += 17;
  context.fillText("as underived rather than as zero.", margin, y);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("The legend could not be encoded.");
  return blob;
}


/** One block of swatches. Returns the y it finished at. */
function drawKey(
  context: CanvasRenderingContext2D,
  heading: string,
  rows: readonly { name: string; colour: string; count: number }[],
  margin: number,
  top: number,
): number {
  let y = top;
  context.fillStyle = "#0d1725";
  context.font = "bold 19px Helvetica, Arial, sans-serif";
  context.fillText(heading, margin, y);
  y += 24;

  if (rows.length === 0) {
    context.font = "15px Helvetica, Arial, sans-serif";
    context.fillStyle = "#55636f";
    context.fillText("Nothing marked up.", margin, y);
    return y + 8;
  }

  for (const row of rows) {
    context.fillStyle = row.colour;
    context.fillRect(margin, y - 12, 26, 14);
    // Outlined, so a pale swatch is still a shape on white rather than an absence.
    context.strokeStyle = "#0d1725";
    context.lineWidth = 0.8;
    context.strokeRect(margin, y - 12, 26, 14);

    // The name carries the meaning; the swatch only confirms it. Somebody who cannot tell the teal
    // from the blue is exactly who this page is for.
    context.fillStyle = "#0d1725";
    context.font = "15px Helvetica, Arial, sans-serif";
    context.fillText(readable(row.name), margin + 38, y);

    context.fillStyle = "#55636f";
    context.fillText(`${row.count}`, margin + 220, y);
    y += 24;
  }
  return y;
}
