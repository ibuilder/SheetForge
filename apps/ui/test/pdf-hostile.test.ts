/**
 * The second parser of a hostile PDF.
 *
 * pdf.js renders the drawing; pdf-lib reads the same untrusted bytes again whenever pages are taken
 * out of it or a redacted copy is built. It is a smaller, less exercised parser than pdf.js, and it
 * had no generated-input coverage here. The failure that matters most is not a refusal, which the
 * interface reports, but a document crafted so that loading it never finishes: the extract would
 * spin forever on the thread that draws the window.
 *
 * The inputs are real documents, damaged the ways files get damaged: bytes flipped, the tail cut
 * off, a cross-reference offset rewritten, a length made enormous, an array nested far too deep.
 * Seeded, so a failure names the seed that reproduces it.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { extractPages } from "../src/assemble";
import { DAMAGED_DRAWING, PROTECTED_DRAWING } from "../src/pdf-read";

/** How long one damaged document may take before it counts as a hang. Generous for slow CI. */
const BUDGET_MS = 10_000;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

async function seedDocument(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = document.addPage([612, 792]);
    page.drawText(`A-20${index + 1}`, { x: 72, y: 720, size: 18, font });
    page.drawRectangle({ x: 72, y: 72, width: 468, height: 600, borderWidth: 1 });
  }
  document.setTitle("Seed");
  // Uncompressed object streams keep the structure visible to the mutations below.
  return document.save({ useObjectStreams: false });
}

const text = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
const bytesOf = (value: string) => Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff);

/** One way a file gets damaged, chosen and parameterised by the generator. */
function damage(source: Uint8Array, next: () => number): Uint8Array {
  const at = () => Math.floor(next() * source.length);
  switch (Math.floor(next() * 7)) {
    case 0: {
      const copy = source.slice();
      for (let flips = 1 + Math.floor(next() * 20); flips > 0; flips--) copy[at()] = Math.floor(next() * 256);
      return copy;
    }
    case 1:
      return source.slice(0, at());
    case 2:
      return bytesOf(text(source).replace(/startxref\s+\d+/, `startxref\n${Math.floor(next() * 1e12)}`));
    case 3:
      return bytesOf(text(source).replace(/\/Length \d+/g, `/Length ${pick(next, ["99999999999", "-1", "0"])}`));
    case 4:
      return bytesOf(text(source).replace(/\/Count \d+/, `/Count ${pick(next, ["1000000000", "-5", "0"])}`));
    case 5: {
      const depth = 10_000 + Math.floor(next() * 50_000);
      return bytesOf(text(source).replace("/Type /Catalog", `/Type /Catalog /X ${"[".repeat(depth)}`));
    }
    default: {
      const start = at();
      const piece = source.slice(start, start + Math.floor(next() * 4096));
      const out = new Uint8Array(source.length + piece.length);
      const insertAt = at();
      out.set(source.slice(0, insertAt));
      out.set(piece, insertAt);
      out.set(source.slice(insertAt), insertAt + piece.length);
      return out;
    }
  }
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

/** Settles within the budget, or reports a hang rather than letting the suite time out opaquely. */
async function settle(work: Promise<unknown>): Promise<{ outcome: "resolved" | "rejected" | "hung"; value?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<{ outcome: "hung" }>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "hung" }), BUDGET_MS);
  });
  const settled = work.then(
    (value) => ({ outcome: "resolved" as const, value }),
    (value: unknown) => ({ outcome: "rejected" as const, value }),
  );
  try {
    return await Promise.race([settled, hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe("pdf-lib reading a damaged drawing", () => {
  it("extracts from an undamaged document, so the damaged cases are measured against a working path", async () => {
    const extract = await extractPages(await seedDocument(3), [2]);
    expect(extract.pages).toBe(1);
  });

  // pdf-lib calls a document encrypted when its trailer names an /Encrypt dictionary, and refuses it
  // before reading anything else. That is the case, and the only case, that may be called protected.
  it("calls an encrypted drawing protected, and only that", async () => {
    const plain = text(await seedDocument(1));
    const encrypted = bytesOf(plain.replace(/trailer\s*<</, "trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 >>"));
    expect(text(encrypted)).toContain("/Encrypt");

    await expect(extractPages(encrypted, [1])).rejects.toThrow(PROTECTED_DRAWING);
  });

  it(
    "finishes on every damaged document, with a result or an Error — never a hang",
    async () => {
      const seeds = [await seedDocument(1), await seedDocument(3)];
      const problems: string[] = [];

      for (let seed = 1; seed <= 150; seed++) {
        const next = random(seed);
        const damaged = damage(seeds[seed % seeds.length]!, next);
        const result = await settle(extractPages(damaged, [1]));

        if (result.outcome === "hung") problems.push(`seed ${seed}: did not finish in ${BUDGET_MS} ms`);
        if (result.outcome === "rejected") {
          if (!(result.value instanceof Error)) {
            problems.push(`seed ${seed}: rejected with ${typeof result.value}, not an Error`);
          } else if (!result.value.message.startsWith(DAMAGED_DRAWING)) {
            // None of these files is encrypted, so none may be called protected — and none may reach
            // the reviewer as pdf-lib's internals.
            problems.push(`seed ${seed}: told the reviewer "${result.value.message.slice(0, 60)}"`);
          }
        }
        if (result.outcome === "resolved") {
          const { bytes } = result.value as { bytes: Uint8Array };
          if (text(bytes.slice(0, 5)) !== "%PDF-") problems.push(`seed ${seed}: produced something that is not a PDF`);
        }
      }

      expect(problems).toEqual([]);
    },
    150 * BUDGET_MS,
  );
});
