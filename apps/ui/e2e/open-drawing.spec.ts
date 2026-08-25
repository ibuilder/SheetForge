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

/**
 * A second drawing in the same project.
 *
 * It exists so the quantity comparison has something to compare against. Every import creates its
 * own document, so two drawings in a project are two documents — which is why the comparison asks
 * "which one?" rather than assuming "the previous issue of this".
 */
const EARLIER_REVISION = {
  id: "0192f0c1-0000-7000-8000-0000000000dd",
  sourceDocumentId: "0192f0c1-0000-7000-8000-0000000000ee",
  name: "Rev B — tender",
  revisionLabel: "B",
  pageCount: 1,
  shortHash: "99887766aabb",
  importedAt: "2026-08-19T10:00:00.000Z",
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
  {
    firstRun = false,
    markups = [],
    secondDrawing = false,
  }: { firstRun?: boolean; markups?: unknown[]; secondDrawing?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ({ pdfBytes, revision, earlier, project, returning, seeded, alsoEarlier }) => {
      // Set before any application script runs, which is the only moment early enough: the
      // interface reads this during start-up.
      if (returning) localStorage.setItem("sheetforge.tutorial-offered", "yes");

      const saved: Record<string, unknown>[] = [];
      (window as unknown as { __sfSaved: unknown[] }).__sfSaved = saved;
      (window as unknown as { __sfExported: unknown[] }).__sfExported = [];
      (window as unknown as { __sfCompared: unknown[] }).__sfCompared = [];
      (window as unknown as { __sfRecentOpened: unknown[] }).__sfRecentOpened = [];
      (window as unknown as { __sfDerived: unknown[] }).__sfDerived = [];
      (window as unknown as { __sfSheets: unknown[] }).__sfSheets = [];
      (window as unknown as { __sfViews: unknown[] }).__sfViews = [];

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
            const bytes = [...(args instanceof Uint8Array ? args : new Uint8Array(args))];

            // An assembled document, not an export. The host answers with the revision it filed.
            if (command === "document_derive") {
              (window as unknown as { __sfDerived: unknown[] }).__sfDerived.push({
                name: decodeURIComponent(headers["x-sf-name"] ?? ""),
                origin: decodeURIComponent(headers["x-sf-origin"] ?? ""),
                derivation: decodeURIComponent(headers["x-sf-derivation"] ?? ""),
                bytes,
              });
              return Promise.resolve({
                ...revision,
                id: "0192f0c1-0000-7000-8000-0000000000ff",
                name: decodeURIComponent(headers["x-sf-name"] ?? ""),
                pageCount: 1,
              });
            }

            (window as unknown as { __sfExported: unknown[] }).__sfExported.push({
              suggestedName: decodeURIComponent(headers["x-sf-name"] ?? ""),
              extension: decodeURIComponent(headers["x-sf-extension"] ?? ""),
              bytes,
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
            case "recent_list":
              return Promise.resolve([
                {
                  id: "3a7f1c9e00000001",
                  name: "Riverside Tower",
                  openedAt: "2026-08-23T09:00:00.000Z",
                  available: true,
                },
                {
                  id: "3a7f1c9e00000002",
                  name: "Northgate Depot",
                  openedAt: "2026-08-22T17:00:00.000Z",
                  available: false,
                },
              ]);
            case "document_derive": {
              // Never reached: a raw-bytes call is handled above. Present so a regression that
              // sent this as JSON fails loudly here rather than looking like a missing command.
              throw new Error("document_derive must be sent as raw bytes");
            }
            case "recent_open": {
              (window as unknown as { __sfRecentOpened: unknown[] }).__sfRecentOpened.push(args["id"]);
              return Promise.resolve({ ...project, name: "Riverside Tower" });
            }
            case "pdf_open":
              return Promise.resolve({ project, revision, reopened: false });
            case "tutorial_open":
              return Promise.resolve({
                project: { ...project, name: "SheetForge Tutorial" },
                revision: { ...revision, name: "Tutorial - Riverside Tower", pageCount: 2 },
                reopened: false,
              });
            case "document_list":
              // One drawing unless a test asks for two, which is the ordinary state right after
              // the first import. The open one is first, because `openRecent` opens whichever is.
              return Promise.resolve(alsoEarlier ? [revision, earlier] : [revision]);
            case "takeoff_totals":
              return Promise.resolve({
                lines: [
                  // A cost code carrying a comma and a quotation mark, and two units under one
                  // code — the two things that must stay distinct on screen.
                  { code: 'Blockwork, 4" leaf', unit: "m2", value: 128.5 },
                  { code: "03 30 00", unit: "m3", value: 12 },
                  { code: "03 30 00", unit: "m2", value: 250.25 },
                  { code: null, unit: "m", value: 44 },
                ],
                excluded: { underived: 2, unconfirmed: 1 },
              });
            case "revision_delta":
              (window as unknown as { __sfCompared: unknown[] }).__sfCompared.push({
                before: args["before"],
                after: args["after"],
              });
              return Promise.resolve({
                changes: [
                  {
                    // A comma and a quotation mark in one cost code: the case that shifts the
                    // columns if the file is written naively.
                    code: 'Blockwork, 4" leaf',
                    unit: "m2",
                    before: 100,
                    after: 128.5,
                    difference: 28.5,
                    proportion: 0.285,
                    movement: "changed",
                  },
                  {
                    code: "03 30 00",
                    unit: "m3",
                    before: 12,
                    after: 12,
                    difference: 0,
                    proportion: 0,
                    movement: "held",
                  },
                  {
                    code: null,
                    unit: "m",
                    before: 0,
                    after: 44,
                    difference: 44,
                    proportion: null,
                    movement: "added",
                  },
                ],
                excluded: { underived: 2, unconfirmed: 1 },
              });
            case "document_bytes":
              // The host returns raw bytes, which reach the interface as an ArrayBuffer.
              return Promise.resolve(new Uint8Array(pdfBytes).buffer);
            case "markup_list":
              return Promise.resolve(seeded);
            case "view_list":
              // One saved view, so the restore path runs rather than being skipped as empty.
              return Promise.resolve([
                {
                  name: "Clash at F/4",
                  page: 2,
                  zoom: 2.5,
                  centerX: 120.5,
                  centerY: 340.25,
                  rotation: 0,
                  filter: null,
                },
              ]);
            case "view_replace": {
              (window as unknown as { __sfViews: unknown[] }).__sfViews.push(args["views"]);
              return Promise.resolve((args["views"] as unknown[]).length);
            }
            case "sheet_list":
            case "sheet_at_revision": {
              const wanted = args["revision"] as string | undefined;
              const register = [
                {
                  page: 1,
                  number: "T-101",
                  title: "GETTING STARTED",
                  discipline: null,
                  revision: "A",
                  source: "extracted",
                  documentRevisionId: revision.id,
                },
                {
                  page: 2,
                  number: "A-201",
                  title: "SECOND FLOOR PLAN",
                  discipline: "architectural",
                  revision: "C",
                  source: "confirmed",
                  documentRevisionId: revision.id,
                },
              ];
              // `sheet_list` is given a revision *id*; `sheet_at_revision` a printed letter. The
              // short one is the letter.
              if (command === "sheet_at_revision") {
                return Promise.resolve(
                  register.filter((row) => row.revision === (wanted ?? "").toUpperCase()),
                );
              }
              return Promise.resolve(register);
            }
            case "sheet_record": {
              // The register the engine read off the title blocks. Captured so a test can assert
              // it is sent as a guess rather than as something a person confirmed.
              const rows = args["sheets"] as Record<string, unknown>[];
              (window as unknown as { __sfSheets: unknown[] }).__sfSheets.push(...rows);
              return Promise.resolve(rows.length);
            }
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
    {
      pdfBytes: pdf,
      revision: REVISION,
      earlier: EARLIER_REVISION,
      project: PROJECT,
      returning: !firstRun,
      seeded: markups,
      alsoEarlier: secondDrawing,
    },
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
    // Polled, not sampled once. `toBeVisible` means the element is in the layout, not that pdf.js
    // has finished painting into it — and this test failed exactly that way once the suite got
    // busy enough for the render to lose the race. A single sample of an asynchronous render is a
    // flake waiting for a slower machine, which on CI means a red build that says nothing true.
    let measured = { ratio: 0, area: 0, canvases: 0 };
    await expect
      .poll(
        async () => {
          measured = await page.evaluate(() => {
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
          return measured.ratio;
        },
        {
          timeout: 30_000,
          message:
            "the middle of the tutorial sheet never stopped being blank - the page either failed " +
            "to rasterise, or rendered only its border and title block",
        },
      )
      .toBeGreaterThan(0.005);

    // A thumbnail is a few thousand pixels; the page is hundreds of thousands. Asserting the size
    // of what was measured is what stops this silently going back to reading a postage stamp.
    expect(
      measured.area,
      `measured a canvas of only ${measured.area} px across ${measured.canvases} in the stage - ` +
        "that is a thumbnail, not the page",
    ).toBeGreaterThan(100_000);

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
  // Rendering three full ARCH D sheets — a legend and two pages — at 96 DPI is genuinely slow, and
  // the default 30 seconds is not enough on a loaded machine. Raised rather than made faster: the
  // work is real, and a test that hurries it would be testing something the product does not do.
  test.setTimeout(120_000);

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
    // putting sheet 10 before sheet 2 — and the legend sorts before both, because a recipient
    // opening the archive should meet the key before the drawings.
    expect(names).toEqual(["000-legend.png", "001.png", "002.png"]);
  });
});

/**
 * The issue status, stamped across an export.
 *
 * Issuing a drawing without saying what it is for is a real mistake with real consequences: a
 * marked-up review copy that reaches a subcontractor looking like an issued drawing is how
 * somebody builds the wrong thing. The stamp exists to make that hard, so a test that it is
 * actually *on the pixels* — rather than merely offered in a menu — is the point.
 */
test.describe("stamping an export with its issue status", () => {
  test("puts the status on the sheet and in the filename", async ({ page }) => {
    await stubHost(page, Array.from(testPdf()));
    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    // The status is asked for every time rather than remembered, so the prompt is part of the
    // path under test.
    page.on("dialog", (dialog) => void dialog.accept("NOT FOR CONSTRUCTION"));

    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Export/ }).click();
    await page.getByRole("menuitem", { name: /This sheet as PNG, stamped/ }).click();

    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __sfExported: unknown[] }).__sfExported.length),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    const name = await page.evaluate(() => {
      const all = (window as unknown as { __sfExported: Record<string, unknown>[] }).__sfExported;
      return all[all.length - 1]!["suggestedName"] as string;
    });
    // A file called "A-201 p1 (NOT FOR CONSTRUCTION)" is harder to forward carelessly than one
    // that looks like every other export.
    expect(name).toContain("NOT FOR CONSTRUCTION");

    // And on the sheet itself. The test drawing is black on white, so red is the stamp and
    // nothing else — the same probe that proves an unstamped export has no colour at all.
    expect(
      await saturatedPixels(page, await lastExport(page)),
      "the export carries the status in its name but not on its face, which is the half that " +
        "survives being printed and photographed",
    ).toBeGreaterThan(500);
  });
});

/**
 * The projects opened lately.
 *
 * Closing the application used to mean finding your work again through a folder dialog, which is a
 * poor deal for the thing somebody does every morning.
 *
 * The part worth testing hardest is not that the list appears — it is that a **handle** is what
 * crosses the boundary. The host keeps the paths; if a location ever appeared here, the webview
 * would have been handed a filesystem it is not allowed to have.
 */
test.describe("recent projects", () => {
  test.beforeEach(async ({ page }) => {
    await stubHost(page, Array.from(testPdf()));
    await page.goto("/");
  });

  test("are offered in the Project menu, newest first", async ({ page }) => {
    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Project/ }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Riverside Tower" })).toBeVisible();
  });

  test("a project that has moved is shown and disabled, not hidden", async ({ page }) => {
    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Project/ }).click();
    const moved = page.getByRole("menu").getByRole("menuitem", { name: /Northgate Depot/ });

    // Somebody who cannot find their job wants to be told it has moved, not left wondering whether
    // they imagined it.
    await expect(moved).toBeVisible();
    // The menu marks an unavailable item with the `disabled` attribute, which is what makes it
    // both unclickable and announced as unavailable.
    await expect(moved).toBeDisabled();
  });

  test("opening one sends a handle, and never a location", async ({ page }) => {
    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Project/ }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Riverside Tower" }).click();

    await expect(page.locator("[data-project]")).toContainText("Riverside Tower");

    const sent = await page.evaluate(
      () => (window as unknown as { __sfRecentOpened: string[] }).__sfRecentOpened,
    );
    expect(sent).toEqual(["3a7f1c9e00000001"]);

    // The whole of the security argument, stated as an assertion: nothing that could be a path.
    for (const value of sent) {
      expect(value).not.toMatch(/[/\\]/);
      expect(value).not.toMatch(/\.sfproj/);
    }
  });
});

/**
 * Taking pages out of a set.
 *
 * The behaviour worth pinning is not that an extract appears — it is that the original is left
 * alone and the new document says where it came from. ADR-0010 turns on both: a tool that edits an
 * issue in place makes verification report the user's own work as tampering, and a tool that
 * produces an untraceable document reintroduces the provenance gap the whole project exists to
 * close.
 */
test.describe("extracting pages", () => {
  test("files a new drawing that records what it came from", async ({ page }) => {
    await stubHost(page, Array.from(TUTORIAL_SHEET), { firstRun: true });
    await page.goto("/");
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    page.on("dialog", (dialog) => void dialog.accept("2"));

    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Project/ }).click();
    await page.getByRole("menuitem", { name: /Extract pages/ }).click();

    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __sfDerived: unknown[] }).__sfDerived.length),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    const derived = await page.evaluate(() => {
      const all = (window as unknown as { __sfDerived: Record<string, unknown>[] }).__sfDerived;
      return all[all.length - 1]!;
    });

    // It says what was done and which revision it was cut from. Without both, the project fills up
    // with documents nobody can account for.
    expect(derived["derivation"]).toBe("page-assembly");
    expect(derived["origin"]).toBe(REVISION.id);
    expect(derived["name"]).toContain("pages 2");

    // And it really is a PDF, not a description of one.
    const bytes = derived["bytes"] as number[];
    expect(bytes.slice(0, 4)).toEqual([0x25, 0x50, 0x44, 0x46]);

    // Smaller than the two-page original, because it holds one page.
    expect(bytes.length).toBeLessThan(TUTORIAL_SHEET.length);
  });

  test("a page that is not there is refused before anything is built", async ({ page }) => {
    await stubHost(page, Array.from(TUTORIAL_SHEET), { firstRun: true });
    await page.goto("/");
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    page.on("dialog", (dialog) => void dialog.accept("1-99"));

    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Project/ }).click();
    await page.getByRole("menuitem", { name: /Extract pages/ }).click();

    // Refused with the number of pages there actually are, and nothing filed.
    await expect(page.locator(".sf-status")).toContainText(/2 pages/, { timeout: 15_000 });
    const filed = await page.evaluate(
      () => (window as unknown as { __sfDerived: unknown[] }).__sfDerived.length,
    );
    expect(filed, "a document was built from a selection that named pages that do not exist").toBe(0);
  });
});

/**
 * The register reaching the host.
 *
 * The engine reads title blocks whenever a document opens. Until recently the host adapter dropped
 * the result, so the numbers were re-derived every time and a correction never survived a restart.
 *
 * What matters most here is not that rows arrive — it is *how they are labelled*. They are sent as
 * `extracted`, because a title-block heuristic is a guess, and the store refuses to let a guess
 * overwrite something a person confirmed. Sending a stronger source would defeat that rule from
 * the wrong side of it.
 */
test.describe("the sheet register", () => {
  test("what the engine reads is sent as a guess, never as confirmed", async ({ page }) => {
    await stubHost(page, Array.from(TUTORIAL_SHEET), { firstRun: true });
    await page.goto("/");
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    // The engine extracts asynchronously after the document loads.
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __sfSheets: unknown[] }).__sfSheets.length),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    const rows = await page.evaluate(
      () => (window as unknown as { __sfSheets: Record<string, unknown>[] }).__sfSheets,
    );

    for (const row of rows) {
      expect(
        row["source"],
        "a title-block reading was sent as something a person stood behind, which would let it " +
          "overwrite a correction",
      ).toBe("extracted");
      expect(typeof row["page"]).toBe("number");
    }
  });
});

/**
 * The sheet register on screen.
 *
 * A drawing set is navigated by sheet number, not by page number, and the register is what makes
 * that possible. The part that needs a test rather than a look is the distinction between a number
 * somebody confirmed and one a machine read off a title block — because on a scanned set that
 * second kind is frequently wrong, and it is the reader about to quote a sheet number who most
 * needs to know which they are looking at.
 */
test.describe("the sheet register on screen", () => {
  test.beforeEach(async ({ page }) => {
    await stubHost(page, Array.from(TUTORIAL_SHEET), { firstRun: true });
    await page.goto("/");
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });
  });

  test("lists sheets by number, and says which have not been checked", async ({ page }) => {
    const register = page.locator(".sf-register");
    await expect(register).toBeVisible({ timeout: 15_000 });

    await expect(register.getByRole("button", { name: /T-101/ })).toBeVisible();
    await expect(register.getByRole("button", { name: /A-201/ })).toBeVisible();

    // T-101 came from the title-block heuristic; A-201 was confirmed by a person.
    const unchecked = register.getByRole("button", { name: /T-101/ });
    await expect(unchecked).toHaveAttribute("aria-label", /not confirmed by a person/);

    const confirmed = register.getByRole("button", { name: /A-201/ });
    await expect(confirmed).not.toHaveAttribute("aria-label", /not confirmed/);

    // And it is a word on screen, not a shade of grey. Somebody who cannot tell two greys apart
    // still has to be able to see it.
    await expect(register.getByText("unchecked")).toBeVisible();
  });

  test("jumps to the page a sheet is on", async ({ page }) => {
    await page.locator(".sf-register").getByRole("button", { name: /A-201/ }).click();

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

  test("says when it is showing only part of the set", async ({ page }) => {
    page.on("dialog", (dialog) => void dialog.accept("C"));

    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Project/ }).click();
    await page.getByRole("menuitem", { name: /Find sheets at a revision/ }).click();

    const register = page.locator(".sf-register");
    // A list silently narrowed to a subset is a list somebody reads as the whole set and acts on.
    await expect(register.getByRole("button", { name: /Showing revision C/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(register.getByRole("button", { name: /A-201/ })).toBeVisible();
    await expect(register.getByRole("button", { name: /T-101/ })).toBeHidden();

    // And it can be put back.
    await register.getByRole("button", { name: /show all/ }).click();
    await expect(register.getByRole("button", { name: /T-101/ })).toBeVisible();
  });
});

/**
 * Saved views surviving a restart.
 *
 * Views are the one thing the engine holds that its storage adapter has no channel for — absent
 * from both `LoadResult` and `Mutation` — so they travel over the bus instead. That makes this the
 * most easily broken of the persistence paths and the one least likely to be noticed, because a
 * lost view looks like one nobody saved.
 */
test.describe("saved views", () => {
  test("a stored view is put back when the drawing opens", async ({ page }) => {
    await stubHost(page, Array.from(TUTORIAL_SHEET), { firstRun: true });
    await page.goto("/");
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    // The engine's own Saved views panel lists what it holds. If the restore did not run, this is
    // the empty-state text instead.
    await expect(page.getByText("Clash at F/4")).toBeVisible({ timeout: 20_000 });
  });
});

/**
 * Comparing the quantities on two drawings.
 *
 * This is the answer somebody takes into a variation meeting, so the thing worth testing is not
 * that a file appears — it is that the file is *readable by a spreadsheet without shifting a
 * column*, and that it says what was left out. A comparison that quietly drops the measurements
 * taken at an unconfirmed scale is one somebody prices as complete.
 *
 * The direction matters too. The chosen drawing is the earlier side; getting that backwards would
 * report every increase as a saving, and nothing about the file would look wrong.
 */
test.describe("comparing quantities between two drawings", () => {
  test("writes a CSV that survives a comma, and says what it left out", async ({ page }) => {
    await stubHost(page, Array.from(testPdf()), { secondDrawing: true });
    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    // The other drawing is chosen from a numbered list. One other drawing, so "1".
    page.on("dialog", (dialog) => void dialog.accept("1"));

    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Project/ }).click();
    await page.getByRole("menuitem", { name: /Compare quantities with/ }).click();

    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __sfExported: unknown[] }).__sfExported.length),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    // The earlier drawing is asked for as `before`, the open one as `after`.
    const asked = await page.evaluate(
      () => (window as unknown as { __sfCompared: Record<string, string>[] }).__sfCompared,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!["before"], "the chosen drawing must be the earlier side").toBe(
      "0192f0c1-0000-7000-8000-0000000000dd",
    );
    expect(asked[0]!["after"]).toBe("0192f0c1-0000-7000-8000-0000000000aa");

    const written = await page.evaluate(() => {
      const all = (window as unknown as { __sfExported: Record<string, unknown>[] }).__sfExported;
      const last = all[all.length - 1]!;
      return {
        name: last["suggestedName"] as string,
        extension: last["extension"] as string,
        text: new TextDecoder().decode(new Uint8Array(last["bytes"] as number[])),
        firstBytes: (last["bytes"] as number[]).slice(0, 3),
      };
    });

    expect(written.extension).toBe("csv");
    expect(written.name).toContain("Rev B — tender");

    // The byte-order mark survives the trip to the host as bytes, not just as a string in the
    // interface. Without it Excel on Windows reads the file in the ANSI codepage and every square
    // metre in it arrives mangled — and this is the only test that sees the actual bytes.
    expect(written.firstBytes).toEqual([0xef, 0xbb, 0xbf]);

    const rows = written.text.split("\r\n");
    // The header names both drawings, so a file found on a desktop months later still says what
    // it compared.
    expect(rows[0]).toContain("Rev B — tender");
    expect(rows[0]).toContain("A-201");

    // The cost code carries a comma and a quotation mark. Quoted and doubled, it stays one field;
    // unescaped, every number after it would sit under the wrong heading.
    expect(written.text).toContain('"Blockwork, 4"" leaf"');

    // Seven fields on the awkward row, counted the way a parser would rather than by splitting on
    // every comma.
    const awkward = rows.find((row) => row.startsWith('"Blockwork'))!;
    expect(fieldsOf(awkward)).toEqual([
      'Blockwork, 4" leaf',
      "m2",
      "100",
      "128.5",
      "28.5",
      "28.5",
      "changed",
    ]);

    // The line that did not move is still in the file. A schedule of only the differences cannot
    // be checked: a line that held and a line that was never compared look identical.
    expect(written.text).toContain("held");

    // And an added line with nothing to be a percentage of leaves that cell empty rather than
    // writing "Infinity", which a spreadsheet would happily total.
    expect(written.text).not.toContain("Infinity");
    expect(written.text).not.toContain("NaN");

    // What was left out, at the foot of the file.
    expect(written.text).toContain("2 measurement(s) on pages with no scale");
    expect(written.text).toContain("1 measurement(s) taken at a scale nobody has confirmed");

    // The status line carries the headline, so the outcome is known before the file is opened —
    // including the fact that something was excluded.
    const status = page.locator("[data-status]");
    await expect(status).toContainText("1 changed");
    await expect(status).toContainText("1 added");
    await expect(status).toContainText("3 measurement(s) were left out");
  });

  test("says so rather than offering an empty comparison when there is nothing to compare", async ({
    page,
  }) => {
    // No second drawing: the ordinary state right after the first import.
    await stubHost(page, Array.from(testPdf()));
    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Project/ }).click();
    await page.getByRole("menuitem", { name: /Compare quantities with/ }).click();

    await expect(page.locator("[data-status]")).toContainText("only one drawing");
    // Nothing was written, and nothing was asked of the host.
    expect(
      await page.evaluate(
        () => (window as unknown as { __sfCompared: unknown[] }).__sfCompared.length,
      ),
    ).toBe(0);
  });
});

/**
 * Split a CSV row the way a parser does, honouring quotes.
 *
 * Splitting on every comma is precisely the bug the quoting exists to prevent, so a test that
 * checked the columns that way would pass on a file no spreadsheet could read.
 */
function fieldsOf(row: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < row.length; index += 1) {
    const character = row[index]!;
    if (quoted) {
      if (character !== '"') current += character;
      else if (row[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      fields.push(current);
      current = "";
    } else current += character;
  }
  fields.push(current);
  return fields;
}

/**
 * The running takeoff, on screen rather than in a file.
 *
 * Every other quantity output here is an export, which is the wrong shape for the thing a reviewer
 * builds *while* they measure. The point of the panel is catching the measurement that landed
 * under the wrong cost code at the moment it was made, rather than in a spreadsheet next week.
 *
 * The part worth testing hardest is the exclusion line. A total that quietly dropped three
 * measurements looks entirely reasonable, and somebody prices it as complete.
 */
test.describe("the running takeoff", () => {
  test("totals by cost code and unit, and says what it has not counted", async ({ page }) => {
    await stubHost(page, Array.from(testPdf()));
    await page.goto("/");
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    await expect(page.locator(".sf-stage canvas").first()).toBeVisible({ timeout: 30_000 });

    const takeoff = page.getByRole("table", { name: "Takeoff" });
    await expect(takeoff).toBeVisible();

    // A table, so a screen reader announces each total with the code and unit it belongs to
    // rather than as three loose fragments.
    const rows = takeoff.locator("tbody tr");
    await expect(rows).toHaveCount(4);

    // One code in two units stays two lines. Adding a volume to an area would produce a number
    // with a plausible magnitude sitting under a real cost code — wrong in no way a reader sees.
    const concrete = rows.filter({ hasText: "03 30 00" });
    await expect(concrete).toHaveCount(2);
    await expect(concrete.filter({ hasText: "m3" })).toContainText("12");
    await expect(concrete.filter({ hasText: "m2" })).toContainText("250.25");

    // A quantity with no cost code is named, not blank. A blank cell reads as "nobody filled this
    // in", which is a different problem from "these carry no code".
    await expect(rows.filter({ hasText: "(no cost code)" })).toContainText("44");

    // And the omission, in words. Not a badge, not a colour: the reader who most needs this is
    // the one about to quote the number, and they may not see colour at all.
    const excluded = page.locator(".sf-takeoff-excluded");
    await expect(excluded).toBeVisible();
    await expect(excluded).toContainText("2 on pages with no scale");
    await expect(excluded).toContainText("1 taken at a scale nobody has confirmed");
    await expect(excluded).toContainText("left out rather than counted as zero");
  });
});
