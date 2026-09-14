/**
 * Importing markups from a file — XFDF, or a SheetForge markup set — without letting the file in
 * unmeasured.
 *
 * ## Why the engine's own imports are replaced
 *
 * The drawing engine ships both actions, and both pick the file inside the webview and read it
 * whole with `File.text()`. Nothing on that path consults a size ceiling: `check_interchange`
 * existed in the host and was never called. The threat model names "a hostile XFDF … arriving by
 * email from a subcontractor" as the primary adversary, so a file of a few gigabytes would have been
 * read into the window's memory and brought it down, taking any unsaved markups with it.
 *
 * These replacements register under the engine's own action ids — so the Export menu and the
 * engine's toolbar both reach them, and neither can reach the unguarded originals — and fetch the
 * file through the host, which runs the picker natively and refuses the file before reading it if
 * it is not an ordinary file or is past the interchange ceiling. No path ever reaches this side.
 *
 * ## One deliberate change in behaviour
 *
 * The engine's "Load markup set" replaces every markup on the drawing with the file's, without a
 * word. That is the action's meaning and it is kept — but it now says what it is about to replace
 * and asks first, because silently discarding somebody's markups is the one thing this application
 * is built never to do.
 */

import {
  definePlugin,
  fromXfdf,
  type Annotation,
  type Calibration,
  type SheetMeta,
  type Viewer,
} from "@massingcloud/pdf-viewer";

export type InterchangeKind = "xfdf" | "markups";

/** What the imports need from outside, passed in so each branch can be tested. */
export interface InterchangeDeps {
  /** Fetch a file through the host's picker. Resolves null if the reviewer cancelled. */
  open: (kind: InterchangeKind) => Promise<Uint8Array | null>;
  status: (message: string) => void;
  confirm: (message: string) => boolean;
}

/** The format marker a SheetForge markup set carries, as the engine writes it. */
const MARKUP_SET_FORMAT = "massing-pdf-markups";

/** Register the guarded imports under the engine's own action ids, replacing its versions. */
export function interchangePlugin(deps: InterchangeDeps) {
  return definePlugin({
    id: "sheetforge-interchange",
    setup(context) {
      context.registerAction({
        id: "import.xfdf",
        label: "Import XFDF",
        icon: "⇤",
        group: "io",
        enabled: (viewer) => !!viewer.doc,
        run: (viewer) => importXfdf(viewer, deps),
      });
      context.registerAction({
        id: "import.json",
        label: "Load markup set",
        icon: "⭱",
        group: "io",
        enabled: (viewer) => !!viewer.doc,
        run: (viewer) => loadMarkupSet(viewer, deps),
      });
    },
  });
}

/** Fetch through the host, turning a refusal into a message and a cancel into nothing. */
async function fetchFile(kind: InterchangeKind, deps: InterchangeDeps): Promise<string | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.open(kind);
  } catch (error) {
    // The host's refusal names the rule and the ceiling — "over the 64 MB limit for an import
    // file" — which is what the reviewer needs; never the path.
    deps.status(error instanceof Error ? error.message : String(error));
    return null;
  }
  if (!bytes) return null;
  return new TextDecoder().decode(bytes);
}

/** Import XFDF: markups are added to the drawing, never replacing what is there. */
export async function importXfdf(viewer: Viewer, deps: InterchangeDeps): Promise<void> {
  const doc = viewer.doc;
  if (!doc) return;
  const text = await fetchFile("xfdf", deps);
  if (text === null) return;

  const pages = new Map(
    (await doc.primeInfo()).map((info) => [info.page, { width: info.width, height: info.height }]),
  );
  let drafts;
  try {
    drafts = fromXfdf(text, { pages, defaultAuthor: viewer.author });
  } catch {
    deps.status("That file is not XFDF that SheetForge can read. Nothing was imported.");
    return;
  }
  if (drafts.length === 0) {
    deps.status("No markups found in that file.");
    return;
  }

  const added = viewer.store.addMany(drafts);
  viewer.redraw();
  if (added.length === 0) deps.status("None of those markups could be added.");
  else if (added.length < drafts.length) {
    deps.status(`Imported ${added.length} of ${drafts.length} markups — the rest were refused.`);
  } else deps.status(`Imported ${added.length} markups.`);
}

/** The parts of a markup set this reads. Everything else in the file is ignored. */
interface MarkupSet {
  format?: unknown;
  annotations?: unknown;
  calibrations?: unknown;
  sheets?: unknown;
}

/** Load a markup set: the drawing's markups are *replaced* by the file's — after asking. */
export async function loadMarkupSet(viewer: Viewer, deps: InterchangeDeps): Promise<void> {
  if (!viewer.doc) return;
  const text = await fetchFile("markups", deps);
  if (text === null) return;

  let set: MarkupSet;
  try {
    set = JSON.parse(text) as MarkupSet;
  } catch {
    deps.status("That file is not a markup set. Nothing was loaded.");
    return;
  }
  if (set?.format !== MARKUP_SET_FORMAT || !Array.isArray(set.annotations)) {
    deps.status("That file is not a SheetForge markup set. Nothing was loaded.");
    return;
  }

  // Every entry is checked before anything is replaced. The markups used to be reset first and the
  // calibrations read afterwards, so a set with `calibrations: [null]` threw on `null.page` after
  // the drawing's markups were already gone: half a load, no message, and nothing to undo it with.
  const calibrations = Array.isArray(set.calibrations) ? set.calibrations : [];
  const sheets = Array.isArray(set.sheets) ? set.sheets : [];
  if (
    !set.annotations.every(isAnnotationShaped) ||
    !calibrations.every(isCalibrationShaped) ||
    !sheets.every(isSheetShaped)
  ) {
    deps.status("That markup set is damaged. Nothing was loaded.");
    return;
  }

  const incoming = set.annotations as Annotation[];
  const previous = viewer.store.all();
  if (
    previous.length > 0 &&
    !deps.confirm(
      `Loading this set replaces the ${previous.length} markup${previous.length === 1 ? "" : "s"} ` +
        `on this drawing with the ${incoming.length} in the file.\n\nReplace them?`,
    )
  ) {
    deps.status("Nothing was loaded. The drawing's markups are unchanged.");
    return;
  }

  // The shapes above are what this code relies on, not everything the engine does. If the engine
  // still refuses part of the set, the drawing gets its markups back rather than keeping half.
  try {
    viewer.store.reset(incoming);
    for (const calibration of calibrations as Calibration[]) {
      viewer.store.setCalibration(calibration, calibration.page);
    }
    for (const sheet of sheets as SheetMeta[]) {
      viewer.store.setSheet(sheet);
    }
  } catch {
    viewer.store.reset(previous);
    viewer.redraw();
    deps.status("That markup set could not be loaded. The drawing's markups are unchanged.");
    return;
  }
  viewer.redraw();
  deps.status(`Loaded ${incoming.length} markup${incoming.length === 1 ? "" : "s"}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isPage = (value: unknown, first: number): boolean =>
  Number.isInteger(value) && (value as number) >= first;

/** The fields the store is handed an annotation by. The rest is the engine's to judge. */
function isAnnotationShaped(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    isPage(value.page, 1) &&
    Array.isArray(value.points)
  );
}

/** Page `0` is the document default, so it is allowed here where it is not for a markup. */
function isCalibrationShaped(value: unknown): boolean {
  return (
    isRecord(value) &&
    isPage(value.page, 0) &&
    typeof value.unitsPerPoint === "number" &&
    Number.isFinite(value.unitsPerPoint) &&
    value.unitsPerPoint > 0 &&
    typeof value.unit === "string"
  );
}

function isSheetShaped(value: unknown): boolean {
  return isRecord(value) && typeof value.sheetId === "string" && isPage(value.page, 1);
}
