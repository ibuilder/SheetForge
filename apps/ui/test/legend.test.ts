/**
 * What the cover sheet says about a set.
 *
 * The counts are the point. A recipient who is told that 14 of 200 sheets carry markups reads the
 * other 186 correctly — as unreviewed rather than as approved — and that is a distinction nobody
 * thinks to ask for and everybody assumes wrongly.
 */
import { describe, expect, it } from "vitest";

import { summarise } from "../src/legend";

/** Enough of a viewer for the summary to read. */
function viewerWith(markups: unknown[], pages = 10) {
  return {
    doc: { numPages: pages },
    store: { all: () => markups },
  } as never;
}

const markup = (over: Record<string, unknown> = {}) => ({
  id: Math.random().toString(),
  kind: "cloud",
  page: 1,
  status: "open",
  ...over,
});

describe("summarising a set for its cover sheet", () => {
  it("counts how many sheets carry any markup at all", () => {
    const summary = summarise(
      viewerWith([markup({ page: 3 }), markup({ page: 3 }), markup({ page: 7 })], 200),
    );

    // Two markups on page 3 is one sheet reviewed, not two.
    expect(summary.reviewed).toBe(2);
    expect(summary.pages).toBe(200);
    expect(summary.total).toBe(3);
  });

  it("does not count redactions as review comments", () => {
    // A redaction is an instruction to the exporter, not something anybody said about the drawing.
    // Counting it would inflate the tally with marks that are not review.
    const summary = summarise(
      viewerWith([
        markup({ page: 1 }),
        markup({ page: 2, ext: { sfRedaction: true } }),
      ]),
    );

    expect(summary.total).toBe(1);
    // The redacted page must not count as reviewed: nobody said anything about that drawing.
    expect(summary.reviewed).toBe(1);
  });

  it("groups by discipline, most numerous first", () => {
    const summary = summarise(
      viewerWith([
        markup({ discipline: "mechanical" }),
        markup({ discipline: "mechanical" }),
        markup({ discipline: "structural" }),
      ]),
    );

    expect(summary.disciplines[0]).toMatchObject({ name: "mechanical", count: 2 });
    expect(summary.disciplines[1]).toMatchObject({ name: "structural", count: 1 });
    // Every entry carries a colour so the key can be drawn, and a name so the colour is not the
    // only thing carrying the meaning.
    expect(summary.disciplines[0]!.colour).toMatch(/^#/);
  });

  it("treats a markup with no discipline as general rather than dropping it", () => {
    const summary = summarise(viewerWith([markup({})]));
    expect(summary.disciplines).toHaveLength(1);
    expect(summary.disciplines[0]!.name).toBe("general");
  });

  it("counts measurements separately, because they are the numbers people rely on", () => {
    const summary = summarise(
      viewerWith([
        markup({ quantity: { value: 12, unit: "ft" } }),
        markup({}),
      ]),
    );

    expect(summary.measurements).toBe(1);
    expect(summary.total).toBe(2);
  });

  it("says nothing rather than something wrong when a set has no markups", () => {
    const summary = summarise(viewerWith([], 12));
    expect(summary.total).toBe(0);
    expect(summary.reviewed).toBe(0);
    expect(summary.disciplines).toEqual([]);
    expect(summary.pages).toBe(12);
  });
});
