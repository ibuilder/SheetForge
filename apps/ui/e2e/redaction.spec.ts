/**
 * Does the redacted text actually leave the file?
 *
 * This is the only question that matters about a redaction feature, and it is the one a
 * demonstration never answers. A black rectangle drawn over a phone number looks identical whether
 * the text underneath was removed or merely covered — and if it was merely covered, somebody
 * discloses a document confident the rates are hidden, and they are not. Redaction that fails is
 * worse than no redaction, because it is believed.
 *
 * So the test drawing carries a string that exists nowhere else in the universe, the test redacts
 * the area it sits in, and then it searches the exported bytes for it. Not the rendering: the
 * bytes. If the string is in the file, the feature does not ship.
 *
 * The second test is the other half of the bargain — that a page nobody redacted is *not*
 * rasterised, because charging a whole 200-sheet set the cost of one redaction on sheet 12 would
 * be a poor trade made silently.
 */
import { expect, test, type Page } from "@playwright/test";

/** A string that cannot plausibly occur by accident, so finding it means finding *it*. */
const SECRET = "CONFIDENTIALRATE7Q4XZW";

/**
 * A two-page PDF with the secret on page one and ordinary text on page two.
 *
 * Uncompressed content streams, deliberately: if the secret were deflated, "not found in the
 * bytes" could mean "compressed" rather than "removed", and the test would pass for the wrong
 * reason on the exact question it exists to answer.
 */
function secretPdf(): Uint8Array {
  const page = (body: string) =>
    `BT /F1 24 Tf 72 700 Td (${body}) Tj ET\n50 50 512 692 re S\n`;

  const first = page(SECRET);
  const second = page("Nothing sensitive on this page");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${first.length} >>\nstream\n${first}endstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${second.length} >>\nstream\n${second}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

const REVISION = {
  id: "0192f0c1-0000-7000-8000-0000000000aa",
  sourceDocumentId: "0192f0c1-0000-7000-8000-0000000000bb",
  name: "A-900",
  revisionLabel: null,
  pageCount: 2,
  shortHash: "ab12cd34ef56",
  importedAt: "2026-08-20T10:00:00.000Z",
};

const PROJECT = {
  id: "0192f0c1-0000-7000-8000-0000000000cc",
  name: "A-900",
  jobNumber: null,
  sourceCount: 1,
  format: 1,
};

async function stubHost(page: Page, pdf: number[]): Promise<void> {
  await page.addInitScript(
    ({ pdfBytes, revision, project }) => {
      localStorage.setItem("sheetforge.tutorial-offered", "yes");
      (window as unknown as { __sfExported: unknown[] }).__sfExported = [];

      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        transformCallback: (callback: unknown) => {
          void callback;
          return 1;
        },
        invoke(command: string, args: Record<string, unknown>, options?: Record<string, unknown>) {
          if (args instanceof ArrayBuffer || args instanceof Uint8Array) {
            const headers = (options?.["headers"] ?? {}) as Record<string, string>;
            (window as unknown as { __sfExported: unknown[] }).__sfExported.push({
              extension: decodeURIComponent(headers["x-sf-extension"] ?? ""),
              bytes: [...(args instanceof Uint8Array ? args : new Uint8Array(args))],
            });
            return Promise.resolve(null);
          }
          switch (command) {
            case "app_info":
              return Promise.resolve({
                version: "0.1.0-test",
                actor: "a.reviewer@example.com",
                role: "owner",
                limits: {
                  maxPdfMb: 512, maxAttachmentMb: 64, maxPackageMb: 4096, maxInterchangeMb: 64,
                  maxPages: 10000, maxConcurrentJobs: 4, jobTimeoutSecs: 120,
                  maxDecompressedMb: 1024, maxArchiveEntries: 50000,
                },
              });
            case "plugin:event|listen":
              return Promise.resolve(1);
            case "project_current":
              return Promise.resolve(null);
            case "pdf_open":
              return Promise.resolve({ project, revision, reopened: false });
            case "document_list":
              return Promise.resolve([revision]);
            case "document_bytes":
              return Promise.resolve(new Uint8Array(pdfBytes).buffer);
            case "markup_list":
            case "recent_list":
              return Promise.resolve([]);
            case "calibration_get":
              return Promise.resolve(null);
            case "markup_create": {
              const markup = args["markup"] as Record<string, unknown>;
              return Promise.resolve({
                ...markup,
                id: `markup-${Math.floor(performance.now())}`,
                status: "open",
                version: 1,
                quantity: null,
                metadata: markup["metadata"] ?? {},
                createdBy: "a.reviewer@example.com",
                createdAt: "2026-08-20T10:00:00.000Z",
                updatedAt: "2026-08-20T10:00:00.000Z",
              });
            }
            default:
              return Promise.resolve(null);
          }
        },
      };
    },
    { pdfBytes: pdf, revision: REVISION, project: PROJECT },
  );
}

/** Draw a redaction over the area the secret sits in. */
async function redactTheSecret(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Redact", exact: true }).click();

  // The page canvas, found by size — the first canvas in the stage is a thumbnail, and dragging
  // across a thumbnail arms nothing.
  const box = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".sf-stage canvas")];
    const node = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  });

  // The secret is drawn at 72,700 on a 612x792 page — near the top left. The rectangle is drawn
  // generously around it, because a redaction that only half covers its target is a bug this test
  // must not accidentally pass through.
  await page.mouse.move(box.x + box.width * 0.02, box.y + box.height * 0.02);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.98, box.y + box.height * 0.22, { steps: 10 });
  await page.mouse.up();
}

/** The bytes of the most recent export. */
async function lastExport(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const all = (window as unknown as { __sfExported: Record<string, unknown>[] }).__sfExported;
    return all[all.length - 1]!["bytes"] as number[];
  });
}

test.describe("redaction", () => {
  test.beforeEach(async ({ page }) => {
    await stubHost(page, Array.from(secretPdf()));
    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });
  });

  test("the redacted text is not in the exported file", async ({ page }) => {
    // The secret is in the source, or this test proves nothing about the export.
    const source = Array.from(secretPdf());
    expect(
      new TextDecoder().decode(new Uint8Array(source)),
      "the fixture does not contain the string this test is about",
    ).toContain(SECRET);

    await redactTheSecret(page);

    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Export/ }).click();
    await page.getByRole("menuitem", { name: /redacted copy/i }).click();

    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __sfExported: unknown[] }).__sfExported.length),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    const exported = new TextDecoder("latin1").decode(new Uint8Array(await lastExport(page)));

    // The whole feature, in one assertion. If this fails, the black rectangle is a lie.
    expect(
      exported.includes(SECRET),
      "the redacted string is still in the exported bytes - the rectangle covered it rather than " +
        "removing it, which is worse than not redacting at all because somebody will believe it",
    ).toBe(false);

    expect(exported.startsWith("%PDF"), "the export is not a PDF").toBe(true);
  });

  test("a marked-up PDF is refused while redactions exist", async ({ page }) => {
    await redactTheSecret(page);

    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Export/ }).click();
    await page.getByRole("menuitem", { name: /marked-up PDF/i }).click();

    // The engine would happily flatten the redaction rectangles onto a document whose text is
    // untouched, producing a file with solid black boxes over recoverable content — visually
    // identical to a real redaction and believed for exactly that reason.
    await expect(page.locator(".sf-status")).toContainText(/redacted copy/i, { timeout: 30_000 });

    // Refused means refused: nothing reached the host to be written.
    const written = await page.evaluate(
      () => (window as unknown as { __sfExported: unknown[] }).__sfExported.length,
    );
    expect(written, "a believable fake redaction was written to disk").toBe(0);
  });

  test("a page nobody redacted keeps its text", async ({ page }) => {
    await redactTheSecret(page);

    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Export/ }).click();
    await page.getByRole("menuitem", { name: /redacted copy/i }).click();

    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __sfExported: unknown[] }).__sfExported.length),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    const exported = new TextDecoder("latin1").decode(new Uint8Array(await lastExport(page)));

    // Page two was never redacted, so it is copied rather than rasterised and its text survives.
    // Without this, the safe implementation and the lazy one — rasterise everything — are
    // indistinguishable, and the lazy one destroys the searchability of a whole set to hide one
    // number on one sheet.
    expect(
      exported.includes("Nothing sensitive on this page"),
      "an unredacted page lost its text, so the whole document was rasterised to hide one string",
    ).toBe(true);
  });
});
