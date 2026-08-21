/**
 * The one path that matters most, driven end to end in a real browser: open a drawing and see it.
 *
 * The Rust side is covered by its own tests, and the mapping layer by unit tests, but neither of
 * those touches the half most likely to break and hardest to reason about — the drawing engine
 * mounting, the bundled pdf.js worker starting, the bytes crossing from the host as an
 * `ArrayBuffer`, and actual ink landing on a canvas. A headless DOM cannot reach any of that.
 *
 * The host is stubbed at exactly one seam: `window.__TAURI_INTERNALS__.invoke`, which is the whole
 * of what `@tauri-apps/api` calls. Everything above it — the bridge, the chrome, the adapter, the
 * engine — is the real code, running the real bundle that ships.
 *
 * What this deliberately does *not* cover is the native file dialog itself, which lives below the
 * stub. That is a plugin call with no logic of ours in it.
 */
import { expect, test, type Page } from "@playwright/test";

/**
 * A small, valid, single-page PDF, built here rather than committed as a fixture.
 *
 * Generated so it can never be mistaken for somebody's drawing — the repository must never contain
 * a real construction document. It draws a border and a line of text, which is enough for the
 * "did anything actually render?" check to mean something: a blank page would pass a test that
 * only asserted a canvas exists.
 */
function testPdf(): Uint8Array {
  const content =
    "BT /F1 24 Tf 72 700 Td (SheetForge test sheet A-201) Tj ET\n" +
    "50 50 512 692 re S\n" +
    "72 640 m 540 640 l S\n";

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
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
  name: "A-201",
  revisionLabel: null,
  pageCount: 1,
  shortHash: "ab12cd34ef56",
  importedAt: "2026-08-20T10:00:00.000Z",
};

const PROJECT = {
  id: "0192f0c1-0000-7000-8000-0000000000cc",
  name: "A-201",
  jobNumber: null,
  sourceCount: 1,
  format: 1,
};

/** Install the host stub before any application script runs. */
async function stubHost(page: Page, pdf: number[]): Promise<void> {
  await page.addInitScript(
    ({ pdfBytes, revision, project }) => {
      const saved: Record<string, unknown>[] = [];
      (window as unknown as { __sfSaved: unknown[] }).__sfSaved = saved;

      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke(command: string, args: Record<string, unknown>) {
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
            case "project_current":
              return Promise.resolve(null);
            case "pdf_open":
              return Promise.resolve({ project, revision, reopened: false });
            case "document_list":
              return Promise.resolve([revision]);
            case "document_bytes":
              // The host returns raw bytes, which reach the interface as an ArrayBuffer.
              return Promise.resolve(new Uint8Array(pdfBytes).buffer);
            case "markup_list":
              return Promise.resolve([]);
            case "calibration_get":
              return Promise.resolve(null);
            case "markup_create": {
              saved.push(args);
              const markup = args["markup"] as Record<string, unknown>;
              return Promise.resolve({
                ...markup,
                id: `markup-${saved.length}`,
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

test.describe("opening a drawing", () => {
  test.beforeEach(async ({ page }) => {
    await stubHost(page, Array.from(testPdf()));
  });

  test("says what to do before anything is open", async ({ page }) => {
    await page.goto("/");
    // The failure this replaces: an empty grey rectangle that told nobody anything.
    await expect(page.getByText("No drawing open")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open PDF…" }).first()).toBeVisible();
  });

  test("opens a drawing and actually renders it", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();

    // The engine mounts a canvas per page. Waiting for it is waiting for pdf.js to have started
    // its worker, parsed the document and rasterised — none of which a DOM stub can fake.
    const canvas = page.locator(".sf-stage canvas").first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // A canvas that exists but is blank is the failure mode worth catching: it is what a broken
    // worker URL, a CSP refusal or a detached buffer all look like.
    const painted = await canvas.evaluate((node: HTMLCanvasElement) => {
      const context = node.getContext("2d");
      if (!context || node.width === 0 || node.height === 0) return 0;
      const { data } = context.getImageData(0, 0, node.width, node.height);
      let nonWhite = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250) nonWhite += 1;
      }
      return nonWhite;
    });
    expect(painted, "the page rasterised to something other than a blank sheet").toBeGreaterThan(100);

    // The chrome caught up with the host: the sheet is listed and named.
    await expect(page.locator(".sf-sheet").filter({ hasText: "A-201" })).toBeVisible();
    await expect(page.getByText("No drawing open")).toBeHidden();

    expect(errors, "no uncaught errors while opening").toEqual([]);
  });

  test("the drawing engine's own toolbar is available once a drawing is open", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    // Proves the engine installed its plugins rather than merely rendering a page: without the
    // toolset, this is a PDF viewer and not a review desk.
    const toolbar = page.locator(".sf-stage").getByRole("toolbar").first();
    await expect(toolbar).toBeVisible();
  });
});
