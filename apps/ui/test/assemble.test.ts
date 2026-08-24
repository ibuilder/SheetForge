/**
 * Reading a page selection the way a person writes one.
 *
 * This is a small parser standing between somebody typing `1-4, 9` and a document being produced
 * from it, and its failure modes are all quiet: a range read backwards, an off-by-one at the end
 * of a set, a number clamped instead of refused. None of those look like errors — they look like
 * an extract, and an extract that is silently the wrong pages is worse than one that refused,
 * because it gets sent.
 */
import { describe, expect, it } from "vitest";

import { parsePageSelection } from "../src/assemble";

describe("reading a page selection", () => {
  it("reads the forms people actually type", () => {
    expect(parsePageSelection("3", 10)).toEqual([3]);
    expect(parsePageSelection("1-4", 10)).toEqual([1, 2, 3, 4]);
    expect(parsePageSelection("1-2, 9", 10)).toEqual([1, 2, 9]);
    // The whitespace of somebody typing in a hurry.
    expect(parsePageSelection("  1 - 3 ,   7  ", 10)).toEqual([1, 2, 3, 7]);
    // Trailing separators, which a prompt box collects constantly.
    expect(parsePageSelection("2,,3,", 10)).toEqual([2, 3]);
  });

  it("keeps the order and the repeats it was given", () => {
    // `1, 5, 1` is a legitimate thing to want — a cover sheet repeated at the back — and
    // reordering or deduplicating would be the tool deciding it knows better than the person.
    expect(parsePageSelection("5, 1, 5", 10)).toEqual([5, 1, 5]);
  });

  it("takes both ends of a range", () => {
    // The off-by-one that would silently drop the last sheet of every extract.
    expect(parsePageSelection("1-10", 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(parsePageSelection("10-10", 10)).toEqual([10]);
  });

  it("refuses a page that is not there rather than clamping it", () => {
    // Clamping `1-500` to `1-200` hands somebody an extract they did not ask for and no reason to
    // look at it twice.
    expect(() => parsePageSelection("1-11", 10)).toThrow(/10 pages/);
    expect(() => parsePageSelection("0", 10)).toThrow(/page 0/);
    expect(() => parsePageSelection("11", 10)).toThrow(/page 11/);
  });

  it("refuses a backwards range and says how to write it", () => {
    expect(() => parsePageSelection("9-3", 10)).toThrow(/3-9/);
  });

  it("refuses something that is not a page at all", () => {
    expect(() => parsePageSelection("all", 10)).toThrow(/1-4, 9/);
    expect(() => parsePageSelection("1..4", 10)).toThrow(/not a page or a range/);
    expect(() => parsePageSelection("-4", 10)).toThrow(/not a page or a range/);
    expect(() => parsePageSelection("1-", 10)).toThrow(/not a page or a range/);
  });

  it("refuses an empty selection rather than producing an empty document", () => {
    expect(() => parsePageSelection("", 10)).toThrow(/nothing to extract/);
    expect(() => parsePageSelection("   ", 10)).toThrow(/nothing to extract/);
    expect(() => parsePageSelection(",,,", 10)).toThrow(/nothing to extract/);
  });

  it("does not treat a decimal or a signed number as a page", () => {
    // `1.5` reaching `Number()` would round somewhere and produce a page nobody asked for.
    expect(() => parsePageSelection("1.5", 10)).toThrow(/not a page or a range/);
    expect(() => parsePageSelection("+2", 10)).toThrow(/not a page or a range/);
  });
});
