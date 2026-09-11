/**
 * The timing marks cost the reviewer nothing, and cannot grow without limit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { beginDocumentTiming, mark, MARK_CAP } from "../src/timing";

const ours = () => performance.getEntriesByType("mark").filter((e) => e.name.startsWith("sf:"));

beforeEach(() => performance.clearMarks());

describe("timing marks", () => {
  it("mark the moment a document is asked for", () => {
    beginDocumentTiming();
    expect(ours().map((e) => e.name)).toEqual(["sf:open"]);
  });

  it("start afresh for each document, so one set's marks never time another", () => {
    beginDocumentTiming();
    mark("rendered:1@1.000");
    beginDocumentTiming();
    expect(ours().map((e) => e.name)).toEqual(["sf:open"]);
  });

  it("leave marks that are not ours alone", () => {
    performance.mark("somebody-else");
    beginDocumentTiming();
    expect(performance.getEntriesByName("somebody-else")).toHaveLength(1);
  });

  it("stop at the cap, so a long afternoon cannot grow the buffer without limit", () => {
    beginDocumentTiming();
    for (let i = 0; i < MARK_CAP + 500; i += 1) mark(`rendered:${i}@1.000`);
    expect(ours().length).toBe(MARK_CAP);
  });

  it("never throw at the reviewer when the browser has no User Timing", () => {
    const spy = vi.spyOn(performance, "mark").mockImplementation(() => {
      throw new Error("unsupported");
    });
    try {
      expect(() => beginDocumentTiming()).not.toThrow();
      expect(() => mark("x")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
