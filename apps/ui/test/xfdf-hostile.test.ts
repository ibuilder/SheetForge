/**
 * XFDF arriving from somebody else, generated rather than imagined.
 *
 * The threat model's named adversary is "a hostile XFDF arriving by email from a subcontractor", and
 * until this file the engine's XFDF parser had no test of any kind in this repository. It runs a
 * DOMParser over the file and turns what it finds into markup drafts, which go straight into the
 * drawing's store. The cases worth finding are the ones nobody would write by hand: a page of
 * `1e9`, a rect of `NaN,0,0,0`, a document cut off halfway through an attribute.
 *
 * Seeded, so a failure names the seed that reproduces it.
 */
import { fromXfdf, type AnnotationDraft } from "@massingcloud/pdf-viewer";
import { describe, expect, it } from "vitest";

/** A three-page letter-size document, which is what every draft has to land on. */
const PAGES = new Map([1, 2, 3].map((page) => [page, { width: 612, height: 792 }]));

const ONE_SQUARE =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>' +
  '<square page="0" rect="100,100,200,200" title="A. Reviewer" name="sq-1"/>' +
  "</annots></xfdf>";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const pick = <T>(next: () => number, values: readonly T[]): T => values[Math.floor(next() * values.length)]!;

const ELEMENTS = [
  "square", "circle", "line", "polygon", "polyline", "ink", "text", "freetext", "highlight",
  "stamp", "caret", "squiggly", "fileattachment", "not-an-annotation",
] as const;

const NUMBERS = ["0", "1", "2", "-1", "999999", "1e9", "1e308", "-1e308", "0.5", "NaN", "Infinity", "", "abc"];

const ESCAPE = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function attribute(next: () => number, name: string): string {
  switch (name) {
    case "rect":
    case "vertices":
    case "coords": {
      const count = pick(next, [0, 1, 3, 4, 4, 4, 8, 9]);
      return Array.from({ length: count }, () => pick(next, NUMBERS)).join(pick(next, [",", ",", ";", " "]));
    }
    case "page":
    case "width":
    case "rotation":
      return pick(next, NUMBERS);
    default:
      return ESCAPE(
        pick(next, ["A. Reviewer", "", "x".repeat(5000), "‮evil", "<script>", "é中文", "&amp;"]),
      );
  }
}

/** An XFDF document built from the vocabulary real ones use, filled with values real ones do not. */
function generatedXfdf(next: () => number): string {
  const annotations = Array.from({ length: Math.floor(next() * 6) }, () => {
    const element = pick(next, ELEMENTS);
    const attributes = ["page", "rect", "title", "name", "color", "width", "rotation", "vertices", "coords"]
      .filter(() => next() < 0.7)
      .map((name) => `${name}="${attribute(next, name)}"`)
      .join(" ");
    const body = next() < 0.3 ? `<contents>${ESCAPE(attribute(next, "contents"))}</contents>` : "";
    return body ? `<${element} ${attributes}>${body}</${element}>` : `<${element} ${attributes}/>`;
  }).join("");
  const document =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>${annotations}</annots></xfdf>`;
  // A file cut off in transit, which is how a lot of damaged files actually arrive.
  return next() < 0.2 ? document.slice(0, Math.floor(next() * document.length)) : document;
}

/** Run the parser the way the importer does: a throw is a refusal the importer reports. */
function parse(xml: string): AnnotationDraft[] | "refused" {
  try {
    return fromXfdf(xml, { pages: PAGES, defaultAuthor: "Reviewer" });
  } catch (error) {
    // A refusal must still be an Error: the importer catches it, but a thrown string or `undefined`
    // is a sign the parser failed somewhere it did not mean to.
    expect(error).toBeInstanceOf(Error);
    return "refused";
  }
}

describe("XFDF from somebody else", () => {
  it("reads a well-formed square onto the first page", () => {
    const drafts = parse(ONE_SQUARE);
    expect(drafts).not.toBe("refused");
    expect(drafts).toHaveLength(1);
    expect((drafts as AnnotationDraft[])[0]!.page).toBe(1);
  });

  it("never produces a draft that is off the document or not made of numbers", () => {
    const offenders: string[] = [];
    for (let seed = 1; seed <= 500; seed++) {
      const xml = generatedXfdf(random(seed));
      const drafts = parse(xml);
      if (drafts === "refused") continue;
      for (const draft of drafts) {
        const onTheDocument = PAGES.has(draft.page);
        const numeric = draft.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
        if (!onTheDocument || !numeric) {
          offenders.push(`seed ${seed}: ${draft.kind} on page ${draft.page}, points ${JSON.stringify(draft.points)}`);
        }
      }
    }
    expect(offenders.slice(0, 10), `${offenders.length} drafts would reach the store`).toEqual([]);
  });
});
