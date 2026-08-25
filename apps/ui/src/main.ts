/**
 * The application.
 *
 * Composition only: it wires the drawing engine to the host adapter, puts the project chrome
 * around it, and gets out of the way. No markup rule, no measurement arithmetic and no persistence
 * decision lives here — those are in the engine and in the Rust crates respectively, which is what
 * lets both be tested without a window.
 */

import {
  attachmentsPlugin,
  createViewer,
  type AnnotFilter,
  type Viewer,
} from "@massingcloud/pdf-viewer";
import "@massingcloud/pdf-viewer/style.css";
// Bundled, never fetched from a CDN. The application has to work with the network off, and a
// worker that 404s at the moment somebody opens a drawing on a site with no signal is the exact
// failure this product exists to avoid.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { HostAdapter } from "./adapter";
import type { AppInfo, RevisionSummary } from "./bridge";
import { errorMessage, hasHost, host, isCommandError, onDropped } from "./bridge";
import type { RecentProject } from "./bridge";
import { mountChrome, type Chrome, type MenuItem } from "./chrome";
import { applyIcons } from "./icons";
import { ocrOptions } from "./ocr";
import { asBlobPart } from "./bytes";
import { extractPages, parsePageSelection } from "./assemble";
import { asPdfBlob, isRedaction, redactionPlugin } from "./redact";
import { describe as describeCheck, scaleCheckPlugin } from "./scale-check";
import { RESOLUTIONS, sheetAsPng, sheetsAsZip } from "./sheet-image";
import { summaryPlugin } from "./summary";
import "./styles.css";

interface Session {
  viewer: Viewer;
  revision: RevisionSummary;
  /** Stops the icon observer. Called before the viewer is destroyed, or it outlives its DOM. */
  stopIcons: () => void;
}

let session: Session | undefined;

/**
 * The projects opened lately, refreshed whenever one is opened.
 *
 * Held here rather than fetched when the menu opens, because a menu that has to await a round trip
 * before it can render is a menu that flickers. It is refreshed after every act that changes it,
 * which is the small number of places a project is opened or created.
 */
let recent: RecentProject[] = [];


async function start(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("the application root element is missing from index.html");

  const info = hasHost() ? await host.appInfo() : undefined;
  const chrome = mountChrome(root, {
    info,
    // `guard` reports its own failures, so these are deliberately not awaited: a click handler
    // that returned a promise would leave the caller with nothing useful to do with it.
    onOpenPdf: () => void guard(() => openPdf(chrome)),
    onTutorial: () => void guard(() => openTutorial(chrome)),
    onCreateProject: () => void guard(() => createProject(chrome)),
    onOpenProject: () => void guard(() => openProject(chrome)),
    onImport: () => void guard(() => importDrawings(chrome)),
    onSelectRevision: (revision) => void guard(() => openRevision(chrome, revision)),
    onSelectOutline: (page) => void guard(async () => {
      await session?.viewer.goToPage(page);
    }),
    onSelectRecent: (id) => void guard(() => openRecent(chrome, id)),
    onExtractPages: () => void guard(() => extractPagesToNewDrawing(chrome)),
    onSelectSheet: (page) => void guard(async () => {
      await session?.viewer.goToPage(page);
    }),
    onFilterRevision: (revision) => void guard(() => showRegister(chrome, revision)),
    recentProjects: () => recent,
    onVerify: () => void guard(() => verify(chrome)),
    onDiagnostics: () => void guard(() => saveDiagnostics(chrome)),
    exportItems,
    onExport: (id) => void guard(() => runExport(chrome, id)),
  });

  if (info) {
    chrome.setStatus(`SheetForge ${info.version} — signed in as ${info.actor}`);
    // Drawings dropped on the window. Handled in Rust; this is only told the outcome.
    await onDropped((event) => {
      void guard(async () => {
        if (event.error) {
          // The host reports a refusal as data rather than as a rejected call, because a drop has
          // no call to reject — nothing on this side asked for it.
          if (event.error.code !== "cancelled") chrome.setStatus(event.error.message);
          return;
        }
        const opened = event.opened ?? [];
        if (opened.length === 0) return;
        const first = opened[0]!;
        chrome.setProject(first.project);
        chrome.setRevisions(await host.documentList());
        await openRevision(chrome, first.revision);
        if (opened.length > 1) {
          chrome.setStatus(`Added ${opened.length} drawings. Showing ${first.revision.name}.`);
        }
      });
    });

    await refreshRecent();

    // A project left open from the last session is reopened by the host, not remembered here.
    const current = await host.projectCurrent();
    if (current) {
      chrome.setProject(current);
      chrome.setRevisions(await host.documentList());
    } else if (isFirstRun()) {
      // Once, on a genuinely empty first launch. Opening a drawing on *every* start would be an
      // imposition on somebody who closed their project deliberately, and creating a project
      // folder behind their back on every launch would be worse. After this the tutorial lives in
      // the Project menu and on the empty state, where it can be asked for rather than inflicted.
      await guard(() => openTutorial(chrome));
    }
  } else {
    chrome.setStatus(
      "Running in a browser tab: nothing can be opened or saved from here. " +
        "Install the SheetForge application to review drawings.",
    );
  }
}

/**
 * Run an action, and put any failure in front of the user rather than in the console.
 *
 * A cancelled dialog is not a failure — the user closed a file picker, which is a normal thing to
 * do — so it is swallowed rather than reported as an error.
 */
async function guard(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (isCommandError(error) && error.code === "cancelled") return;
    const chrome = document.querySelector<HTMLElement>("[data-status]");
    if (chrome) chrome.textContent = errorMessage(error);
    // Kept for the diagnostic bundle. The host's own log has the detail; this is the renderer side.
    console.error("SheetForge:", errorMessage(error));
  }
}

/**
 * Hand produced bytes to the host, which puts them where the user says.
 *
 * Shared by the engine's own exporters and by the summary plugin, so both get the same native save
 * dialog, the same audit entry and the same handling of a dismissed dialog.
 */
async function deliverExport(chrome: Chrome, blob: Blob, filename: string): Promise<void> {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot + 1) : "bin";

  // No size check here any more. Bytes cross to the host as a raw body rather than as a JSON
  // array of numbers, so a plot-resolution image costs one copy instead of five characters per
  // byte on the thread that draws the window. The host still enforces its own limits, which is
  // where that decision belongs.

  chrome.setStatus(`Saving ${filename}…`);
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await host.exportSave(stem, extension, bytes);
    chrome.setStatus(`Exported ${filename}.`);
  } catch (error) {
    // A dismissed save dialog is not a failure worth shouting about.
    if (isCommandError(error) && error.code === "cancelled") {
      chrome.setStatus("Export cancelled.");
      return;
    }
    throw error;
  }
}

/**
 * The Export menu, built from the engine's own action registry.
 *
 * Read from the live viewer rather than hard-coded, for two reasons. An exporter added to the
 * engine turns up here without anyone remembering to add it — the failure mode of a hand-written
 * list is that it silently falls behind. And each action reports whether it is available *now*, so
 * "Export takeoff" greys out on a document with no measurements instead of failing after the click.
 *
 * The engine offers the same actions as icons in its own toolbar. Repeating them here with words is
 * the point: a glyph among fifty others is discoverable by nobody.
 */
function exportItems(): MenuItem[] {
  const viewer = session?.viewer;
  if (!viewer) {
    return [
      { id: "export.pdf", label: "Marked-up PDF…", enabled: false, reason: "Open a drawing first" },
      { id: "export.takeoff", label: "Takeoff (CSV)…", enabled: false, reason: "Open a drawing first" },
      { id: "export.csv", label: "Markup list (CSV)…", enabled: false, reason: "Open a drawing first" },
    ];
  }

  // The engine groups its input/output actions under "io". Ordering is ours, because the registry
  // order is registration order and this is the order somebody reaches for them in.
  const preferred = [
    "export.pdf",
    "export.csv",
    "export.takeoff",
    "export.xfdf",
    "export.bcf",
    "export.bcfzip",
    "export.json",
    "import.xfdf",
    "import.json",
  ];
  const byId = new Map(viewer.actionList.filter((a) => a.group === "io").map((a) => [a.id, a]));
  const ordered = [
    ...preferred.map((id) => byId.get(id)).filter((a) => a !== undefined),
    // Anything the engine has that this list has not heard of still appears, at the end.
    ...viewer.actionList.filter((a) => a.group === "io" && !preferred.includes(a.id)),
  ];

  const engineItems: MenuItem[] = ordered.map((action, index) => ({
    id: action.id,
    // The engine labels these for a tooltip beside an icon ("Export marked-up PDF"); in a menu
    // headed "Export" the verb is redundant, and the ellipsis says a dialog is coming.
    label: `${action.label.replace(/^Export /, "").replace(/^Import /, "Import ")}…`,
    enabled: action.enabled?.(viewer) ?? true,
    reason: "Nothing to export from this drawing yet",
    separatorBefore: action.id.startsWith("import.") && !ordered[index - 1]?.id.startsWith("import."),
  }));

  // Ours, not the engine's: one sheet as a picture, at a resolution chosen for what it is for.
  // Last in the menu because it is the occasional case; separated because it exports *this sheet*
  // rather than the review, which is a different kind of thing to be handing somebody.
  const imageItems: MenuItem[] = RESOLUTIONS.map((resolution, index) => ({
    id: `image.${resolution.id}`,
    label: `This sheet as PNG - ${resolution.label.toLowerCase()} (${resolution.dpi} DPI)…`,
    enabled: true,
    reason: resolution.purpose,
    separatorBefore: index === 0,
  }));

  // The whole set, as one archive rather than one save dialog per sheet. Only at the two lower
  // resolutions: a 200-sheet set at plot resolution is several gigabytes, and offering it would be
  // offering a failure.
  const bulkItems: MenuItem[] = RESOLUTIONS.filter((each) => each.dpi <= 150).map(
    (resolution, index) => ({
      id: `imageset.${resolution.id}`,
      label: `Every sheet as PNG (ZIP) - ${resolution.label.toLowerCase()}…`,
      enabled: true,
      reason: resolution.purpose,
      separatorBefore: index === 0,
    }),
  );

  // Stamped copies, in their own group. An issue status belongs on a drawing that is leaving the
  // review — and a drawing leaving the review without one is the mistake this exists to prevent.
  const stampedItems: MenuItem[] = [
    {
      id: "image.stamped",
      label: "This sheet as PNG, stamped…",
      enabled: true,
      reason: "NOT FOR CONSTRUCTION, or whatever status you are issuing under",
      separatorBefore: true,
    },
    {
      id: "imageset.stamped",
      label: "Every sheet as PNG (ZIP), stamped…",
      enabled: true,
      reason: "NOT FOR CONSTRUCTION, or whatever status you are issuing under",
    },
  ];

  return [...engineItems, ...imageItems, ...bulkItems, ...stampedItems];
}

/** Run one of them. The engine produces the bytes; the host writes them where the user says. */
async function runExport(chrome: Chrome, id: string): Promise<void> {
  const viewer = session?.viewer;
  if (!viewer) return;

  // Checked here as well as in the `onFile` hook. This is the route with a working error channel;
  // the hook is the backstop for the engine's own toolbar.
  if (id === "export.pdf") refuseIfItWouldFakeARedaction(chrome, "export.pdf");

  const resolution = RESOLUTIONS.find((each) => `image.${each.id}` === id);
  if (resolution) {
    await exportSheetImage(chrome, viewer, resolution.dpi);
    return;
  }

  const bulk = RESOLUTIONS.find((each) => `imageset.${each.id}` === id);
  if (bulk) {
    await exportSheetSet(chrome, viewer, bulk.dpi);
    return;
  }

  if (id === "image.stamped") {
    // Asked for every time rather than remembered. A status that is remembered is a status that
    // eventually goes out on the wrong drawing, and the cost of asking is one keystroke.
    const status = chrome.askForIssueStatus();
    if (!status) return;
    await exportSheetImage(chrome, viewer, 150, status);
    return;
  }

  if (id === "imageset.stamped") {
    const status = chrome.askForIssueStatus();
    if (!status) return;
    await exportSheetSet(chrome, viewer, 150, status);
    return;
  }

  await viewer.runAction(id);
}

/**
 * One sheet, as a PNG, through the same native save dialog as everything else.
 *
 * The status line says what is happening before it starts, because at plot resolution this takes
 * seconds and a frozen window with no explanation is indistinguishable from a crash.
 */
async function exportSheetImage(
  chrome: Chrome,
  viewer: Viewer,
  dpi: number,
  stamp?: string,
): Promise<void> {
  const page = viewer.page;
  chrome.setStatus(`Rendering sheet ${page} at ${dpi} DPI…`);

  const image = await sheetAsPng(viewer, page, dpi, stamp);
  // The status goes in the filename as well as on the sheet. A file called
  // "A-201 p2 (NOT FOR CONSTRUCTION).png" is harder to forward carelessly than one that looks
  // like every other export.
  const suffix = stamp ? ` (${forFilename(stamp)})` : "";
  const name = session ? `${session.revision.name} p${page}${suffix}` : `sheet p${page}${suffix}`;
  await deliverExport(chrome, image.blob, `${name}.png`);

  chrome.setStatus(
    `Exported ${name}.png - ${image.width} by ${image.height} pixels, ` +
      `${Math.round(image.blob.size / 1024)} KB.`,
  );
}

/**
 * The primary action: pick a PDF and show it.
 *
 * No project needs to exist first — the host creates one behind the drawing and tells us which,
 * so the status line can say where the markups are being kept rather than leaving somebody to
 * wonder whether they are being kept at all.
 */
async function openPdf(chrome: Chrome): Promise<void> {
  chrome.setStatus("Opening…");
  const opened = await host.pdfOpen();
  await refreshRecent();
  chrome.setProject(opened.project);
  chrome.setRevisions(await host.documentList());
  await openRevision(chrome, opened.revision);
  if (opened.reopened) {
    chrome.setStatus(`${opened.revision.name} — reopened, with the markups you made on it.`);
  }
}

/**
 * Whether this is the first launch on this machine, recording that it no longer is.
 *
 * `localStorage` rather than a host setting: the fact is about this installation's interface, it
 * is worthless to anybody else, and it is not something to spend an IPC command and a schema
 * version on. It carries no personal data — the value is the string "yes" — and clearing browser
 * storage simply offers the tutorial again, which is a harmless failure mode in both directions.
 */
function isFirstRun(): boolean {
  try {
    if (localStorage.getItem(FIRST_RUN_KEY)) return false;
    localStorage.setItem(FIRST_RUN_KEY, "yes");
    return true;
  } catch {
    // Storage can be unavailable or full. Treating that as "not the first run" is the quiet
    // failure: at worst somebody misses a tutorial they can still open from the menu, rather than
    // being shown it every single launch.
    return false;
  }
}

const FIRST_RUN_KEY = "sheetforge.tutorial-offered";

/**
 * Open the tutorial sheet.
 *
 * Deliberately the same path as any other drawing — it lands in a real project, in the real place,
 * with a real audit trail — because a tutorial that behaves unlike the product teaches the wrong
 * thing about the product.
 */
async function openTutorial(chrome: Chrome): Promise<void> {
  chrome.setStatus("Opening the tutorial sheet…");
  const opened = await host.tutorialOpen();
  await refreshRecent();
  chrome.setProject(opened.project);
  chrome.setRevisions(await host.documentList());
  await openRevision(chrome, opened.revision);
  chrome.setStatus(
    opened.reopened
      ? "Tutorial sheet — reopened, with the markups you made on it. Page 2 is the practice sheet."
      : "Tutorial sheet. Mark it up freely; page 2 has a dimension to calibrate against.",
  );
}

/**
 * Every sheet, as one archive.
 *
 * Progress is reported per sheet because this is the one export that takes minutes on a real set,
 * and a window that says nothing for minutes is indistinguishable from one that has hung.
 */
async function exportSheetSet(
  chrome: Chrome,
  viewer: Viewer,
  dpi: number,
  stamp?: string,
): Promise<void> {
  const set = await sheetsAsZip(
    viewer,
    dpi,
    (page, of) => {
      chrome.setStatus(
        page === 0
          ? "Building the legend…"
          : `Rendering sheet ${page} of ${of} at ${dpi} DPI…`,
      );
    },
    stamp,
  );

  const name = session ? session.revision.name : "sheets";
  const suffix = stamp ? ` (${forFilename(stamp)})` : ` (${dpi} DPI)`;
  await deliverExport(chrome, set.blob, `${name}${suffix}.zip`);
  chrome.setStatus(
    `Exported ${set.pages} sheet${set.pages === 1 ? "" : "s"} - ` +
      `${Math.round(set.blob.size / (1024 * 1024))} MB.`,
  );
}

/**
 * A stamp, made safe to put in a filename.
 *
 * The stamp itself is drawn on the sheet verbatim — it is the user's words and the sheet is where
 * they matter. The filename is a different matter: the host checks every name it is asked to write
 * and refuses anything with a separator in it, and discovering that *after* rendering two hundred
 * sheets would be a poor way to find out. Characters that cannot be in a filename become spaces
 * here rather than an error there.
 */
function forFilename(stamp: string): string {
  return stamp
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * Reopen a project from the recent list.
 *
 * The handle is the whole of what this side can say — the host holds the location and resolves it
 * against a list it wrote itself, so this cannot name a folder the person has not already opened
 * through a native dialog.
 */
async function openRecent(chrome: Chrome, id: string): Promise<void> {
  chrome.setStatus("Opening…");
  const project = await host.recentOpen(id);
  chrome.setProject(project);
  const revisions = await host.documentList();
  chrome.setRevisions(revisions);
  await refreshRecent();

  const first = revisions[0];
  if (first) {
    await openRevision(chrome, first);
  } else {
    chrome.setStatus(`Opened ${project.name}. It has no drawings yet.`);
  }
}

/**
 * Re-read the recent list. Failure is silent: it is a convenience, not a guarantee.
 *
 * `?? []` rather than trusting the return, because a host that answers `null` is not throwing and
 * would otherwise put a null where the menu expects an array — which does not fail here, it fails
 * later, while building the Project menu, and takes the whole menu down with it. A test with a
 * thinner stub found exactly that.
 */
async function refreshRecent(): Promise<void> {
  try {
    recent = (await host.recentList()) ?? [];
  } catch {
    recent = [];
  }
}

/**
 * Refuse to write a PDF that would look redacted without being redacted.
 *
 * The engine's "marked-up PDF" export flattens every markup onto the document, and a redaction is
 * stored as an ordinary black rectangle. The result is a file with solid black boxes over text
 * that is still there, still selectable, still recoverable — visually indistinguishable from a
 * real redaction and believed for exactly that reason. Somebody would send it out.
 *
 * The check lives here, in the `onFile` hook, because that is the one point every engine export
 * passes through. Disabling the menu item would leave the engine's own toolbar button, which this
 * application does not control; refusing the bytes covers both, and any route added later.
 *
 * Image exports are deliberately not caught. A PNG has no text in it at all, so a black rectangle
 * on one is a genuine redaction rather than a picture of one — which is also why the redacted PDF
 * export rasterises.
 *
 * @throws if the export would produce a believable fake.
 */
function refuseIfItWouldFakeARedaction(chrome: Chrome, filename: string): void {
  if (!filename.toLowerCase().endsWith(".pdf")) return;
  const viewer = session?.viewer;
  if (!viewer?.store.all().some(isRedaction)) return;

  // Said out loud *and* thrown. The engine does not propagate a rejection out of this hook, so a
  // throw on its own stops the file being written and tells the user nothing: they click
  // "marked-up PDF", nothing happens, and they click it again. The status line is also the only
  // channel that survives the engine's own toolbar button, which this application does not own.
  chrome.setStatus(REDACTION_REFUSAL);
  throw new Error(REDACTION_REFUSAL);
}

/**
 * Why a marked-up PDF is refused while redactions exist.
 *
 * One string, because it is delivered through two mechanisms and they must not drift into saying
 * different things about the same refusal.
 */
const REDACTION_REFUSAL =
  "This drawing has redactions on it, and a marked-up PDF would draw them as black boxes over " +
  "text that is still in the file and still recoverable. Use Export \u2192 redacted copy, which " +
  "removes the content rather than covering it.";

/**
 * Take pages out of the open drawing into a new one.
 *
 * The new drawing is filed by the host as a derived revision, so it carries a record of the issue
 * it was cut from. Both documents stay in the project; nothing is edited. See
 * [ADR-0010](../../docs/adr/0010-page-assembly-produces-a-derived-revision.md).
 */
async function extractPagesToNewDrawing(chrome: Chrome): Promise<void> {
  const current = session;
  if (!current?.viewer.doc) {
    chrome.setStatus("Open a drawing first.");
    return;
  }

  const pageCount = current.viewer.doc.numPages;
  const selection = chrome.askForPages(pageCount);
  if (!selection) return;

  // Parsed before anything is built, so a typo costs a message rather than a minute of work.
  const pages = parsePageSelection(selection, pageCount);

  chrome.setStatus(`Taking ${pages.length} page${pages.length === 1 ? "" : "s"} out…`);
  const extract = await extractPages(current.viewer.doc.bytes, pages);

  // Named for what it is. Two drawings called A-201 with different page counts is a trap, and the
  // page selection is the most useful thing to put in the name because it is what somebody will be
  // looking for when they come back to it.
  const name = `${current.revision.name} (pages ${selection})`;
  const filed = await host.documentDerive(
    name,
    current.revision.id,
    "page-assembly",
    extract.bytes,
  );

  chrome.setRevisions(await host.documentList());
  await openRevision(chrome, filed);
  chrome.setStatus(
    `${filed.name} — ${extract.pages} page${extract.pages === 1 ? "" : "s"} taken from ` +
      `${current.revision.name}. The original is untouched.`,
  );
}

/**
 * How an attachment is named inside a markup record.
 *
 * Deliberately not a real URL. The bytes are in the project package and are fetched by hash on
 * demand: a `blob:` URL is dead as soon as the window reloads, and a `data:` URL would put a
 * three-megabyte photograph inside the markup record, where it would then travel through every
 * export and interchange format that carries markups.
 */
const ATTACHMENT_SCHEME = "sf-attachment:";

/**
 * Open an attachment.
 *
 * The bytes come back from the host, become a blob URL for as long as the tab needs one, and the
 * URL is revoked afterwards — an unreleased blob URL holds the whole photograph in memory for the
 * life of the window, and a field review attaches a lot of photographs.
 */
async function openAttachment(chrome: Chrome, attachment: { url?: string; name: string }): Promise<void> {
  const url = attachment.url ?? "";
  if (!url.startsWith(ATTACHMENT_SCHEME)) {
    chrome.setStatus("That attachment is not stored in this project.");
    return;
  }

  chrome.setStatus(`Opening ${attachment.name}…`);
  const bytes = new Uint8Array(await host.attachmentBytes(url.slice(ATTACHMENT_SCHEME.length)));
  const blob = new Blob([asBlobPart(bytes)]);
  const objectUrl = URL.createObjectURL(blob);
  try {
    // Shown in a new tab within the webview's own origin. Not handed to the system browser: these
    // bytes came out of somebody's project, and the rule is that nothing leaves it unless the user
    // asks for that specifically — which is what the export path is for.
    window.open(objectUrl, "_blank", "noopener");
    chrome.setStatus(`Opened ${attachment.name}.`);
  } finally {
    // A minute is long enough for the tab to have read it, and short enough that a review with
    // fifty photographs does not hold fifty of them.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}

async function createProject(chrome: Chrome): Promise<void> {
  const name = chrome.askForProjectName();
  if (!name) return;
  const project = await host.projectCreate(name);
  await refreshRecent();
  chrome.setProject(project);
  chrome.setRevisions([]);
  chrome.setStatus(`Created ${project.name}. Add drawings to start reviewing.`);
}

async function openProject(chrome: Chrome): Promise<void> {
  const project = await host.projectOpen();
  await refreshRecent();
  chrome.setProject(project);
  const revisions = await host.documentList();
  chrome.setRevisions(revisions);
  chrome.setStatus(
    revisions.length === 0
      ? `Opened ${project.name}. It has no drawings yet.`
      : `Opened ${project.name} — ${revisions.length} drawing${revisions.length === 1 ? "" : "s"}.`,
  );
}

async function importDrawings(chrome: Chrome): Promise<void> {
  chrome.setStatus("Reading drawings…");
  const imported = await host.documentImport();
  const revisions = await host.documentList();
  chrome.setRevisions(revisions);
  chrome.setStatus(`Added ${imported.length} drawing${imported.length === 1 ? "" : "s"}.`);
  const first = imported[0];
  if (first) await openRevision(chrome, first);
}

/**
 * Show the drawing's own table of contents, when it has one.
 *
 * Deliberately not fatal. A set with a malformed outline is still a set worth reviewing, and an
 * application that refused to open one because its bookmarks were broken would be trading a
 * navigational convenience for the whole document.
 */
async function showOutline(chrome: Chrome, viewer: Viewer): Promise<void> {
  try {
    const entries = (await viewer.doc?.outline()) ?? [];
    chrome.setOutline(
      entries.map((entry) => ({
        title: entry.title,
        depth: entry.depth,
        ...(entry.page === undefined ? {} : { page: entry.page }),
      })),
    );
  } catch {
    chrome.setOutline([]);
  }
}

/**
 * Show the sheet register, optionally narrowed to one printed revision.
 *
 * The unfiltered list is the register for the open drawing. A filter asks across the *project*,
 * because that is how the question is asked — a set is issued as several files and the reviewer
 * wants the sheets, not the containers — so the answer can name pages of documents other than the
 * one on screen. Selecting one of those jumps to the page number within whatever is open, which is
 * wrong for a cross-document hit and is the next thing to fix; the honest half is that the filter
 * says which revision it is showing rather than presenting a subset as the whole.
 *
 * Not fatal. A register that cannot be read is a panel that does not appear, not a drawing that
 * will not open.
 */
async function showRegister(chrome: Chrome, revision: string | undefined): Promise<void> {
  const current = session;
  if (!current) {
    chrome.setRegister([]);
    return;
  }

  try {
    const rows =
      revision === undefined
        ? await host.sheetList(current.revision.id)
        : await host.sheetAtRevision(revision);

    chrome.setRegister(
      rows.map((row) => ({
        page: row.page,
        ...(row.number === null ? {} : { number: row.number }),
        ...(row.title === null ? {} : { title: row.title }),
        ...(row.revision === null ? {} : { revision: row.revision }),
        confirmed: row.source === "confirmed",
      })),
      revision,
    );

    if (revision !== undefined) {
      chrome.setStatus(
        rows.length === 0
          ? `No sheets at revision ${revision}.`
          : `${rows.length} sheet${rows.length === 1 ? "" : "s"} at revision ${revision}.`,
      );
    }
  } catch {
    chrome.setRegister([]);
  }
}

/**
 * Put the saved views back, and keep them.
 *
 * Views are the one thing the engine holds that its storage adapter has no channel for: they are
 * absent from both `LoadResult` and `Mutation`, so unlike markups, calibrations and the sheet
 * register they cannot travel that way. They come back through the bus instead — the engine
 * announces `view:saved`, and the whole list is written each time.
 *
 * The list is written whole rather than appended to, because that is the only way a *deletion*
 * reaches the host: the engine says what exists now, and what exists now is what is stored.
 *
 * Restoring re-adds each view through the engine's own `addView`, which mints a fresh id. Nothing
 * refers to a view by id across a session, so that costs nothing — and storing the engine's id
 * would mean keeping two records of one identity in step for no gain.
 *
 * None of this is fatal. A drawing whose views cannot be read is still a drawing worth reviewing.
 */
async function restoreViews(viewer: Viewer, revision: string): Promise<void> {
  try {
    for (const view of await host.viewList(revision)) {
      viewer.store.addView({
        name: view.name,
        page: view.page,
        zoom: view.zoom,
        center: { x: view.centerX, y: view.centerY },
        rotation: view.rotation,
        ...(view.filter === null ? {} : { filter: JSON.parse(view.filter) as AnnotFilter }),
      });
    }
  } catch {
    // Nothing to restore, or nothing readable. The engine starts with an empty list, which is the
    // state a new document is in anyway.
  }

  viewer.bus.on("view:saved", () => {
    void guard(async () => {
      await host.viewReplace(
        revision,
        viewer.store.savedViews().map((view) => ({
          name: view.name,
          page: view.page,
          zoom: view.zoom,
          centerX: view.center.x,
          centerY: view.center.y,
          rotation: view.rotation,
          filter: view.filter === undefined ? null : JSON.stringify(view.filter),
        })),
      );
    });
  });
}

async function openRevision(chrome: Chrome, revision: RevisionSummary): Promise<void> {
  chrome.setStatus(`Opening ${revision.name}…`);

  // The previous viewer owns a pdf.js document, its worker tasks and a tile cache. Dropping the
  // reference without destroying it leaks all three, and on a large set that is the difference
  // between opening twenty sheets and running out of memory on the eighth.
  session?.stopIcons();
  session?.viewer.destroy();
  session = undefined;

  chrome.clearEmptyState();
  const bytes = await host.documentBytes(revision.id);
  const viewer = await createViewer({
    container: chrome.stage,
    workerUrl,
    author: chrome.actor,
    org: "SheetForge",
    initialZoom: "fit-width",
    feetInches: true,
    // On-device, bundled, off by default. See ocr.ts for what it is good at and what it is not.
    ocr: ocrOptions(),
    // Registers "Export summary (XLSX)" in the engine's `io` group, which is what the Export menu
    // is built from — so it appears there without the chrome being told about it.
    plugins: [
      summaryPlugin(async (bytes, filename) => {
        await deliverExport(chrome, new Blob([asBlobPart(bytes)]), filename);
      }),
        // Checking a scale against a dimension printed on the sheet. The tutorial has taught this
      // since it shipped; until now there was no tool for doing it, so the lesson ended at "and
      // now check it by hand".
      scaleCheckPlugin(
        (measured) =>
          window.prompt(
            `This measures ${measured}. What does the dimension on the sheet say?`,
            "",
          ),
        (outcome, unit) => chrome.setStatus(describeCheck(outcome, unit)),
      ),
      // Site photos and voice notes, stored in the project rather than inlined into the markup.
      // Without this hook the engine keeps only files under 256 KB, as data URLs — which rules out
      // every photograph a phone has taken this decade.
      attachmentsPlugin({
        upload: async (file) => {
          chrome.setStatus(`Filing ${file.name}…`);
          const stored = await host.attachmentStore(
            file.name,
            new Uint8Array(await file.arrayBuffer()),
          );
          chrome.setStatus(
            `Filed ${file.name} — ${Math.round(stored.byteLen / 1024)} KB, kept in the project.`,
          );
          // A marker, not a URL. The bytes live in the package and are fetched by hash when they
          // are actually needed; a `blob:` URL minted now would be dead the moment the window
          // reloads, and a `data:` URL would put a three-megabyte photograph inside the markup
          // record.
          return { url: `${ATTACHMENT_SCHEME}${stored.id}`, id: stored.id };
        },
        open: (attachment) => {
          void guard(() => openAttachment(chrome, attachment));
        },
      }),
    // Registers a Redact tool and an "Export redacted copy" action in the engine's own
      // registries, so both appear where the engine's equivalents do.
      redactionPlugin(
        async (bytes, filename) => {
          // `filename` already carries an extension, so the fallback strips it rather than
          // producing "redacted.pdf.pdf".
          const fallback = filename.replace(/\.pdf$/i, "");
          const name = session ? `${session.revision.name} (redacted)` : fallback;
          await deliverExport(chrome, asPdfBlob(bytes), `${name}.pdf`);
        },
        (message) => chrome.setStatus(message),
      ),
    ],
    exporters: {
      // Without this the engine falls back to a browser download — an anchor with a `download`
      // attribute — which inside a webview either goes nowhere or lands somewhere the user did not
      // choose. Handing the bytes back means the destination is picked by a native save dialog on
      // the Rust side, and the export is written to the audit trail.
      onFile: (blob, filename) => {
        refuseIfItWouldFakeARedaction(chrome, filename);
        return deliverExport(chrome, blob, filename);
      },
    },
    persistence: {
      adapter: new HostAdapter(),
      // The revision id, not the filename: markups belong to the issue they were raised against.
      key: () => ({ documentId: revision.id }),
    },
  });

  // The engine takes raw bytes directly. It copies before handing them to pdf.js, which may
  // detach the buffer it is given — so this array is not reused after the call.
  // Say whether work is safe, continuously. The engine emits this as it debounces writes through
  // the adapter; without surfacing it, "it saves as you go" is a claim the interface never backs up.
  viewer.bus.on("sync:state", ({ state, pending, message }) => {
    if (state === "saving") chrome.setSaveState("saving");
    else if (state === "error") chrome.setSaveState("error", message ?? "check the project folder");
    else chrome.setSaveState("saved", pending > 0 ? `${pending} pending` : undefined);
  });

  await viewer.load(new Uint8Array(bytes));
  chrome.setSaveState("saved");
  // After load, so the icons cover tools that register while a document is opening.
  const stopIcons = applyIcons(chrome.stage);
  session = { viewer, revision, stopIcons };
  chrome.setActiveRevision(revision);
  await showOutline(chrome, viewer);
  await showRegister(chrome, undefined);
  await restoreViews(viewer, revision.id);
  chrome.setStatus(
    `${revision.name}${revision.revisionLabel ? ` rev ${revision.revisionLabel}` : ""} — ` +
      `${revision.pageCount} page${revision.pageCount === 1 ? "" : "s"}`,
  );
}

/**
 * Write a diagnostic report.
 *
 * Worth saying in the status line what it does *not* contain, because somebody about to attach a
 * file to a ticket for their client's project wants to know that before they send it, not after.
 */
async function saveDiagnostics(chrome: Chrome): Promise<void> {
  chrome.setStatus("Collecting…");
  await host.diagnosticsSave();
  chrome.setStatus(
    "Diagnostic report saved. It contains no drawings, no markup text and no file paths — " +
      "open it and read it before sending.",
  );
}

async function verify(chrome: Chrome): Promise<void> {
  chrome.setStatus("Checking every drawing and the audit trail…");
  const report = await host.projectVerify();
  chrome.setStatus(
    report.ok
      ? `Verified: ${report.sourcesChecked} drawing${report.sourcesChecked === 1 ? "" : "s"} and ` +
        `${report.auditEntries} audit ${report.auditEntries === 1 ? "entry" : "entries"} are intact.`
      : `This project did not verify: ${report.problem ?? "unknown reason"}`,
  );
}

/** The interface's own facts, for the diagnostics panel. Never document content. */
export function diagnostics(info: AppInfo | undefined): Record<string, string> {
  return {
    host: hasHost() ? "desktop" : "browser",
    version: info?.version ?? "unknown",
    role: info?.role ?? "unknown",
    openRevision: session ? session.revision.shortHash : "none",
  };
}

void start();
