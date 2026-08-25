/**
 * A quantity comparison, as a file somebody can put in front of a decision.
 *
 * The comparison itself is computed by the host. This is only how it leaves — and it leaves as CSV
 * because the next thing that happens to it is that somebody opens it in a spreadsheet beside a
 * bill of quantities. A prettier format that needs converting first would be a format that gets
 * converted badly.
 *
 * ## Why the escaping is written out rather than assumed
 *
 * Cost codes are free text. `03 30 00` is the tidy case; real ones carry commas, quotation marks
 * and the occasional newline pasted in from a schedule. A CSV writer that ignores that produces a
 * file which opens without complaint and has its columns silently shifted — the reader sees a
 * number under the wrong heading and has no reason to doubt it.
 *
 * ## Why the unchanged lines are in the file
 *
 * A schedule of only the differences cannot be checked. Somebody reading it cannot tell a line
 * that held from a line that was never in the comparison, and those want opposite responses. The
 * `movement` column says which, so filtering is the reader's choice rather than ours.
 */

/** One line of the comparison, as the host reports it. */
export interface DeltaLine {
  code: string | null;
  unit: string;
  before: number;
  after: number;
  difference: number;
  proportion: number | null;
  movement: "added" | "removed" | "changed" | "held";
}

/** What the host left out of the totals, and why. */
export interface DeltaExclusions {
  underived: number;
  unconfirmed: number;
}

/**
 * Escape one field.
 *
 * Quoted whenever it contains a comma, a quotation mark, or any kind of line ending — and the
 * embedded quotation marks are doubled, which is what RFC 4180 asks for and what every spreadsheet
 * actually implements.
 */
export function field(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** A number as a spreadsheet should receive it: plain, unpadded, no thousands separators. */
function number(value: number, places = 3): string {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(places).replace(/\.?0+$/, "") || "0";
}

/**
 * Build the file.
 *
 * @param before How the earlier drawing is named, for the column headings.
 * @param after How the later one is named.
 */
export function deltaCsv(
  lines: readonly DeltaLine[],
  exclusions: DeltaExclusions,
  before: string,
  after: string,
): string {
  const rows: string[] = [];

  rows.push(
    [
      "Cost code",
      "Unit",
      field(before),
      field(after),
      "Difference",
      "Change %",
      "Movement",
    ].join(","),
  );

  for (const line of lines) {
    rows.push(
      [
        // An absent code is named rather than left blank. A blank cell in a spreadsheet reads as
        // "nobody filled this in"; these quantities genuinely carry no code, which is a different
        // thing and one somebody may want to chase.
        field(line.code ?? "(no cost code)"),
        field(line.unit),
        number(line.before),
        number(line.after),
        number(line.difference),
        line.proportion === null ? "" : number(line.proportion * 100, 1),
        line.movement,
      ].join(","),
    );
  }

  // What was left out, at the foot of the file rather than in a heading nobody reads. A schedule
  // that quietly omitted measurements is one somebody prices as complete.
  if (exclusions.underived > 0 || exclusions.unconfirmed > 0) {
    rows.push("");
    rows.push(field("Not included in these totals:"));
    if (exclusions.underived > 0) {
      rows.push(
        field(
          `${exclusions.underived} measurement(s) on pages with no scale, which have no value to total`,
        ),
      );
    }
    if (exclusions.unconfirmed > 0) {
      rows.push(
        field(
          `${exclusions.unconfirmed} measurement(s) taken at a scale nobody has confirmed`,
        ),
      );
    }
  }

  // A byte-order mark, then CRLF line endings.
  //
  // Both are for the same reader. Excel on Windows reads a CSV without a BOM in the system ANSI
  // codepage, so `m²` arrives as `mÂ²` and a cost code carrying a degree or diameter symbol
  // arrives as noise — and takeoff units are full of exactly those characters. The cost is that a
  // few strict parsers hand the mark to the caller as part of the first field, so Python wants
  // `utf-8-sig` rather than `utf-8`. That is a documented annoyance for a programmer, weighed
  // against silently corrupted text for the estimator this file is actually written for.
  // Written as an escape rather than as the character itself: a literal byte-order mark is
  // invisible in an editor, and the next person to touch this line would have no way of seeing
  // that it is there before deleting it.
  return `\ufeff${rows.join("\r\n")}\r\n`;
}

/** A one-line summary for the status bar, so the outcome is known before the file is opened. */
export function summarise(lines: readonly DeltaLine[]): string {
  const count = (movement: DeltaLine["movement"]) =>
    lines.filter((line) => line.movement === movement).length;

  const moved = count("changed");
  const added = count("added");
  const removed = count("removed");

  if (moved === 0 && added === 0 && removed === 0) {
    return `Nothing moved. ${lines.length} line${lines.length === 1 ? "" : "s"} compared, all unchanged.`;
  }

  const parts: string[] = [];
  if (moved > 0) parts.push(`${moved} changed`);
  if (added > 0) parts.push(`${added} added`);
  if (removed > 0) parts.push(`${removed} removed`);
  return `${parts.join(", ")} of ${lines.length} line${lines.length === 1 ? "" : "s"}.`;
}
