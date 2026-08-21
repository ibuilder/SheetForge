/**
 * A minimal XLSX writer.
 *
 * CSV is what the engine exports, and CSV is what a spreadsheet mangles: a sheet number like
 * `03-30-00` becomes a date, a cost code with a leading zero loses it, a quantity with a comma in
 * it splits into two columns, and a markup note containing a newline breaks the row. Every one of
 * those has been somebody's afternoon. A workbook carries types, so a number is a number and a
 * string stays a string.
 *
 * ## Why hand-written rather than a library
 *
 * An XLSX file is a zip of a handful of XML parts, and the subset needed to write one — no
 * formulas, no styles beyond a header row, no charts — is about two hundred lines. The candidate
 * libraries are between 200 KB and 2 MB, and the one most people reach for has had a complicated
 * distribution history that would need a licensing decision of its own.
 *
 * The zip comes from the drawing engine, which already has one for BCF archives. So this adds no
 * dependency at all.
 *
 * ## What it does not do
 *
 * No styling beyond bold headers and a frozen top row, no column widths computed from content, no
 * merged cells, no formulas. If a takeoff ever needs a `SUM` at the bottom, it should be a real
 * value computed here rather than a formula string — a spreadsheet that recalculates a quantity is
 * a spreadsheet that can disagree with the drawing.
 */

import { zip, type ZipEntry } from "@massingcloud/pdf-viewer";

/** A cell. `null` is an empty cell rather than a zero or an empty string, which mean other things. */
export type Cell = string | number | boolean | null;

/** One worksheet. */
export interface Sheet {
  /** Tab name. Excel refuses some characters and caps the length; {@link safeSheetName} handles it. */
  name: string;
  /** The first row, rendered bold and frozen. */
  headers: string[];
  rows: Cell[][];
}

/** Escape text for XML content. */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Control characters are not legal in XML 1.0 at all, and a markup note pasted out of a PDF
    // can carry them. Excel rejects the whole workbook rather than the offending cell, so the user
    // is told their export is corrupt with no clue which markup caused it.
    // eslint-disable-next-line no-control-regex -- deliberate: these characters are the subject.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** `0 -> A`, `26 -> AA`. Spreadsheet column names are base-26 with no zero digit. */
export function columnName(index: number): string {
  let name = "";
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

/**
 * A tab name Excel will accept.
 *
 * Excel refuses `: \ / ? * [ ]`, caps names at 31 characters, and rejects an empty one. It does not
 * report which sheet was at fault — it declares the whole workbook corrupt — so this is worth
 * getting right rather than discovering later.
 */
export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
  return cleaned || "Sheet";
}

/** One `<c>` element. */
function cell(reference: string, value: Cell, isHeader: boolean): string {
  const style = isHeader ? ' s="1"' : "";
  if (value === null || value === "") return "";

  if (typeof value === "number") {
    // A non-finite number has no XLSX representation. Writing it as text keeps the cell honest —
    // and visibly wrong — instead of producing a file Excel refuses to open.
    if (!Number.isFinite(value)) {
      return `<c r="${reference}"${style} t="inlineStr"><is><t>${xml(String(value))}</t></is></c>`;
    }
    return `<c r="${reference}"${style}><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${reference}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  // Inline strings rather than a shared-strings table: the table saves space when values repeat a
  // great deal, and costs a second pass plus an index. A markup register is mostly unique prose.
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function worksheet(sheet: Sheet): string {
  const rows: string[] = [];
  const width = Math.max(sheet.headers.length, ...sheet.rows.map((row) => row.length), 1);

  const header = sheet.headers
    .map((value, column) => cell(`${columnName(column)}1`, value, true))
    .join("");
  rows.push(`<row r="1">${header}</row>`);

  sheet.rows.forEach((row, index) => {
    const number = index + 2;
    const cells = row
      .map((value, column) => cell(`${columnName(column)}${number}`, value, false))
      .join("");
    rows.push(`<row r="${number}">${cells}</row>`);
  });

  const lastCell = `${columnName(width - 1)}${sheet.rows.length + 1}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCell}"/>
<sheetViews><sheetView workbookViewId="0">
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<sheetData>${rows.join("")}</sheetData>
<autoFilter ref="A1:${lastCell}"/>
</worksheet>`;
}

/**
 * Build an XLSX workbook.
 *
 * Sheet names are made safe and deduplicated: Excel treats two sheets with the same name as a
 * corrupt file, and a takeoff grouped by discipline can easily produce two that collide after
 * truncation to 31 characters.
 */
export function buildWorkbook(sheets: Sheet[]): Uint8Array {
  const used = new Set<string>();
  const named = sheets.map((sheet) => {
    let name = safeSheetName(sheet.name);
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      const tail = ` (${suffix++})`;
      name = safeSheetName(name.slice(0, 31 - tail.length) + tail);
    }
    used.add(name.toLowerCase());
    return { ...sheet, name };
  });

  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named
  .map(
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join("\n")}
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${named
  .map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
  .join("\n")}
</sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named
  .map(
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  )
  .join("\n")}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    {
      // Two fonts and two cell formats: the minimum that gives a bold header row. Excel requires
      // the full skeleton even when nothing is styled, and omitting a section makes it declare the
      // workbook corrupt rather than falling back to a default.
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`,
    },
    ...named.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: worksheet(sheet),
    })),
  ];

  return zip(entries);
}
