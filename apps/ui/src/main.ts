/**
 * The application.
 *
 * Composition only: it wires the drawing engine to the host adapter, puts the project chrome
 * around it, and gets out of the way. No markup rule, no measurement arithmetic and no persistence
 * decision lives here — those are in the engine and in the Rust crates respectively, which is what
 * lets both be tested without a window.
 */

import { createViewer, type Viewer } from "@massingcloud/pdf-viewer";
import "@massingcloud/pdf-viewer/style.css";
// Bundled, never fetched from a CDN. The application has to work with the network off, and a
// worker that 404s at the moment somebody opens a drawing on a site with no signal is the exact
// failure this product exists to avoid.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { HostAdapter } from "./adapter";
import type { AppInfo, RevisionSummary } from "./bridge";
import { errorMessage, hasHost, host, isCommandError, onDropped } from "./bridge";
import { mountChrome, type Chrome, type MenuItem } from "./chrome";
import { applyIcons } from "./icons";
import { ocrOptions } from "./ocr";
import { RESOLUTIONS, sheetAsPng } from "./sheet-image";
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
 * The bounds the host holds untrusted input to, read once at start-up.
 *
 * Kept here so the interface can refuse something *before* attempting it. The host enforces these
 * regardless — this side is a courtesy, not a control.
 */
let limits: AppInfo["limits"] | undefined;

async function start(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("the application root element is missing from index.html");

  const info = hasHost() ? await host.appInfo() : undefined;
  limits = info?.limits;
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

  // Refused here, before anything is allocated, rather than allowed to become a frozen window.
  //
  // Bytes cross to the host as a JSON array of numbers, which costs roughly five characters per
  // byte to build, serialise and parse. That is invisible for a 40 KB spreadsheet and ruinous for
  // a 30 MB image: the interface would stop responding for as long as it took, with nothing on
  // screen to say why. The ceiling is the host's own interchange limit, so there is one number
  // rather than two disagreeing ones.
  //
  // The real fix is a raw-bytes request, the way `document_bytes` already returns one in the other
  // direction. Until that exists this is a message instead of a hang. See docs/roadmap.md.
  const ceiling = limits ? limits.maxInterchangeMb * 1024 * 1024 : Number.POSITIVE_INFINITY;
  if (blob.size > ceiling) {
    throw new Error(
      `That export is ${Math.round(blob.size / (1024 * 1024))} MB, over the ` +
        `${limits?.maxInterchangeMb} MB limit for moving a file to disk. ` +
        "Choose a lower resolution, or export fewer sheets at once.",
    );
  }

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

  return [...engineItems, ...imageItems];
}

/** Run one of them. The engine produces the bytes; the host writes them where the user says. */
async function runExport(chrome: Chrome, id: string): Promise<void> {
  const viewer = session?.viewer;
  if (!viewer) return;

  const resolution = RESOLUTIONS.find((each) => `image.${each.id}` === id);
  if (resolution) {
    await exportSheetImage(chrome, viewer, resolution.dpi);
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
async function exportSheetImage(chrome: Chrome, viewer: Viewer, dpi: number): Promise<void> {
  const page = viewer.page;
  chrome.setStatus(`Rendering sheet ${page} at ${dpi} DPI…`);

  const image = await sheetAsPng(viewer, page, dpi);
  const name = session ? `${session.revision.name} p${page}` : `sheet p${page}`;
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
  chrome.setProject(opened.project);
  chrome.setRevisions(await host.documentList());
  await openRevision(chrome, opened.revision);
  chrome.setStatus(
    opened.reopened
      ? "Tutorial sheet — reopened, with the markups you made on it. Page 2 is the practice sheet."
      : "Tutorial sheet. Mark it up freely; page 2 has a dimension to calibrate against.",
  );
}

async function createProject(chrome: Chrome): Promise<void> {
  const name = chrome.askForProjectName();
  if (!name) return;
  const project = await host.projectCreate(name);
  chrome.setProject(project);
  chrome.setRevisions([]);
  chrome.setStatus(`Created ${project.name}. Add drawings to start reviewing.`);
}

async function openProject(chrome: Chrome): Promise<void> {
  const project = await host.projectOpen();
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
        await deliverExport(chrome, new Blob([bytes as BlobPart]), filename);
      }),
    ],
    exporters: {
      // Without this the engine falls back to a browser download — an anchor with a `download`
      // attribute — which inside a webview either goes nowhere or lands somewhere the user did not
      // choose. Handing the bytes back means the destination is picked by a native save dialog on
      // the Rust side, and the export is written to the audit trail.
      onFile: (blob, filename) => deliverExport(chrome, blob, filename),
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
