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
    const d = deps(SET([{ id: "a" }, { id: "b" }]));
    await loadMarkupSet(viewer, d);
    const asked = (d.confirm as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(asked).toContain("replaces the 3 markups on this drawing with the 2 in the file");
  });

  it("replaces nothing when the reviewer says no", async () => {
    const { viewer, reset } = viewerWith(3);
    const d = deps(SET([{ id: "a" }]), false);
    await loadMarkupSet(viewer, d);
    expect(reset).not.toHaveBeenCalled();
    expect(d.said.join(" ")).toContain("unchanged");
  });

  it("does not ask when there is nothing on the drawing to lose", async () => {
    const { viewer, reset } = viewerWith(0);
    const d = deps(SET([{ id: "a" }]));
    await loadMarkupSet(viewer, d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledWith([{ id: "a" }]);
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
