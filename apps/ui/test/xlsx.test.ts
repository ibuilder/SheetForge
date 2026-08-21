/**
 * The XLSX writer.
 *
 * Excel does not report which part of a workbook it disliked — it declares the whole file corrupt
 * and offers to repair it — so every constraint it imposes has to be met before the file is
 * written, not discovered by a user whose export will not open. These tests are that check.
 *
 * The zip is unpacked and the XML inspected rather than diffed against a golden file, because a
 * golden workbook would pin incidental formatting and fail on every harmless change.
 */

import { describe, expect, it } from "vitest";
import { buildWorkbook, columnName, safeSheetName, type Sheet } from "../src/xlsx";

/**
 * Read entries out of a zip.
 *
 * Deliberately a separate implementation from the writer's: checking the output with the same code
 * that produced it would agree with itself no matter what either did.
 */
function unzip(archive: Uint8Array): Map<string, string> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();
  const files = new Map<string, string>();

  // Walk the local file headers. Everything this writer emits is stored (uncompressed), which is
  // asserted below — if that ever changes this reader has to inflate.
  let offset = 0;
  while (offset + 4 <= archive.length && view.getUint32(offset, true) === 0x0403_4b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;

    const name = decoder.decode(archive.subarray(nameStart, nameStart + nameLength));
    expect(method, `${name} is compressed; this reader only handles stored entries`).toBe(0);
    files.set(name, decoder.decode(archive.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return files;
}

const simple: Sheet = {
  name: "Markups",
  headers: ["Id", "Subject", "Page", "Quantity"],
  rows: [
    ["m-1", "Duct clashes with beam", 4, 12.5],
    ["m-2", "Verify dimension", 7, null],
  ],
};

describe("workbook structure", () => {
  it("contains every part Excel requires", () => {
    const files = unzip(buildWorkbook([simple]));
    // Omitting any one of these makes Excel declare the file corrupt rather than falling back.
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]) {
      expect(files.has(part), `${part} is missing`).toBe(true);
    }
  });

  it("declares a content type and a relationship for every sheet", () => {
    const files = unzip(buildWorkbook([simple, { ...simple, name: "Takeoff" }]));
    const types = files.get("[Content_Types].xml")!;
    const rels = files.get("xl/_rels/workbook.xml.rels")!;

    expect(types).toContain("/xl/worksheets/sheet1.xml");
    expect(types).toContain("/xl/worksheets/sheet2.xml");
    expect(rels).toContain("worksheets/sheet1.xml");
    expect(rels).toContain("worksheets/sheet2.xml");
    expect(files.has("xl/worksheets/sheet2.xml")).toBe(true);
  });
});

describe("cells", () => {
  it("writes a number as a number and a string as a string", () => {
    // The whole reason for preferring a workbook to CSV: a spreadsheet must not decide that
    // `03-30-00` is a date or that a cost code's leading zero is decorative.
    const sheet = unzip(buildWorkbook([simple])).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("<v>12.5</v>");
    expect(sheet).toContain("t=&quot;inlineStr&quot;".replace(/&quot;/g, '"'));
    expect(sheet).toContain("Duct clashes with beam");
  });

  it("leaves an empty cell empty rather than writing a zero", () => {
    const sheet = unzip(buildWorkbook([simple])).get("xl/worksheets/sheet1.xml")!;
    // Row 3 has a null quantity. A zero there would be summed as a real measurement of nothing.
    const row = /<row r="3">(.*?)<\/row>/s.exec(sheet)?.[1] ?? "";
    expect(row).not.toContain('r="D3"');
  });

  it("escapes the characters that would otherwise close a tag", () => {
    const workbook = buildWorkbook([
      {
        name: "Markups",
        headers: ["Subject"],
        rows: [['<b>bold</b> & "quoted" — it’s fine']],
      },
    ]);
    const sheet = unzip(workbook).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("&lt;b&gt;bold&lt;/b&gt; &amp;");
    expect(sheet).not.toContain("<b>bold</b>");
  });

  it("strips control characters, which make Excel reject the whole file", () => {
    // A note pasted out of a PDF can carry these. Excel does not skip the cell — it refuses the
    // workbook, and the user has no idea which markup was responsible.
    const workbook = buildWorkbook([
      { name: "Markups", headers: ["Subject"], rows: [["before\u0007\u0001after"]] },
    ]);
    const sheet = unzip(workbook).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("beforeafter");
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(sheet)).toBe(false);
  });

  it("keeps a newline and a tab, which are legal and meaningful", () => {
    const workbook = buildWorkbook([
      { name: "Markups", headers: ["Note"], rows: [["line one\nline two"]] },
    ]);
    const sheet = unzip(workbook).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("line one\nline two");
    // Without this the spreadsheet collapses the break and the note reads as one run-on line.
    expect(sheet).toContain('xml:space="preserve"');
  });

  it("writes a non-finite number as text rather than producing a file Excel refuses", () => {
    const workbook = buildWorkbook([
      { name: "Takeoff", headers: ["Area"], rows: [[Number.NaN], [Number.POSITIVE_INFINITY]] },
    ]);
    const sheet = unzip(workbook).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("NaN");
    expect(sheet).toContain("Infinity");
    expect(sheet).not.toContain("<v>NaN</v>");
  });

  it("writes a boolean as a boolean", () => {
    const workbook = buildWorkbook([
      { name: "Markups", headers: ["Verified"], rows: [[true], [false]] },
    ]);
    const sheet = unzip(workbook).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain('t="b"><v>1</v>');
    expect(sheet).toContain('t="b"><v>0</v>');
  });
});

describe("sheet names", () => {
  it("removes the characters Excel refuses", () => {
    expect(safeSheetName("Level 4 / MEP")).toBe("Level 4   MEP");
    expect(safeSheetName("A:B*C?D[E]F\\G")).toBe("A B C D E F G");
  });

  it("truncates to the 31-character limit and never returns an empty name", () => {
    expect(safeSheetName("x".repeat(80))).toHaveLength(31);
    expect(safeSheetName("   ")).toBe("Sheet");
    expect(safeSheetName("")).toBe("Sheet");
  });

  it("deduplicates names that collide only after truncation", () => {
    // A takeoff grouped by discipline produces these, and Excel treats two identically-named
    // sheets as a corrupt workbook rather than renaming one.
    const long = "Structural concrete works package";
    const files = unzip(
      buildWorkbook([
        { name: long, headers: ["A"], rows: [] },
        { name: long, headers: ["A"], rows: [] },
        { name: long, headers: ["A"], rows: [] },
      ]),
    );
    const names = [...(files.get("xl/workbook.xml")!.matchAll(/name="([^"]+)"/g))].map((m) => m[1]!);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(31);
  });

  it("escapes a sheet name in the workbook XML", () => {
    const files = unzip(buildWorkbook([{ name: "R&D", headers: ["A"], rows: [] }]));
    expect(files.get("xl/workbook.xml")).toContain("R&amp;D");
  });
});

describe("column references", () => {
  it("counts in base-26 with no zero digit", () => {
    // Getting this wrong puts a value in the wrong column past 26 — invisible until somebody's
    // takeoff has its quantities under the wrong heading.
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(27)).toBe("AB");
    expect(columnName(51)).toBe("AZ");
    expect(columnName(52)).toBe("BA");
    expect(columnName(701)).toBe("ZZ");
    expect(columnName(702)).toBe("AAA");
  });
});

describe("edge cases", () => {
  it("writes a workbook with no rows", () => {
    const files = unzip(buildWorkbook([{ name: "Markups", headers: ["Id"], rows: [] }]));
    expect(files.get("xl/worksheets/sheet1.xml")).toContain('<row r="1">');
  });

  it("handles a ragged sheet where rows differ in length", () => {
    const workbook = buildWorkbook([
      { name: "Markups", headers: ["A", "B", "C"], rows: [["only one"], ["two", "cells"]] },
    ]);
    const sheet = unzip(workbook).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain('<dimension ref="A1:C3"/>');
  });

  it("freezes the header row and enables filtering", () => {
    // A markup register is hundreds of rows; scrolling past the headings makes it unreadable.
    const sheet = unzip(buildWorkbook([simple])).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain("<autoFilter");
  });

  it("produces a zip that starts with the local file header signature", () => {
    const workbook = buildWorkbook([simple]);
    expect([...workbook.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
