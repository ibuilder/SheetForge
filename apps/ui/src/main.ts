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
import { errorMessage, hasHost, host, isCommandError } from "./bridge";
import { mountChrome, type Chrome } from "./chrome";
import "./styles.css";

interface Session {
  viewer: Viewer;
  revision: RevisionSummary;
}

let session: Session | undefined;

async function start(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("the application root element is missing from index.html");

  const info = hasHost() ? await host.appInfo() : undefined;
  const chrome = mountChrome(root, {
    info,
    // `guard` reports its own failures, so these are deliberately not awaited: a click handler
    // that returned a promise would leave the caller with nothing useful to do with it.
    onCreateProject: () => void guard(() => createProject(chrome)),
    onOpenProject: () => void guard(() => openProject(chrome)),
    onImport: () => void guard(() => importDrawings(chrome)),
    onSelectRevision: (revision) => void guard(() => openRevision(chrome, revision)),
    onVerify: () => void guard(() => verify(chrome)),
  });

  if (info) {
    chrome.setStatus(`SheetForge ${info.version} — signed in as ${info.actor}`);
    // A project left open from the last session is reopened by the host, not remembered here.
    const current = await host.projectCurrent();
    if (current) {
      chrome.setProject(current);
      chrome.setRevisions(await host.documentList());
    }
  } else {
    chrome.setStatus(
      "Running in a browser tab: you can view and mark up a drawing, but nothing is saved. " +
        "Install the SheetForge application to keep a project.",
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
  session?.viewer.destroy();
  session = undefined;

  const bytes = await host.documentBytes(revision.id);
  const viewer = await createViewer({
    container: chrome.stage,
    workerUrl,
    author: chrome.actor,
    org: "SheetForge",
    initialZoom: "fit-width",
    feetInches: true,
    persistence: {
      adapter: new HostAdapter(),
      // The revision id, not the filename: markups belong to the issue they were raised against.
      key: () => ({ documentId: revision.id }),
    },
  });

  // The engine takes raw bytes directly. It copies before handing them to pdf.js, which may
  // detach the buffer it is given — so this array is not reused after the call.
  await viewer.load(new Uint8Array(bytes));
  session = { viewer, revision };
  chrome.setActiveRevision(revision);
  chrome.setStatus(
    `${revision.name}${revision.revisionLabel ? ` rev ${revision.revisionLabel}` : ""} — ` +
      `${revision.pageCount} page${revision.pageCount === 1 ? "" : "s"}`,
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
