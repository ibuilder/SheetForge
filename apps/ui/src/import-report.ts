/**
 * What an import should call each drawing, and what to tell the person who imported them.
 *
 * Kept apart from the code that reads title blocks and talks to the host, because both decisions
 * are easy to get quietly wrong and both can be tested without a PDF: a drawing named after the
 * wrong sheet, or a summary that says "Added 12 drawings" when three of them were refused.
 */
import type { SheetMeta } from "@massingcloud/pdf-viewer";

import type { ImportReport } from "./bridge";

/** The longest name the host accepts for a drawing, in characters. Mirrors `SourceDocument::MAX_NAME`. */
export const MAX_DRAWING_NAME = 200;

/** How many refused files a summary names before it counts the rest. */
const NAMED_REFUSALS = 3;

/**
 * What to call a drawing, from what its title blocks say — or `null` to keep the name it was filed
 * under.
 *
 * Only when every page that shows a sheet number shows the *same* one. A file holding a set of many
 * sheets keeps its filename: it is not any one of those sheets, and naming it after the first would
 * be a small lie on the drawing list, with the register already listing every sheet in it. A
 * drawing with no readable number — a scan, or a title block the reader does not recognise — also
 * keeps its filename. A filename is a poor name; a guessed one is worse.
 */
export function nameFromSheets(sheets: readonly SheetMeta[]): string | null {
  const numbers = new Set(
    sheets.map((sheet) => sheet.number?.trim()).filter((number): number is string => Boolean(number)),
  );
  if (numbers.size !== 1) return null;
  const [number] = [...numbers];
  if (!number) return null;

  const title = sheets
    .find((sheet) => sheet.number?.trim() === number && sheet.title?.trim())
    ?.title?.trim();
  const name = title ? `${number} ${title}` : number;
  // Counted in characters, as the host counts them, so a title in any script is cut where the host
  // would accept it rather than refused for being a few bytes over.
  const characters = [...name];
  return characters.length > MAX_DRAWING_NAME
    ? characters.slice(0, MAX_DRAWING_NAME).join("").trimEnd()
    : name;
}

/** What reading the title blocks of an import's new drawings came to. */
export interface TitleBlockOutcome {
  /** New drawings on which at least one sheet number was found. */
  read: number;
  /** New drawings renamed from their title blocks. */
  renamed: number;
  /** New drawings whose title blocks could not be read at all. */
  unreadable: number;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * One status line saying what an import did with every file.
 *
 * Every outcome is counted, and refused files are named with their reasons, because the failure
 * this replaces was an import that stopped at the first bad file and reported an error naming none
 * of them. A summary that only counted successes would repeat that from the other side.
 */
export function describeImport(report: ImportReport, titles: TitleBlockOutcome): string {
  const added = report.drawings.filter((drawing) => !drawing.reopened).length;
  const already = report.drawings.length - added;
  const sentences: string[] = [];

  if (added > 0) {
    sentences.push(
      `Added ${plural(added, "drawing", "drawings")}` +
        (already > 0 ? `; ${plural(already, "was", "were")} already in the project.` : "."),
    );
  } else if (already > 0) {
    sentences.push(
      already === 1 ? "That drawing was already in the project." : "Those drawings were already in the project.",
    );
  }

  if (titles.read > 0 || titles.renamed > 0) {
    const renamed =
      titles.renamed > 0 ? `, and ${titles.renamed} renamed to the sheet number on it` : "";
    sentences.push(`Sheet numbers read from ${titles.read}${renamed}.`);
  }
  if (titles.unreadable > 0) {
    sentences.push(
      `The title blocks of ${plural(titles.unreadable, "drawing", "drawings")} could not be read; ` +
        `${titles.unreadable === 1 ? "it keeps its" : "they keep their"} file name.`,
    );
  }

  if (report.refused.length > 0) {
    const named = report.refused
      .slice(0, NAMED_REFUSALS)
      .map((refusal) => `${refusal.file}: ${refusal.error.message}`)
      .join("; ");
    const more = report.refused.length - NAMED_REFUSALS;
    sentences.push(
      `${report.refused.length} refused — ${named}${more > 0 ? `; and ${more} more` : ""}.`,
    );
  }

  return sentences.join(" ") || "Nothing was imported.";
}
