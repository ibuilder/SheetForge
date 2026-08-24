/**
 * Taking pages out of a set.
 *
 * "Send the M&E subcontractor the six mechanical sheets" is one of the most ordinary requests on a
 * job, and until now the answer was to send them the whole 200-sheet issue and ask them to look at
 * pages 41 to 46.
 *
 * ## It makes a new document. It never edits the old one.
 *
 * That is [ADR-0010](../../../docs/adr/0010-page-assembly-produces-a-derived-revision.md), and the
 * reasoning is worth having here too, because the tempting implementation is the other one. A
 * revision's identity is the hash of its bytes. Editing a source in place makes verification
 * report the user's own work as tampering, orphans every markup anchored to it, and — the argument
 * that matters on a construction job — lets somebody remove three sheets from an issue and pass on
 * something still called "Issue C".
 *
 * So the extract is built, hashed and filed as its own revision, recording which revision it came
 * from and what was done. Both documents exist afterwards. The original is the evidence.
 *
 * ## Markups do not come with it
 *
 * A comment anchored to page 41 of the issue is not a comment about page 1 of the extract. The
 * engine's slip-sheet machinery already knows how to give each markup a verdict — unchanged,
 * relocated, or *needs a human* — and wiring this to that is the right answer. Until then the
 * extract starts clean, which is the honest state rather than a guess.
 */
import { PDFDocument } from "pdf-lib";

/**
 * Parse a page selection the way a person writes one.
 *
 * `3`, `1-4`, `1-4, 9, 12-14`, and the whitespace people actually type. Out-of-range and reversed
 * ranges are refused rather than clamped: silently turning `1-500` into `1-200` on a 200-page set
 * gives somebody an extract they did not ask for and no reason to check it.
 *
 * Order is preserved and duplicates are kept, because `1, 5, 1` is a legitimate thing to want — a
 * cover sheet repeated — and second-guessing it would be the tool deciding it knows better.
 *
 * @throws if the selection is empty, malformed, or names a page that is not there.
 */
export function parsePageSelection(input: string, pageCount: number): number[] {
  const pages: number[] = [];

  for (const part of input.split(",")) {
    const piece = part.trim();
    if (!piece) continue;

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(piece);
    const single = /^(\d+)$/.exec(piece);

    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) {
        throw new Error(`"${piece}" runs backwards. Write it as ${to}-${from}.`);
      }
      for (let page = from; page <= to; page += 1) pages.push(check(page, pageCount));
    } else if (single) {
      pages.push(check(Number(single[1]), pageCount));
    } else {
      throw new Error(
        `"${piece}" is not a page or a range. Write something like 1-4, 9, 12-14.`,
      );
    }
  }

  if (pages.length === 0) {
    throw new Error("No pages were named, so there is nothing to extract.");
  }
  return pages;
}

function check(page: number, pageCount: number): number {
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    throw new Error(`This drawing has ${pageCount} pages, so page ${page} is not one of them.`);
  }
  return page;
}

/** What an extract turned out to be, for naming it and reporting it. */
export interface Extract {
  bytes: Uint8Array;
  pages: number;
}

/**
 * Build a PDF from selected pages of another.
 *
 * The pages are copied, not re-rendered: text stays text, vectors stay vectors, and the extract
 * plots at the same scale as the sheet it came from. A takeoff measured off an extract has to come
 * out the same as one measured off the issue, and rasterising would put that at the mercy of a
 * resolution setting.
 *
 * @throws if the source cannot be read, which for a PDF this application already has open means it
 *   is protected.
 */
export async function extractPages(source: Uint8Array, pages: readonly number[]): Promise<Extract> {
  let document: PDFDocument;
  try {
    // A copy, because pdf-lib takes ownership of the buffer it is handed.
    document = await PDFDocument.load(source.slice());
  } catch {
    throw new Error(
      "This drawing is protected, so pages cannot be taken out of it. Ask whoever issued it for " +
        "an unprotected copy.",
    );
  }

  const out = await PDFDocument.create();
  // `copyPages` is given every index at once rather than one per call: it deduplicates the shared
  // resources — fonts, images, the things that make a drawing large — across the whole batch, and
  // calling it per page would embed a fresh copy of each for every sheet.
  const copied = await out.copyPages(
    document,
    pages.map((page) => page - 1),
  );
  for (const page of copied) out.addPage(page);

  out.setTitle("Extract");
  out.setProducer("SheetForge");

  return { bytes: await out.save(), pages: copied.length };
}
