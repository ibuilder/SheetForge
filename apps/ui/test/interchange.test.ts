/**
 * Loading a markup set replaces the drawing's markups, so every way a file can be wrong must leave
 * them untouched — and a correct file must still ask first.
 */
import type { Viewer } from "@massingcloud/pdf-viewer";
import { describe, expect, it, vi } from "vitest";

import { loadMarkupSet, type InterchangeDeps } from "../src/interchange";

/** A viewer holding `count` markups, recording whether anything replaced them. */
function viewerWith(count: number) {
  const reset = vi.fn();
  const viewer = {
    doc: {},
    store: {
      all: () => Array.from({ length: count }, (_, i) => ({ id: `m${i}` })),
      reset,
      setCalibration: vi.fn(),
      setSheet: vi.fn(),
    },
    redraw: vi.fn(),
  } as unknown as Viewer;
  return { viewer, reset };
}

function deps(fileText: string | null, confirmed = true): InterchangeDeps & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    open: () => Promise.resolve(fileText === null ? null : new TextEncoder().encode(fileText)),
    status: (message) => said.push(message),
    confirm: vi.fn(() => confirmed),
  };
}

const SET = (annotations: unknown) =>
  JSON.stringify({ format: "massing-pdf-markups", version: 1, annotations });

const SET_WITH = (fields: Record<string, unknown>) =>
  JSON.stringify({ format: "massing-pdf-markups", version: 1, ...fields });

/** The fields the loader checks a markup by. */
const MARKUP = (id: string) => ({ id, kind: "cloud", sheetId: "A-201", page: 1, points: [] });
const CALIBRATION = { unitsPerPoint: 0.0138, unit: "ft", source: "preset", page: 0 };
const SHEET = { sheetId: "A-201", page: 1, number: "A-201" };

/**
 * A store that behaves like one: it holds what it was last given, and it refuses what the engine
 * would refuse — here a calibration or sheet that is not shaped like one, or, when asked, every
 * calibration at all.
 */
function fakeStore(count: number, { refuseCalibrations = false }: { refuseCalibrations?: boolean }) {
  let held: unknown[] = Array.from({ length: count }, (_, i) => MARKUP(`m${i}`));
  const viewer = {
    doc: {},
    store: {
      all: () => [...held],
      reset: (annotations: unknown[]) => {
        held = [...annotations];
      },
      setCalibration: (calibration: { unitsPerPoint?: unknown } | null) => {
        if (refuseCalibrations || typeof calibration?.unitsPerPoint !== "number") {
          throw new TypeError("refused");
        }
      },
      setSheet: (sheet: { sheetId?: unknown } | null) => {
        if (typeof sheet?.sheetId !== "string") throw new TypeError("refused");
      },
    },
    redraw: vi.fn(),
  } as unknown as Viewer;
  return { viewer, markups: () => [...held] as { id: string }[] };
}

/** A small seeded generator. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Values a damaged or hand-edited file can hold where a record should be. JSON cannot carry NaN or
 * Infinity, so the numbers are the ones it can: negative, zero, huge, fractional.
 */
function hostileValue(next: () => number, depth = 0): unknown {
  const fields = ["id", "kind", "page", "points", "sheetId", "unit", "unitsPerPoint"];
  switch (Math.floor(next() * 10)) {
    case 0:
      return null;
    case 1:
      return [-1, 0, 0.5, 1e308][Math.floor(next() * 4)];
    case 2:
      return "";
    case 3:
      return "cloud";
    case 4:
      return true;
    case 5:
      return [];
    case 6:
      return depth > 2 ? {} : Array.from({ length: Math.floor(next() * 3) }, () => hostileValue(next, depth + 1));
    default:
      return depth > 2
        ? {}
        : Object.fromEntries(
            fields.filter(() => next() < 0.5).map((field) => [field, hostileValue(next, depth + 1)]),
          );
  }
}

describe("loading a markup set", () => {
  it("does nothing, and says nothing, when the reviewer cancels the picker", async () => {
    const { viewer, reset } = viewerWith(3);
    const d = deps(null);
    await loadMarkupSet(viewer, d);
    expect(reset).not.toHaveBeenCalled();
    expect(d.said).toEqual([]);
  });

  it("leaves the markups alone when the file is not JSON", async () => {
    const { viewer, reset } = viewerWith(3);
    const d = deps("<xfdf/>");
    await loadMarkupSet(viewer, d);
    expect(reset).not.toHaveBeenCalled();
    expect(d.said.join(" ")).toContain("not a markup set");
  });

  it("leaves the markups alone when the JSON is not a SheetForge markup set", async () => {
    const { viewer, reset } = viewerWith(3);
    for (const text of [
      JSON.stringify({ format: "something-else", annotations: [] }),
      JSON.stringify({ format: "massing-pdf-markups", annotations: "not a list" }),
      JSON.stringify(null),
      JSON.stringify([1, 2, 3]),
    ]) {
      await loadMarkupSet(viewer, deps(text));
    }
    expect(reset).not.toHaveBeenCalled();
  });

  it("asks before replacing, naming both counts", async () => {
    const { viewer } = viewerWith(3);
    const d = deps(SET([MARKUP("a"), MARKUP("b")]));
    await loadMarkupSet(viewer, d);
    const asked = (d.confirm as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(asked).toContain("replaces the 3 markups on this drawing with the 2 in the file");
  });

  it("replaces nothing when the reviewer says no", async () => {
    const { viewer, reset } = viewerWith(3);
    const d = deps(SET([MARKUP("a")]), false);
    await loadMarkupSet(viewer, d);
    expect(reset).not.toHaveBeenCalled();
    expect(d.said.join(" ")).toContain("unchanged");
  });

  it("does not ask when there is nothing on the drawing to lose", async () => {
    const { viewer, reset } = viewerWith(0);
    const d = deps(SET([MARKUP("a")]));
    await loadMarkupSet(viewer, d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledWith([MARKUP("a")]);
  });

  // The markups used to be reset before the calibrations were read, so this file emptied the
  // drawing and then threw on `null.page`, with no message and nothing to undo.
  it("replaces nothing when a calibration in the set is damaged", async () => {
    const { viewer, reset } = viewerWith(3);
    const d = deps(SET_WITH({ annotations: [MARKUP("a")], calibrations: [null] }));
    await expect(loadMarkupSet(viewer, d)).resolves.toBeUndefined();
    expect(reset).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.said.join(" ")).toContain("damaged");
  });

  it("replaces nothing when one markup in the set is damaged", async () => {
    for (const damaged of [null, 7, "cloud", { id: 7 }, { ...MARKUP("b"), page: 0 }, { ...MARKUP("b"), points: "x" }]) {
      const { viewer, reset } = viewerWith(3);
      const d = deps(SET([MARKUP("a"), damaged]));
      await loadMarkupSet(viewer, d);
      expect(reset, JSON.stringify(damaged)).not.toHaveBeenCalled();
    }
  });

  it("gives the drawing its markups back when the engine refuses part of a set", async () => {
    const store = fakeStore(3, { refuseCalibrations: true });
    const d = deps(SET_WITH({ annotations: [MARKUP("a")], calibrations: [CALIBRATION] }));
    await loadMarkupSet(store.viewer, d);
    expect(store.markups().map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(d.said.join(" ")).toContain("unchanged");
  });

  /**
   * Generated sets, checked against the one property that matters: whatever the file holds, the
   * load finishes without throwing, and the drawing ends with either every markup it had or every
   * markup in the file — never a mixture, and never nothing it did not ask for.
   *
   * Seeded, so a failure names the seed that reproduces it.
   */
  it("never leaves a drawing half-loaded, whatever the file holds", async () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = random(seed);
      const annotations = Array.from({ length: Math.floor(next() * 4) }, () =>
        next() < 0.6 ? MARKUP(`f${Math.floor(next() * 1e6)}`) : hostileValue(next),
      );
      const text = SET_WITH({
        annotations,
        calibrations: next() < 0.5 ? [CALIBRATION, hostileValue(next)] : hostileValue(next),
        sheets: next() < 0.5 ? [SHEET, hostileValue(next)] : hostileValue(next),
      });

      const store = fakeStore(2, {});
      const before = store.markups();
      await expect(loadMarkupSet(store.viewer, deps(text)), `seed ${seed}`).resolves.toBeUndefined();
      const after = store.markups();
      const untouched = JSON.stringify(after) === JSON.stringify(before);
      const replaced = JSON.stringify(after) === JSON.stringify(annotations);
      expect(untouched || replaced, `seed ${seed}: ${text}`).toBe(true);
    }
  });

  it("reports a refusal from the host in its own words — the ceiling, never a path", async () => {
    const { viewer, reset } = viewerWith(3);
    const said: string[] = [];
    await loadMarkupSet(viewer, {
      open: () => Promise.reject(new Error("this file is 3100 MB, over the 64 MB limit for an import file")),
      status: (message) => said.push(message),
      confirm: () => true,
    });
    expect(reset).not.toHaveBeenCalled();
    expect(said.join(" ")).toContain("over the 64 MB limit");
  });
});
