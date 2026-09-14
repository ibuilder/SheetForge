/**
 * Reading a drawing with pdf-lib, and what to say when it cannot be done.
 *
 * pdf.js renders the drawing and is forgiving; pdf-lib reads the same bytes again to take pages out
 * or build a redacted copy, and is not. So a drawing can be open, marked up and measured, and still
 * refuse to be copied. Two things were wrong with how that was reported, and a generated test over
 * 150 damaged drawings found both:
 *
 * - **Every failure to load was called "protected".** Forty-five of the sixty-nine refusals were
 *   files with flipped bytes, not encryption. Telling somebody to chase the issuer for an
 *   "unprotected copy" of a drawing that was damaged in transit sends them to the wrong person with
 *   the wrong request.
 * - **A failure after loading was not caught at all.** The other twenty-four reached the status bar
 *   as pdf-lib's own internals — `_this.catalog.Pages is not a function` — which tells a reviewer
 *   nothing and looks like the application broke.
 */
import { PDFDocument } from "pdf-lib";

/** How a refusal from pdf-lib begins, for tests to hold the wording to. */
export const PROTECTED_DRAWING = "This drawing is protected";
export const DAMAGED_DRAWING = "Part of this drawing is damaged";

/**
 * Load a drawing to copy from it, refusing one that is protected and naming one that is damaged.
 *
 * ## Why encryption is not recognised by catching pdf-lib's error
 *
 * pdf-lib does throw an `EncryptedPDFError` for an encrypted document, but the thrown value is not
 * `instanceof EncryptedPDFError`: the library is compiled to ES5, where a subclass of `Error` loses
 * its prototype, so the check is always false. An earlier version of this module relied on it, and
 * the test for an encrypted drawing caught it calling that drawing damaged. The message is prose,
 * which is no better. So the document is loaded with `ignoreEncryption` and pdf-lib's `isEncrypted`
 * flag — the same flag its own refusal is based on — is asked instead.
 *
 * That does not weaken the refusal. The flag is read as soon as the document is parsed, and an
 * encrypted drawing is refused before anything is taken out of it: quietly stripping somebody
 * else's protection from a document that is about to be handed out is not this tool's decision.
 *
 * @param act what cannot be done if it is refused, as a verb phrase: "take pages out of it".
 */
export async function loadForCopying(source: Uint8Array, act: string): Promise<PDFDocument> {
  let document: PDFDocument;
  try {
    // A copy, because pdf-lib takes ownership of the buffer it is handed.
    document = await PDFDocument.load(source.slice(), { ignoreEncryption: true });
  } catch {
    throw damagedDrawing(act);
  }
  if (document.isEncrypted) {
    throw new Error(
      `${PROTECTED_DRAWING}, so SheetForge cannot ${act}. Ask whoever issued it for an unprotected ` +
        "copy. Marking up and measuring still work.",
    );
  }
  return document;
}

/**
 * The error for a drawing pdf-lib loaded and then could not copy from, or could not load at all.
 *
 * @param act as for {@link loadForCopying}.
 */
export function damagedDrawing(act: string): Error {
  return new Error(
    `${DAMAGED_DRAWING}, so SheetForge cannot ${act}. It still opens, and marking up and measuring ` +
      "still work. Ask whoever issued it for a fresh copy.",
  );
}
