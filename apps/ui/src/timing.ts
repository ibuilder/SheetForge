/**
 * Marks for the moments a reviewer actually waits on.
 *
 * Opening a set, the first sheet appearing, a jump to sheet 150, the redraw after zooming in: these
 * are what somebody means by "slow", and none of them had ever been timed. They are recorded as
 * standard User Timing marks, which is what the browser suite reads to measure them — and what
 * shows up, named, in a DevTools performance profile when somebody is chasing a real report.
 *
 * ## Why this is not telemetry
 *
 * ADR-0007 rules telemetry out entirely. User Timing marks never leave the process: nothing sends,
 * stores or aggregates them, and they vanish with the window. They carry page numbers and zoom
 * factors — never a document name, a path, or anything drawn on the sheet.
 *
 * ## Why they are capped and cleared
 *
 * The browser keeps every mark until it is cleared, and a review is hours of scrolling and zooming
 * over one set. So the marks are cleared when a document opens, and stop after a fixed number per
 * document: enough to time a session's opening minutes, bounded so a long afternoon cannot grow the
 * buffer without limit.
 */

const PREFIX = "sf:";

/** Per document. Opening a 200-sheet set and paging through it stays well inside this. */
export const MARK_CAP = 2_000;

let marked = 0;

/** Start timing a new document: clear the last one's marks, then mark the moment it was asked for. */
export function beginDocumentTiming(): void {
  marked = 0;
  try {
    for (const entry of performance.getEntriesByType("mark")) {
      if (entry.name.startsWith(PREFIX)) performance.clearMarks(entry.name);
    }
  } catch {
    // No User Timing: nothing to clear, and nothing will be measured.
  }
  mark("open");
}

/** Record that something happened now. Silent when capped or when the API is unavailable. */
export function mark(name: string): void {
  if (marked >= MARK_CAP) return;
  marked += 1;
  try {
    performance.mark(`${PREFIX}${name}`);
  } catch {
    // A mark is worth nothing to the reviewer and must never cost them an error.
  }
}
