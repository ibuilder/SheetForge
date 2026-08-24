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
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * The tutorial sheet exactly as it is compiled into the application.
 *
 * Read from the asset rather than regenerated here, because the thing worth testing is the
 * file that ships. A sheet that renders in the generator's own rasteriser and not in the
 * engine would be found by the first user on their first launch, which is the worst possible
 * place to find it.
 */
const TUTORIAL_SHEET = readFileSync(
  new URL("../../desktop/src-tauri/assets/welcome.pdf", import.meta.url),
);

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

/**
 * Install the host stub before any application script runs.
 *
 * This models the whole of `window.__TAURI_INTERNALS__`, not just `invoke`, because the interface
 * uses more than `invoke`: `listen` from `@tauri-apps/api/event` goes through `transformCallback`
 * and a pair of `plugin:event|*` commands. Stubbing only what came to mind first is how a test
 * passes while the real transport is broken — CI caught exactly that.
 *
 * Modelling the event channel also makes host-pushed events testable. A drop has no call to
 * intercept — the host initiates it — so without this there is no way to exercise drag-and-drop at
 * all. `window.__sfEmit(name, payload)` pushes one the way Rust would.
 *
 * By default this presents itself as a **returning** installation: the first-run flag is already
 * set, so the tutorial does not open itself and each test starts on the empty screen it means to
 * exercise. Pass `firstRun: true` to test the opposite.
 */
async function stubHost(
  page: Page,
  pdf: number[],
  { firstRun = false, markups = [] }: { firstRun?: boolean; markups?: unknown[] } = {},
): Promise<void> {
  await page.addInitScript(
    ({ pdfBytes, revision, project, returning, seeded }) => {
      // Set before any application script runs, which is the only moment early enough: the
      // interface reads this during start-up.
      if (returning) localStorage.setItem("sheetforge.tutorial-offered", "yes");

      const saved: Record<string, unknown>[] = [];
      (window as unknown as { __sfSaved: unknown[] }).__sfSaved = saved;
      (window as unknown as { __sfExported: unknown[] }).__sfExported = [];

      // event name -> the callback ids listening for it, mirroring what the Rust side tracks.
      const listeners = new Map<string, number[]>();
      let nextId = 1;

      // Push an event the way the host would. Named on `window` so a test can reach it.
      (window as unknown as { __sfEmit: (name: string, payload: unknown) => void }).__sfEmit = (
        name,
        payload,
      ) => {
        for (const id of listeners.get(name) ?? []) {
          const callback = (window as unknown as Record<string, (arg: unknown) => void>)[`_${id}`];
          callback?.({ event: name, id, payload });
        }
      };

      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        // The real one parks the callback on `window` under a numeric key and hands the number to
        // Rust, which calls back through it. Same contract here.
        transformCallback(callback: (arg: unknown) => void, once = false) {
          const id = nextId++;
          Object.defineProperty(window, `_${id}`, {
            value: (result: unknown) => {
              if (once) Reflect.deleteProperty(window, `_${id}`);
              return callback(result);
            },
            writable: false,
            configurable: true,
          });
          return id;
        },

        invoke(command: string, args: Record<string, unknown>, options?: Record<string, unknown>) {
          // A raw-bytes call: the payload is an ArrayBuffer and the metadata rides in headers,
          // percent-encoded. Modelled faithfully because a stub that accepted the old JSON shape
          // would keep passing after the host stopped accepting it.
          if (args instanceof ArrayBuffer || args instanceof Uint8Array) {
            const headers = (options?.["headers"] ?? {}) as Record<string, string>;
            (window as unknown as { __sfExported: unknown[] }).__sfExported.push({
              suggestedName: decodeURIComponent(headers["x-sf-name"] ?? ""),
              extension: decodeURIComponent(headers["x-sf-extension"] ?? ""),
              bytes: [...(args instanceof Uint8Array ? args : new Uint8Array(args))],
            });
            return Promise.resolve(null);
          }

          if (command === "plugin:event|listen") {
            const name = args["event"] as string;
            const handler = args["handler"] as number;
            listeners.set(name, [...(listeners.get(name) ?? []), handler]);
            return Promise.resolve(handler);
          }
          if (command === "plugin:event|unlisten") {
            const name = args["event"] as string;
            const id = args["eventId"] as number;
            listeners.set(name, (listeners.get(name) ?? []).filter((each) => each !== id));
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
            case "project_current":
              return Promise.resolve(null);
            case "pdf_open":
              return Promise.resolve({ project, revision, reopened: false });
            case "tutorial_open":
              return Promise.resolve({
                project: { ...project, name: "SheetForge Tutorial" },
                revision: { ...revision, name: "Tutorial - Riverside Tower", pageCount: 2 },
                reopened: false,
              });
            case "document_list":
              return Promise.resolve([revision]);
            case "document_bytes":
              // The host returns raw bytes, which reach the interface as an ArrayBuffer.
              return Promise.resolve(new Uint8Array(pdfBytes).buffer);
            case "markup_list":
              return Promise.resolve(seeded);
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
    { pdfBytes: pdf, revision: REVISION, project: PROJECT, returning: !firstRun, seeded: markups },
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

test.describe("getting work back out", () => {
  test.beforeEach(async ({ page }) => {
    await stubHost(page, Array.from(testPdf()));
  });

  test("export is a named menu, not a glyph to hunt for", async ({ page }) => {
    // The complaint this replaces: the export actions existed only as unlabelled icons among about
    // fifty others in the engine's toolbar, which is the same as not existing.
    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    const header = page.getByRole("toolbar", { name: "Project" });
    await header.getByRole("button", { name: /^Export/ }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();

    // Built from the engine's registry, so these are the real actions rather than a static list
    // that can fall out of step with what the engine actually offers.
    await expect(menu.getByRole("menuitem", { name: "marked-up PDF…" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "takeoff (CSV)…" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "XFDF…", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "BCF topics…" })).toBeVisible();
    // Imports live here too, below a separator: they are the same kind of act in the other
    // direction, and a reviewer looking for "bring markups in" looks where they sent them out.
    await expect(menu.getByRole("menuitem", { name: "Import XFDF…" })).toBeVisible();
  });

  test("the menu closes on Escape and returns focus", async ({ page }) => {
    await page.goto("/");
    const trigger = page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Project/ });
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    // Losing focus to the document body after Escape strands a keyboard user.
    await expect(trigger).toBeFocused();
  });

  test("project housekeeping is reachable but not competing for attention", async ({ page }) => {
    await page.goto("/");
    // Three controls in the header, not five: open, export, project.
    const header = page.getByRole("toolbar", { name: "Project" });
    await expect(header.getByRole("button")).toHaveCount(3);

    await header.getByRole("button", { name: /^Project/ }).click();
    const menu = page.getByRole("menu");
    for (const name of [
      /Add drawings/,
      /Open project/,
      /New project/,
      /Check integrity/,
      /Save diagnostic report/,
    ]) {
      await expect(menu.getByRole("menuitem", { name })).toBeVisible();
    }
  });
});

test.describe("drag and drop", () => {
  test.beforeEach(async ({ page }) => {
    await stubHost(page, Array.from(testPdf()));
  });

  test("a dropped drawing opens, without the interface ever seeing a path", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await expect(page.getByText("No drawing open")).toBeVisible();

    // What Rust emits after it has imported the files. Note what is *not* in the payload: any
    // filesystem path. That is the property the whole design turns on — the host handles the drop
    // and reports the outcome, so a compromised renderer learns nothing about the disk.
    await page.evaluate(
      ({ project, revision }) => {
        (window as unknown as { __sfEmit: (n: string, p: unknown) => void }).__sfEmit(
          "sheetforge://dropped",
          { opened: [{ project, revision, reopened: false }] },
        );
      },
      { project: PROJECT, revision: REVISION },
    );

    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".sf-sheet").filter({ hasText: "A-201" })).toBeVisible();
    await expect(page.getByText("No drawing open")).toBeHidden();
    expect(errors, "no uncaught errors while handling a drop").toEqual([]);
  });

  test("a refused drop is reported rather than swallowed", async ({ page }) => {
    await page.goto("/");

    await page.evaluate(() => {
      (window as unknown as { __sfEmit: (n: string, p: unknown) => void }).__sfEmit(
        "sheetforge://dropped",
        {
          error: {
            code: "too-large",
            message: "this file is 900 MB, over the 512 MB limit for a drawing",
            retryable: false,
          },
        },
      );
    });

    // A drop that fails silently is worse than one that errors: the user watched a file land on
    // the window and has no idea why nothing happened.
    await expect(page.locator(".sf-status")).toContainText("over the 512 MB limit");
    await expect(page.getByText("No drawing open")).toBeVisible();
  });

  test("a cancelled drop says nothing", async ({ page }) => {
    await page.goto("/");
    await page.locator(".sf-status").waitFor();
    const before = await page.locator(".sf-status").textContent();

    await page.evaluate(() => {
      (window as unknown as { __sfEmit: (n: string, p: unknown) => void }).__sfEmit(
        "sheetforge://dropped",
        { error: { code: "cancelled", message: "Cancelled.", retryable: false } },
      );
    });

    // Cancelling is a normal act, not a failure worth a message.
    await expect(page.locator(".sf-status")).toHaveText(before ?? "");
  });
});

/**
 * The first minute.
 *
 * A review tool that opens on an empty screen and asks for a PDF makes trying it conditional on
 * already having a drawing to hand. So the application ships one — but showing it on *every*
 * launch would be an imposition, and creating a project folder behind somebody's back every time
 * they open the application would be worse. Once, then on request, is the bargain, and both halves
 * of it are asserted here because getting either wrong is annoying in a way nobody reports.
 */
test.describe("the tutorial sheet", () => {
  test("opens itself on a genuinely first run", async ({ page }) => {
    await stubHost(page, Array.from(testPdf()), { firstRun: true });
    await page.goto("/");

    await expect(page.locator("[data-project]")).toContainText("SheetForge Tutorial");
    await expect(page.locator(".sf-status")).toContainText("calibrate against");
    // Not the empty screen: the point is that a new user has something to work on immediately.
    await expect(page.getByText("No drawing open")).toBeHidden();
  });

  test("does not open itself again on the next run", async ({ page }) => {
    await stubHost(page, Array.from(testPdf()), { firstRun: true });
    await page.goto("/");
    await expect(page.locator("[data-project]")).toContainText("SheetForge Tutorial");

    // Same browser context, so the flag written on the first visit is still there — which is the
    // whole mechanism under test.
    await page.goto("/");
    await expect(page.getByText("No drawing open")).toBeVisible();
  });

  test("can still be asked for from the Project menu", async ({ page }) => {
    await stubHost(page, Array.from(testPdf()));
    await page.goto("/");
    await expect(page.getByText("No drawing open")).toBeVisible();

    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Open the tutorial sheet" }).click();

    await expect(page.locator("[data-project]")).toContainText("SheetForge Tutorial");
  });

  test("the sheet that actually ships renders in the real engine", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    // Fixed here rather than inherited from the runner. An ARCH D sheet fitted to a short viewport
    // rasterises with most of its line work below one pixel wide, so how much ink lands on the
    // canvas depends on the window the test happened to get. Pinning the viewport makes the
    // measurement below mean the same thing on every machine.
    await page.setViewportSize({ width: 1600, height: 1200 });

    await stubHost(page, Array.from(TUTORIAL_SHEET), { firstRun: true });
    await page.goto("/");

    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    // Measured on the **largest** canvas in the stage, not the first one.
    //
    // The stage holds more than one: the page itself and the thumbnails beside it. `.first()` was
    // picking a thumbnail — about 130 by 88 pixels — so a check written to prove the sheet
    // rasterises was reading a postage stamp. It passed, which is the problem: it would have gone
    // on passing if the page canvas had never drawn at all.
    //
    // Only the middle of the sheet is counted, and the result is a proportion rather than a pixel
    // count. Both parts matter:
    //
    // - **The middle**, because a sheet that drew nothing but its border and title block would
    //   sail past a whole-canvas check. The border alone is a good fraction of the ink on a
    //   mostly-white drawing, so a whole-canvas threshold high enough to mean anything is also
    //   high enough to pass on that failure.
    // - **A proportion**, because an absolute count tuned on a developer's screen fails on a CI
    //   runner rendering the same page smaller. That is what this test did on its first run:
    //   3,905 painted pixels against a threshold of 5,000, on a sheet that had rendered perfectly
    //   well. The viewport is pinned above for the same reason.
    const inked = await page.evaluate(() => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".sf-stage canvas")];
      const node = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      const context = node?.getContext("2d");
      if (!node || !context || node.width === 0 || node.height === 0) {
        return { ratio: 0, area: 0, canvases: canvases.length };
      }

      const x = Math.floor(node.width * 0.2);
      const y = Math.floor(node.height * 0.2);
      const w = Math.floor(node.width * 0.6);
      const h = Math.floor(node.height * 0.6);
      const { data } = context.getImageData(x, y, w, h);

      let nonWhite = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250) nonWhite += 1;
      }
      return { ratio: nonWhite / (w * h), area: w * h, canvases: canvases.length };
    });

    // A thumbnail is a few thousand pixels; the page is hundreds of thousands. Asserting the size
    // of what was measured is what stops this silently going back to reading a postage stamp.
    expect(
      inked.area,
      `measured a canvas of only ${inked.area} px across ${inked.canvases} in the stage - that is ` +
        "a thumbnail, not the page",
    ).toBeGreaterThan(100_000);

    expect(
      inked.ratio,
      "the middle of the tutorial sheet is blank - the page either failed to rasterise, or " +
        "rendered only its border and title block",
    ).toBeGreaterThan(0.005);

    expect(errors, "no uncaught errors while opening the tutorial").toEqual([]);
  });

  test("is offered on the empty screen too", async ({ page }) => {
    await stubHost(page, Array.from(testPdf()));
    await page.goto("/");

    await page.getByRole("button", { name: "Try the tutorial sheet" }).click();
    await expect(page.locator("[data-project]")).toContainText("SheetForge Tutorial");
  });
});


/**
 * One sheet, as a picture.
 *
 * The failure worth catching is not "the button did nothing" — that is loud. It is an image that
 * exports the drawing and silently drops the markups on it, because somebody would send a clean
 * sheet believing they had sent their comments and nothing downstream would contradict them.
 *
 * So the test drives the real path — menu, render, host call — and then decodes the PNG the host
 * was handed and looks for the colour of the markup. The test drawing is drawn in black only, so
 * a saturated pixel in the output can have come from nowhere else.
 */
test.describe("exporting a sheet as an image", () => {
  test.beforeEach(async ({ page }) => {
    await stubHost(page, Array.from(testPdf()));
    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });
  });

  test("hands the host a real PNG of the page, at the resolution asked for", async ({ page }) => {
    await exportSheet(page);

    const extension = await page.evaluate(() => {
      const all = (window as unknown as { __sfExported: Record<string, unknown>[] }).__sfExported;
      return all[all.length - 1]!["extension"];
    });
    expect(extension).toBe("png");
    const bytes = await lastExport(page);

    // The PNG signature, then the IHDR width and height as big-endian 32-bit integers. Checking
    // the header rather than just the length is what distinguishes a real image from a blob of
    // something the encoder gave up on.
    expect(bytes.slice(0, 8)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const be32 = (at: number) =>
      (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;

    // The test page is 612 by 792 points. At 96 DPI that is 72/96 of a point per pixel.
    expect(be32(16)).toBe(Math.round(612 * (96 / 72)));
    expect(be32(20)).toBe(Math.round(792 * (96 / 72)));
  });

  test("an unmarked sheet exports with no colour on it", async ({ page }) => {
    // The control for the test below. The generated test drawing is black on white, so any
    // saturated pixel in an export of it has to have come from a markup.
    await exportSheet(page);
    expect(await saturatedPixels(page, await lastExport(page))).toBe(0);
  });
});

/**
 * A markup the host already holds, in the shape `markup_list` returns it.
 *
 * The engine's annotation travels verbatim inside `geometry` — that is the whole point of the
 * mapping layer — so this is a real annotation the store accepts and the renderer draws.
 *
 * Seeded through the host rather than drawn with the mouse. Driving the engine's gesture loop from
 * a test armed the wrong control (three buttons match /cloud/i, and the first is a compare action)
 * and then dragged across a thumbnail; both times the failure looked like a broken exporter. This
 * arrives the way a reopened project's markups do, through the same mapping into the same store
 * the exporter reads.
 *
 * The field is `points`, not `pts`, and `sheetId` is not optional. An earlier version of this
 * helper got both wrong, so the annotation had no geometry at all and rendered as nothing — which
 * again looked like a broken exporter. The type is the authority here, not memory.
 */
function seededCloud(): Record<string, unknown> {
  const annotation = {
    id: "0192f0c1-0000-7000-8000-0000000000d1",
    kind: "cloud",
    sheetId: REVISION.id,
    page: 1,
    points: [
      { x: 120, y: 200 },
      { x: 460, y: 200 },
      { x: 460, y: 430 },
      { x: 120, y: 430 },
    ],
    // An explicit colour rather than one inherited from the discipline, because what the image
    // test asserts is that *this colour* reaches the exported PNG.
    style: { color: "#e07a1f", width: 3 },
    status: "open",
    author: "a.reviewer@example.com",
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    version: 1,
  };
  return {
    id: annotation.id,
    sourceDocumentId: REVISION.sourceDocumentId,
    documentRevisionId: REVISION.id,
    page: 1,
    kind: "cloud",
    geometrySchema: 1,
    geometry: annotation,
    metadata: {},
    quantity: null,
    status: "open",
    version: 1,
    createdBy: "a.reviewer@example.com",
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  };
}

test.describe("exporting a sheet that has been marked up", () => {
  test("the markups are on the picture, not just on the screen", async ({ page }) => {
    await stubHost(page, Array.from(testPdf()), { markups: [seededCloud()] });
    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    // On screen first. Without this the assertion below cannot tell "the exporter dropped the
    // overlay" from "the markup never arrived", and those want opposite fixes. It is the check
    // that finally distinguished them.
    await expect(page.locator(".sf-stage [data-annot]").first()).toBeAttached({ timeout: 15_000 });

    await exportSheet(page);

    expect(
      await saturatedPixels(page, await lastExport(page)),
      "the markup is on screen but not in the exported picture - the overlay was dropped, so " +
        "somebody would send a clean sheet believing they had sent their comments",
    ).toBeGreaterThan(200);
  });
});

/** Drive the export menu, and wait for the bytes to reach the host stub. */
async function exportSheet(page: Page): Promise<void> {
  const before = await page.evaluate(
    () => (window as unknown as { __sfExported: unknown[] }).__sfExported.length,
  );
  await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Export/ }).click();
  await page.getByRole("menuitem", { name: /This sheet as PNG - screen/ }).click();
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __sfExported: unknown[] }).__sfExported.length),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(before);
}

/** The bytes of the most recent export. */
async function lastExport(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const all = (window as unknown as { __sfExported: Record<string, unknown>[] }).__sfExported;
    return all[all.length - 1]!["bytes"] as number[];
  });
}

/**
 * How many pixels of a PNG carry a saturated colour.
 *
 * Decoded in the page rather than in Node, because the browser already has a PNG decoder and
 * adding one to the test suite to check a picture would be a dependency bought for a single
 * assertion. "Saturated" means the channels disagree by a wide margin — which black, white and
 * every grey of an antialiased line drawing do not.
 */
async function saturatedPixels(page: Page, bytes: number[]): Promise<number> {
  return page.evaluate(async (data) => {
    const blob = new Blob([new Uint8Array(data)], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;

    let saturated = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]!;
      const g = pixels[i + 1]!;
      const b = pixels[i + 2]!;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) saturated += 1;
    }
    return saturated;
  }, bytes);
}


/**
 * The drawing's own table of contents.
 *
 * A construction set exported from Revit or Bluebeam carries an outline — disciplines at the top,
 * sheets under them — and until recently this application parsed it and threw it away, leaving a
 * reviewer to scroll two hundred sheets looking for the mechanical drawings on a set that already
 * knew where they were.
 *
 * Driven against the tutorial sheet because it is the one document in this repository that
 * genuinely has an outline, which also means this test fails if the generator ever stops emitting
 * one.
 */
test.describe("the drawing's own contents", () => {
  test("are listed, and jump to the page they name", async ({ page }) => {
    await stubHost(page, Array.from(TUTORIAL_SHEET), { firstRun: true });
    await page.goto("/");
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    const contents = page.getByRole("navigation", { name: "Drawings" }).locator(".sf-outline");
    await expect(contents).toBeVisible({ timeout: 15_000 });

    // Named as the sheet names them, not as "Bookmark 1".
    const practice = contents.getByRole("button", { name: /A-201 Practice sheet/ });
    await expect(practice).toBeVisible();
    await expect(contents.getByRole("button", { name: /T-101 Getting started/ })).toBeVisible();

    // The page number is part of the accessible name, so somebody using a screen reader is told
    // where a link goes rather than having to follow it to find out.
    await expect(practice).toHaveAttribute("aria-label", "A-201 Practice sheet, page 2");

    await practice.click();

    // The engine reports the current page in its own toolbar. Polled rather than asserted once:
    // the jump scrolls, and scrolling is not instantaneous.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const field = document.querySelector<HTMLInputElement>(
              ".sf-stage input[type='number'], .sf-stage input[aria-label*='age' i]",
            );
            return field ? Number(field.value) : 0;
          }),
        { timeout: 15_000 },
      )
      .toBe(2);
  });

  test("a drawing with no outline shows no empty panel", async ({ page }) => {
    // The generated test drawing has no bookmarks. An empty "In this drawing" heading would be
    // furniture that says nothing, and a reviewer would reasonably read it as "this set has no
    // structure" rather than "this file carries none".
    await stubHost(page, Array.from(testPdf()));
    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    await expect(page.locator(".sf-outline")).toBeHidden();
  });
});

/**
 * Every sheet, as one archive.
 *
 * One save dialog rather than one per sheet. The alternative was a folder picker, which would mean
 * a directory handle held across calls and a second place for "no path crosses the boundary" to be
 * got wrong; a single file through the export path that already exists is the same result with
 * none of that.
 *
 * Driven against the tutorial sheet because it is the only two-page document here, and a bulk
 * export whose test only ever saw one page would not be testing the bulk part.
 */
test.describe("exporting every sheet", () => {
  test("produces a ZIP with one entry per sheet", async ({ page }) => {
    await stubHost(page, Array.from(TUTORIAL_SHEET), { firstRun: true });
    await page.goto("/");
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Export/ }).click();
    await page.getByRole("menuitem", { name: /Every sheet as PNG \(ZIP\) - screen/ }).click();

    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __sfExported: unknown[] }).__sfExported.length),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    const archive = await lastExport(page);

    // The local file header signature, then the entry names read out of the archive. Checking the
    // structure rather than the length is what tells a real ZIP from a buffer of something.
    expect(archive.slice(0, 4)).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const names = await page.evaluate((bytes) => {
      const data = new Uint8Array(bytes);
      const found: string[] = [];
      for (let i = 0; i + 30 < data.length; i += 1) {
        // "PK\x03\x04" — the start of each stored entry.
        if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x03 && data[i + 3] === 0x04) {
          const nameLength = data[i + 26]! | (data[i + 27]! << 8);
          found.push(new TextDecoder().decode(data.subarray(i + 30, i + 30 + nameLength)));
        }
      }
      return found;
    }, archive);

    // Zero-padded, so an archive of a 200-sheet set sorts the way the set is ordered rather than
    // putting sheet 10 before sheet 2.
    expect(names).toEqual(["001.png", "002.png"]);
  });
});
