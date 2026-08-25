/**
 * Reading a length the way somebody writes one on a drawing.
 *
 * This sits in the middle of a check *for arithmetic mistakes*, which makes an arithmetic mistake
 * here especially unhelpful: it would report the scale as wrong when the scale is fine, or — worse
 * — as fine when it is wrong.
 *
 * Feet-and-inches is the form that matters. It is what a dimension string on an imperial sheet
 * actually says, and asking somebody to convert `144'-6"` to `144.5` before typing it is asking
 * them to do the very thing the check exists to catch.
 */
import { describe as suite, expect, it } from "vitest";

import { describe, parseLength, type CheckOutcome } from "../src/scale-check";

suite("reading a dimension", () => {
  it("reads a plain number", () => {
    expect(parseLength("144")).toBe(144);
    expect(parseLength("144.5")).toBe(144.5);
    expect(parseLength("  144  ")).toBe(144);
  });

  it("reads feet and inches the way a dimension string writes them", () => {
    expect(parseLength("144'-0\"")).toBe(144);
    expect(parseLength("144'")).toBe(144);
    expect(parseLength("144'6\"")).toBe(144.5);
    expect(parseLength("144' 6\"")).toBe(144.5);
    expect(parseLength("144'-6\"")).toBe(144.5);
    // Three inches is a quarter of a foot, and getting this wrong by a factor of twelve is the
    // exact class of mistake the tool is for.
    expect(parseLength("10'-3\"")).toBeCloseTo(10.25, 10);
  });

  it("reads inches on their own", () => {
    expect(parseLength('18"')).toBeCloseTo(1.5, 10);
  });

  it("accepts a unit suffix the page already knows about", () => {
    expect(parseLength("43.9m")).toBe(43.9);
    expect(parseLength("2500mm")).toBe(2500);
    expect(parseLength("12 ft")).toBe(12);
  });

  it("refuses an impossible inches component rather than adding it up", () => {
    // 144'-13" is somebody's typo. Accepting it would silently return 145.08 and report the scale
    // as slightly out, sending them to re-calibrate a page that was fine.
    expect(parseLength("144'-13\"")).toBeNull();
    expect(parseLength("10'-99\"")).toBeNull();
  });

  it("refuses what is not a length rather than guessing at one", () => {
    expect(parseLength("")).toBeNull();
    expect(parseLength("   ")).toBeNull();
    expect(parseLength("about 144")).toBeNull();
    expect(parseLength("144 feet or so")).toBeNull();
    expect(parseLength("-144")).toBeNull();
    expect(parseLength("0")).toBeNull();
    expect(parseLength("one hundred")).toBeNull();
  });
});

suite("saying what a check concluded", () => {
  const outcome = (over: Partial<CheckOutcome>): CheckOutcome => ({
    verdict: "agrees",
    error: 0,
    measured: 144,
    expected: 144,
    likelyCause: null,
    ...over,
  });

  it("says plainly when the scale is right", () => {
    const said = describe(outcome({}), "ft");
    expect(said).toContain("checks out");
  });

  it("says which way it is out, because that is the half that locates the mistake", () => {
    expect(describe(outcome({ verdict: "close", error: -0.03 }), "ft")).toContain("short");
    expect(describe(outcome({ verdict: "close", error: 0.03 }), "ft")).toContain("long");
  });

  it("tells somebody what to do rather than only what is wrong", () => {
    const said = describe(outcome({ verdict: "close", error: 0.03 }), "ft");
    expect(said).toMatch(/draw it again/i);
  });

  it("names a likely cause when there is one", () => {
    const said = describe(
      outcome({
        verdict: "wrong",
        error: -0.5,
        measured: 72,
        likelyCause: "the sheet may be plotted at half size",
      }),
      "ft",
    );
    expect(said).toContain("scale on this page is wrong");
    expect(said).toContain("half size");
  });

  it("does not invent a cause when the host offered none", () => {
    const said = describe(outcome({ verdict: "wrong", error: 0.37, measured: 197 }), "ft");
    expect(said).toContain("wrong");
    expect(said).not.toContain("may have been");
  });
});
