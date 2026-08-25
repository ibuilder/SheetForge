/**
 * Writing a comparison somebody will price from.
 *
 * The failure mode worth testing is not a crash. It is a file that opens cleanly in a spreadsheet
 * with its columns shifted by one — a number sitting under the wrong heading, with nothing about it
 * looking unusual. Cost codes are free text and real ones carry commas, so this is not a
 * hypothetical.
 */
import { describe, expect, it } from "vitest";

import { deltaCsv, field, summarise, type DeltaLine } from "../src/delta-csv";

const line = (over: Partial<DeltaLine> = {}): DeltaLine => ({
  code: "03 30 00",
  unit: "m2",
  before: 100,
  after: 120,
  difference: 20,
  proportion: 0.2,
  movement: "changed",
  ...over,
});

const none = { underived: 0, unconfirmed: 0 };

describe("escaping a field", () => {
  it("leaves an ordinary value alone", () => {
    expect(field("03 30 00")).toBe("03 30 00");
    expect(field("m2")).toBe("m2");
  });

  it("quotes anything containing a comma, or the columns shift", () => {
    expect(field("Concrete, in situ")).toBe('"Concrete, in situ"');
  });

  it("doubles embedded quotation marks, as every spreadsheet expects", () => {
    expect(field('4" blockwork')).toBe('"4"" blockwork"');
  });

  it("quotes a value containing a line ending", () => {
    expect(field("two\nlines")).toBe('"two\nlines"');
    expect(field("two\r\nlines")).toBe('"two\r\nlines"');
  });
});

describe("writing the comparison", () => {
  it("puts the two drawings' names in the column headings", () => {
    const csv = deltaCsv([line()], none, "A-201 Rev B", "A-201 Rev C");
    expect(csv.split("\r\n")[0]).toContain("A-201 Rev B");
    expect(csv.split("\r\n")[0]).toContain("A-201 Rev C");
  });

  it("escapes a drawing name that would otherwise break the header", () => {
    const csv = deltaCsv([line()], none, "A-201, issued", "A-202");
    const header = csv.split("\r\n")[0]!;
    expect(header).toContain('"A-201, issued"');
    // The comma survives inside its quotes: a naive split finds eight pieces where the file has
    // seven fields, which is exactly the shift the quoting exists to prevent.
    expect(header.split(",").length).toBe(8);
  });

  it("names an absent cost code rather than leaving the cell blank", () => {
    // A blank cell reads as "nobody filled this in". These quantities genuinely carry no code,
    // which is a different thing and one somebody may want to chase.
    const csv = deltaCsv([line({ code: null })], none, "before", "after");
    expect(csv).toContain("(no cost code)");
  });

  it("leaves the percentage empty when there is nothing to be a percentage of", () => {
    const csv = deltaCsv(
      [line({ movement: "added", before: 0, proportion: null })],
      none,
      "before",
      "after",
    );
    const row = csv.split("\r\n")[1]!;
    // Trailing empty field before the movement column, not "Infinity" or "NaN".
    expect(row).toContain(",,added");
  });

  it("keeps unchanged lines, so the file can be checked rather than trusted", () => {
    const csv = deltaCsv([line({ movement: "held", difference: 0 })], none, "b", "a");
    expect(csv).toContain("held");
  });

  it("says at the foot what was left out of the totals", () => {
    const csv = deltaCsv([line()], { underived: 3, unconfirmed: 1 }, "b", "a");
    expect(csv).toContain("Not included in these totals");
    expect(csv).toContain("3 measurement(s) on pages with no scale");
    expect(csv).toContain("1 measurement(s) taken at a scale nobody has confirmed");
  });

  it("says nothing about exclusions when there were none", () => {
    const csv = deltaCsv([line()], none, "b", "a");
    expect(csv).not.toContain("Not included");
  });

  it("starts with a byte-order mark, or Excel mangles every square metre", () => {
    const csv = deltaCsv([line({ unit: "m²" })], none, "b", "a");
    expect(csv.startsWith("\ufeff")).toBe(true);
    // Exactly one. A second would appear as a stray character in the first heading.
    expect(csv.indexOf("\ufeff", 1)).toBe(-1);
  });

  it("keeps the mark out of the first heading's own text", () => {
    // The mark sits before the header, not inside it, so a parser that strips it finds the
    // heading intact rather than finding a column called "\ufeffCost code".
    const csv = deltaCsv([line()], none, "b", "a");
    expect(csv.slice(1).startsWith("Cost code,")).toBe(true);
  });

  it("ends every line the way RFC 4180 asks", () => {
    const csv = deltaCsv([line()], none, "b", "a");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("writes numbers a spreadsheet will read as numbers", () => {
    const csv = deltaCsv(
      [line({ before: 1000, after: 1000.5, difference: 0.5, proportion: 0.0005 })],
      none,
      "b",
      "a",
    );
    const row = csv.split("\r\n")[1]!;
    // No thousands separators, no padding zeros left dangling.
    expect(row).toContain("1000,1000.5,0.5");
  });
});

describe("summarising for the status bar", () => {
  it("says plainly when nothing moved", () => {
    expect(summarise([line({ movement: "held" })])).toContain("Nothing moved");
  });

  it("counts each kind of movement", () => {
    const said = summarise([
      line({ movement: "changed" }),
      line({ movement: "changed" }),
      line({ movement: "added" }),
      line({ movement: "removed" }),
      line({ movement: "held" }),
    ]);
    expect(said).toContain("2 changed");
    expect(said).toContain("1 added");
    expect(said).toContain("1 removed");
    expect(said).toContain("of 5 lines");
  });

  it("does not mention a kind that did not occur", () => {
    const said = summarise([line({ movement: "changed" })]);
    expect(said).not.toContain("added");
    expect(said).not.toContain("removed");
  });
});
