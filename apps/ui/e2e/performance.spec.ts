/**
 * What a reviewer waits on, measured: opening a 200-sheet set, the first sheet appearing, jumping
 * deep into the set, zooming in, and how much memory it takes to do so.
 *
 * ## What the numbers are, and are not
 *
 * The set is synthetic — two hundred ARCH D sheets, each carrying a structural grid, a few thousand
 * wall segments, a hundred and twenty room labels and its own title block. That is dense for a
 * generated drawing and light for a real one: a CAD-exported floor plan can carry tens of thousands
 * of paths, hatching and embedded images. So these figures are a floor. They say the application is
 * not slow on its own account; they cannot say it is fast on your drawings.
 *
 * Every sheet shares one drawing stream (the PDF format allows it, and it keeps the file small
 * enough to hand to the test page) and has its own title block, so each page still parses and
 * paints its full content.
 *
 * ## What measuring found
 *
 * The first run put a jump at ~3 s and a zoom at ~3.9 s, against 0.4 s to open. The cause was the
 * engine's sheet panel: it rebuilds its whole thumbnail list once per sheet while reading title
 * blocks after opening, and its lazy loader drew every thumbnail on every rebuild because the list
 * it observes never scrolled — about 40,000 thumbnail draws over two minutes, with everything else
 * queued behind them. Bounding the list's height (styles.css) makes the loader lazy again: about
 * 2,000 draws, finished in seconds, and a jump in tens of milliseconds. The thumbnail count below
 * is the guard against that coming back.
 *
 * ## Why the ceilings are loose
 *
 * The same reason as the store's scale test: shared CI hardware varies by several times between
 * runs, and a tight budget that fails for no reason trains everybody to ignore it. These catch an
 * order-of-magnitude regression. The measured figures are printed on every run and attached to the
 * report, so a trend is visible without the test having to fail to show it.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const SHEETS = 200;
/** ARCH D, in points: 36 x 24 inches. */
const WIDTH = 2592;
const HEIGHT = 1728;

/** Deterministic, so every run draws the same sheet and a change in time is a change in code. */
function random(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

/** The drawing every sheet shares: a grid, a few thousand wall segments, room labels. */
function drawing(): string {
  const rand = random(7);
  const ops: string[] = ["0.4 w"];
  for (let x = 100; x <= 2400; x += 60) ops.push(`${x} 100 m ${x} 1600 l`);
  for (let y = 100; y <= 1600; y += 60) ops.push(`100 ${y} m 2400 ${y} l`);
  ops.push("S", "1.2 w");
  for (let i = 0; i < 3_000; i += 1) {
    const x = 120 + rand() * 2260;
    const y = 120 + rand() * 1460;
    ops.push(`${x.toFixed(1)} ${y.toFixed(1)} m ${(x + rand() * 80).toFixed(1)} ${(y + rand() * 80).toFixed(1)} l`);
  }
  ops.push("S", "BT /F1 9 Tf");
  for (let i = 0; i < 120; i += 1) {
    ops.push(`1 0 0 1 ${(140 + rand() * 2200).toFixed(1)} ${(140 + rand() * 1400).toFixed(1)} Tm (ROOM ${i + 1}) Tj`);
  }
  ops.push("ET");
  return ops.join("\n");
}

/** A 200-sheet set, each sheet titled with its own number. */
function largeSet(): Uint8Array {
  const shared = drawing();
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);

  const firstPage = 5;
  const kids = Array.from({ length: SHEETS }, (_, i) => `${firstPage + i * 2} 0 R`).join(" ");
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${kids}] /Count ${SHEETS} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add(`<< /Length ${shared.length} >>\nstream\n${shared}\nendstream`);
  for (let i = 0; i < SHEETS; i += 1) {
    const title = `BT /F1 28 Tf 2280 50 Td (A-${String(i + 1).padStart(3, "0")}) Tj ET`;
    const own = firstPage + i * 2 + 1;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents [4 0 R ${own} 0 R] >>`,
    );
    add(`<< /Length ${title.length} >>\nstream\n${title}\nendstream`);
  }

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
  name: "Riverside Tower — full set",
  revisionLabel: null,
  pageCount: SHEETS,
  shortHash: "ab12cd34ef56",
  importedAt: "2026-08-20T10:00:00.000Z",
};

const PROJECT = {
  id: "0192f0c1-0000-7000-8000-0000000000cc",
  name: "Riverside Tower",
  jobNumber: null,
  createdAt: "2026-08-20T10:00:00.000Z",
};

async function stubHost(page: Page, pdf: number[]): Promise<void> {
  await page.addInitScript(
    ({ pdfBytes, revision, project }) => {
      localStorage.setItem("sheetforge.tutorial-offered", "yes");
      // Measurement, not updating: keep the one network request out of the timings.
      localStorage.setItem("sheetforge.update-check", "off");
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke(command: string, args: Record<string, unknown>) {
          switch (command) {
            case "app_info":
              return Promise.resolve({
                version: "0.1.1-test",
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
            case "pdf_open":
              return Promise.resolve({ project, revision, reopened: false });
            case "document_list":
              return Promise.resolve([revision]);
            case "document_bytes":
              return Promise.resolve(new Uint8Array(pdfBytes).buffer);
            case "takeoff_totals":
              return Promise.resolve({ lines: [], excluded: { underived: 0, unconfirmed: 0 } });
            // Answered as the real host does — a count — so nothing here can make the engine retry.
            case "sheet_record":
              return Promise.resolve(((args?.["sheets"] as unknown[]) ?? []).length);
            case "markup_list":
            case "recent_list":
            case "view_list":
            case "sheet_list":
              return Promise.resolve([]);
            default:
              return Promise.resolve(null);
          }
        },
      };
    },
    { pdfBytes: pdf, revision: REVISION, project: PROJECT },
  );
}

interface Mark {
  name: string;
  t: number;
}

const marks = (page: Page) =>
  page.evaluate(() =>
    performance
      .getEntriesByType("mark")
      .filter((entry) => entry.name.startsWith("sf:"))
      .map((entry) => ({ name: entry.name.slice(3), t: entry.startTime })),
  );

/** The paints of one page after a moment, with the scale each was painted at. */
function paintsOf(all: Mark[], pageNumber: number, after = 0): { t: number; scale: number }[] {
  return all
    .filter((m) => m.name.startsWith(`rendered:${pageNumber}@`) && m.t > after)
    .map((m) => ({ t: m.t, scale: Number(m.name.split("@")[1]) }));
}

/**
 * JavaScript heap still *retained*, after the browser has been asked to collect garbage.
 *
 * Measured through the DevTools protocol rather than `performance.memory`, which Chrome quantises
 * into coarse buckets on purpose. Collecting first means a leak shows as growth that survives a
 * collection, instead of being hidden by, or confused with, garbage not yet swept.
 */
async function retainedHeapMb(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  await cdp.detach();
  const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  return Math.round(used / (1024 * 1024));
}

/**
 * Canvases the main view holds. Deliberately not every canvas on the page: the sheet panel keeps a
 * thumbnail per sheet, which is by design, and counting those made an early version of this test
 * report two hundred thumbnails as a leak.
 */
const pageTiles = (page: Page) =>
  page.locator(".sf-stage canvas.mpdf-tile, .sf-stage .mpdf-tile canvas").count();

/**
 * Counters for the sheet panel, installed before the application loads.
 *
 * `rebuilds` counts the panel emptying and refilling its whole list; `thumbnails` counts thumbnail
 * draws, recognised by the white fill each one starts with on a canvas the panel's default width.
 * Both lean on how the engine happens to work today — a refactor there could make them read zero,
 * which the assertions treat as suspicious rather than as a pass.
 */
async function countSheetPanel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __sfRebuilds: number; __sfThumbnails: number };
    w.__sfRebuilds = 0;
    w.__sfThumbnails = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        const cards = [...record.removedNodes].filter((n) =>
          (n as Element).classList?.contains("mpdf-sheet-card"),
        );
        if (cards.length > 50) w.__sfRebuilds += 1;
      }
    }).observe(document, { childList: true, subtree: true });
    // Taken off the prototype to be wrapped, and only ever called back through `.apply` with the
    // canvas it belongs to — the one case the unbound-method rule cannot see is safe.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const fillRect = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (
      this: CanvasRenderingContext2D,
      ...args: Parameters<typeof fillRect>
    ) {
      if (this.canvas.width === 132 && args[0] === 0 && args[1] === 0) w.__sfThumbnails += 1;
      return fillRect.apply(this, args);
    };
  });
}

const sheetPanel = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __sfRebuilds: number; __sfThumbnails: number };
    return { rebuilds: w.__sfRebuilds, thumbnails: w.__sfThumbnails };
  });

/** Wait for a paint of `pageNumber` after `after`, optionally above a scale; return its time. */
async function paintedAt(page: Page, pageNumber: number, after: number, aboveScale = 0): Promise<number> {
  let found: { t: number; scale: number } | undefined;
  await expect
    .poll(
      async () => {
        found = paintsOf(await marks(page), pageNumber, after).find((p) => p.scale > aboveScale);
        return found !== undefined;
      },
      { timeout: 60_000, intervals: [50, 100, 250] },
    )
    .toBe(true);
  return found!.t;
}

const now = (page: Page) => page.evaluate(() => performance.now());

/**
 * Ceilings, in the store scale test's spirit: far enough above what a developer machine measures
 * that shared CI hardware passes comfortably, and far enough below the failure each one guards
 * against that it cannot slip through.
 */
const CEILING = {
  /** Asking to open the set, to the first sheet on screen. */
  firstSheetMs: 10_000,
  /** Jumping to another sheet once the set has settled. Was ~3,000 ms under the thumbnail storm. */
  jumpMs: 1_500,
  /** Zooming in, to the sheet repainted sharper. Was ~3,900 ms under the thumbnail storm. */
  zoomMs: 1_500,
  /**
   * Thumbnail draws while the engine reads every title block after opening. A count, so machine
   * speed cannot move it: about 2,000 when only visible thumbnails are drawn, about 40,000 when the
   * whole list is redrawn once per sheet — the regression this exists to catch.
   */
  thumbnailDraws: 8_000,
  /** Retained heap growth after paging across forty sheets. */
  heapGrowthMb: 200,
  /** Main-view canvases gained over that tour. Two are on screen at a time; more is a leak. */
  tileGrowth: 10,
};

test.describe("performance on a 200-sheet set", () => {
  // Measurement is sequential by nature; parallel runs would time each other.
  test.describe.configure({ mode: "serial" });

  test("opening, jumping, zooming and paging stay within their ceilings", async ({ page }, testInfo: TestInfo) => {
    test.setTimeout(300_000);
    // A fixed window, so the fit-to-page scale — and so the work per paint — is the same every run.
    await page.setViewportSize({ width: 1440, height: 900 });
    await countSheetPanel(page);
    await stubHost(page, Array.from(largeSet()));
    await page.goto("/");

    // Opening.
    await page.getByRole("button", { name: "Open PDF…" }).first().click();
    const opened = await paintedAt(page, 1, 0);
    const all = await marks(page);
    const open = all.find((m) => m.name === "open")!.t;
    const firstSheetMs = opened - open;
    const parseMs = all.find((m) => m.name === "doc-loaded")!.t - open;

    // The engine now reads every sheet's title block. Wait for it to finish, so what follows
    // measures the settled application rather than whatever that pass is costing.
    await expect
      .poll(async () => (await sheetPanel(page)).rebuilds, { timeout: 180_000, intervals: [500] })
      .toBeGreaterThanOrEqual(SHEETS);
    const titleBlocksReadMs = (await now(page)) - open;
    const { thumbnails: thumbnailDraws } = await sheetPanel(page);
    const heapAfterOpen = await retainedHeapMb(page);
    const tilesAfterOpen = await pageTiles(page);

    // Jumping deep into the set, the way a reviewer does: by typing the sheet number.
    const pageBox = page.getByRole("spinbutton", { name: "Page number" });
    const beforeJump = await now(page);
    await pageBox.fill("150");
    await pageBox.press("Enter");
    const jumpMs = (await paintedAt(page, 150, beforeJump)) - beforeJump;

    // Zooming in: the sheet must repaint at a higher scale, not merely be stretched.
    const scaleBefore = Math.max(...paintsOf(await marks(page), 150).map((p) => p.scale));
    const beforeZoom = await now(page);
    await page.getByRole("button", { name: "Zoom in" }).first().click();
    const zoomMs = (await paintedAt(page, 150, beforeZoom, scaleBefore)) - beforeZoom;

    // Paging across the set — forty sheets from one end to the other — then measuring what stayed.
    for (let sheet = 5; sheet <= SHEETS; sheet += 5) {
      const before = await now(page);
      await pageBox.fill(String(sheet));
      await pageBox.press("Enter");
      await paintedAt(page, sheet, before);
    }
    const heapAfterTour = await retainedHeapMb(page);
    const tilesAfterTour = await pageTiles(page);

    const figures = {
      sheets: SHEETS,
      parseMs: Math.round(parseMs),
      firstSheetMs: Math.round(firstSheetMs),
      titleBlocksReadMs: Math.round(titleBlocksReadMs),
      thumbnailDraws,
      jumpMs: Math.round(jumpMs),
      zoomMs: Math.round(zoomMs),
      heapAfterOpenMb: heapAfterOpen,
      heapAfterFortySheetsMb: heapAfterTour,
      tilesAfterOpen,
      tilesAfterFortySheets: tilesAfterTour,
    };
    // Printed and attached on every run, pass or fail: the trend matters more than the verdict.
    console.log(JSON.stringify(figures, null, 2));
    await testInfo.attach("performance.json", {
      body: JSON.stringify(figures, null, 2),
      contentType: "application/json",
    });

    // A counter reading zero means the probe stopped seeing the engine, not that the engine got
    // faster. Refuse to pass on that.
    expect(thumbnailDraws, "no thumbnail draws were seen — the probe no longer recognises them").toBeGreaterThan(0);
    expect(tilesAfterOpen, "no page tiles were found — the selector no longer matches").toBeGreaterThan(0);

    expect(firstSheetMs, "opening the set to the first sheet on screen").toBeLessThan(CEILING.firstSheetMs);
    expect(
      thumbnailDraws,
      "the sheet panel redrew far more thumbnails than are on screen while title blocks were read — " +
        "the whole list is being redrawn per sheet again (see the note on .mpdf-sheet-list in styles.css)",
    ).toBeLessThan(CEILING.thumbnailDraws);
    expect(jumpMs, "jumping to sheet 150").toBeLessThan(CEILING.jumpMs);
    expect(zoomMs, "repainting after zooming in").toBeLessThan(CEILING.zoomMs);
    expect(
      heapAfterTour - heapAfterOpen,
      "retained heap grew by this much after paging across forty sheets — something is keeping " +
        "sheets alive after they leave the screen",
    ).toBeLessThan(CEILING.heapGrowthMb);
    expect(tilesAfterTour - tilesAfterOpen, "main-view canvases accumulated while paging").toBeLessThan(
      CEILING.tileGrowth,
    );
  });
});
