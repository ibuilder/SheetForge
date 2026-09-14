/**
 * Naming a drawing from its title blocks, asking about a new issue, and saying what an import did.
 *
 * All three are decisions that fail quietly. A drawing named after the wrong sheet looks like a
 * correct name; a question that names neither drawing gets answered anyway; a summary that counts
 * only what worked looks like a successful import.
 */
import type { SheetMeta } from "@massingcloud/pdf-viewer";
import { describe, expect, it } from "vitest";

import type { ImportReport } from "../src/bridge";
import {
  describeImport,
  MAX_DRAWING_NAME,
  nameFromSheets,
  reissueQuestion,
  singleSheetNumber,
} from "../src/import-report";

const sheet = (page: number, number?: string, title?: string): SheetMeta => ({
  sheetId: number ?? String(page),
  page,
  ...(number ? { number } : {}),
  ...(title ? { title } : {}),
});

describe("the one sheet number a drawing shows", () => {
  it("is the number every numbered page agrees on", () => {
    expect(singleSheetNumber([sheet(1, "S-501"), sheet(2, " S-501 "), sheet(3)])).toBe("S-501");
  });

  it("is absent for a set of several sheets, or when nothing can be read", () => {
    expect(singleSheetNumber([sheet(1, "A-101"), sheet(2, "A-102")])).toBeNull();
    expect(singleSheetNumber([sheet(1), sheet(2, undefined, "A TITLE")])).toBeNull();
    expect(singleSheetNumber([])).toBeNull();
  });
});

describe("naming a drawing from its title blocks", () => {
  it("uses the one sheet number the drawing shows, with its title", () => {
    expect(nameFromSheets([sheet(1, "A-201", "SECOND FLOOR PLAN")])).toBe("A-201 SECOND FLOOR PLAN");
    expect(nameFromSheets([sheet(1, "A-201")])).toBe("A-201");
  });

  it("accepts a sheet that runs over several pages under the same number", () => {
    expect(nameFromSheets([sheet(1, "S-501", "DETAILS"), sheet(2, "S-501"), sheet(3)])).toBe(
      "S-501 DETAILS",
    );
  });

  it("keeps the file name for a set of several sheets", () => {
    // A set is not any one of its sheets. The register lists each of them.
    expect(nameFromSheets([sheet(1, "A-101", "SITE PLAN"), sheet(2, "A-102", "GROUND FLOOR")])).toBeNull();
  });

  it("keeps the file name when no sheet number can be read", () => {
    expect(nameFromSheets([])).toBeNull();
    expect(nameFromSheets([sheet(1), sheet(2, undefined, "SOME TITLE")])).toBeNull();
    expect(nameFromSheets([sheet(1, "   ")])).toBeNull();
  });

  it("cuts a very long title to what the host accepts, counting characters", () => {
    const name = nameFromSheets([sheet(1, "A-201", "計".repeat(400))])!;
    expect([...name]).toHaveLength(MAX_DRAWING_NAME);
    expect(name.startsWith("A-201 計")).toBe(true);
  });
});

describe("asking whether a drawing is a new issue", () => {
  it("names the drawing already there, the one that arrived, and what declining does", () => {
    const question = reissueQuestion("A-201", "scan0042", {
      id: "doc",
      name: "A-201 SECOND FLOOR PLAN",
      issues: 2,
    });
    expect(question).toContain("A-201 is already in this project, as “A-201 SECOND FLOOR PLAN” (2 issues filed)");
    expect(question).toContain("File “scan0042” as a new issue of it?");
    expect(question).toContain("Cancel keeps it as a separate drawing.");
  });
});

const drawing = (name: string, reopened = false) => ({
  revision: {
    id: `rev-${name}`,
    sourceDocumentId: `doc-${name}`,
    name,
    revisionLabel: null,
    pageCount: 1,
    shortHash: "abc123def456",
    importedAt: "2026-09-14T10:00:00.000Z",
  },
  reopened,
});

const refusal = (file: string, message: string) => ({
  file,
  error: { code: "too-large", message, retryable: false },
});

describe("saying what an import did", () => {
  const none = { read: 0, renamed: 0, reissued: 0, unreadable: 0 };

  it("counts what was added, what was already there, and what the title blocks gave", () => {
    const report: ImportReport = {
      drawings: [drawing("A-201"), drawing("A-202"), drawing("A-101", true)],
      refused: [],
    };
    expect(describeImport(report, { ...none, read: 2, renamed: 1 })).toBe(
      "Added 2 drawings; 1 was already in the project. Sheet numbers read from 2, and 1 renamed to the sheet number on it.",
    );
  });

  it("counts drawings filed as new issues of drawings already there", () => {
    const report: ImportReport = { drawings: [drawing("scan0042"), drawing("scan0043")], refused: [] };
    expect(describeImport(report, { ...none, read: 2, renamed: 1, reissued: 1 })).toBe(
      "Added 2 drawings. Sheet numbers read from 2, and 1 renamed to the sheet number on it, and 1 filed as a new issue of a drawing already here.",
    );
    expect(describeImport(report, { ...none, read: 2, reissued: 2 })).toContain(
      "and 2 filed as new issues of drawings already here.",
    );
  });

  it("names every refused file with its reason, up to a few, and counts the rest", () => {
    const report: ImportReport = {
      drawings: [drawing("A-201")],
      refused: [
        refusal("scan.pdf", "this file is 900 MB, over the 512 MB limit for a drawing"),
        refusal("notes.pdf", "this file is not a valid PDF document"),
        refusal("big.pdf", "this document has 12000 pages, over the 10000 page limit"),
        refusal("more.pdf", "this file is not a valid PDF document"),
      ],
    };
    const said = describeImport(report, none);
    expect(said).toContain("Added 1 drawing.");
    expect(said).toContain("4 refused — scan.pdf: this file is 900 MB");
    expect(said).toContain("notes.pdf: this file is not a valid PDF document");
    expect(said).toContain("big.pdf:");
    expect(said).not.toContain("more.pdf");
    expect(said).toContain("and 1 more");
  });

  it("says so when nothing new arrived", () => {
    expect(describeImport({ drawings: [drawing("A-201", true)], refused: [] }, none)).toBe(
      "That drawing was already in the project.",
    );
    expect(describeImport({ drawings: [], refused: [] }, none)).toBe("Nothing was imported.");
  });

  it("says when title blocks could not be read, and that the file name stays", () => {
    const said = describeImport({ drawings: [drawing("scan0042")], refused: [] }, { ...none, unreadable: 1 });
    expect(said).toContain("could not be read; it keeps its file name.");
  });
});
