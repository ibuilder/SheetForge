/**
 * The typed edge of the IPC boundary.
 *
 * Every call into Rust goes through this module, and nothing else in the interface imports
 * `@tauri-apps/api`. Two reasons, and the second is the one that matters:
 *
 * 1. The command surface is small and enumerable. You can read this file and know exactly what the
 *    interface is able to ask the host to do.
 * 2. The application runs **without** a host. The drawing engine is a browser library, so the same
 *    interface loads in a plain browser for development and for the demo — with persistence
 *    absent rather than broken. {@link hasHost} is the one place that is decided.
 *
 * Errors arrive as {@link CommandError} with a stable `code`. Switch on the code, never on the
 * message: the message is written for a human and is expected to change.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A refusal from the host. */
export interface CommandError {
  /** Stable and machine-readable, e.g. `version-conflict`, `not-permitted`, `cancelled`. */
  code: string;
  /** One sentence, safe to display. */
  message: string;
  /** Whether the same call could plausibly succeed on a retry. */
  retryable: boolean;
}

/** Narrow an unknown rejection to a {@link CommandError}. */
export function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as CommandError).code === "string" &&
    typeof (error as CommandError).message === "string"
  );
}

/** The message to show for any failure, host-shaped or not. */
export function errorMessage(error: unknown): string {
  if (isCommandError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** True when running inside the desktop or mobile shell rather than a plain browser. */
export function hasHost(): boolean {
  // Tauri 2 marks its webviews with this internal. Feature-detecting the transport is more honest
  // than a build-time flag, because the same bundle is served in both places.
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The bounds the host holds untrusted input to. */
export interface ResourceLimits {
  maxPdfMb: number;
  maxAttachmentMb: number;
  maxPackageMb: number;
  maxInterchangeMb: number;
  maxPages: number;
  maxConcurrentJobs: number;
  jobTimeoutSecs: number;
  maxDecompressedMb: number;
  maxArchiveEntries: number;
}

/** What role the current user holds. */
export type Role = "owner" | "lead" | "reviewer" | "observer";

/** Facts about the running build. */
export interface AppInfo {
  version: string;
  actor: string;
  role: Role;
  limits: ResourceLimits;
}

/** The open project. */
export interface ProjectSummary {
  id: string;
  name: string;
  jobNumber: string | null;
  sourceCount: number;
  format: number;
}

/** One imported issue of a drawing. */
export interface RevisionSummary {
  id: string;
  sourceDocumentId: string;
  name: string;
  revisionLabel: string | null;
  pageCount: number;
  shortHash: string;
  importedAt: string;
}

/** The review status the host rolls up on. */
export type HostStatus = "open" | "in-progress" | "for-review" | "closed" | "void";

/** The tool that made a markup, in the host's vocabulary. */
export type HostKind =
  | "ink" | "line" | "arrow" | "polyline" | "polygon" | "rectangle" | "ellipse" | "cloud"
  | "text" | "callout" | "highlight" | "strikeout" | "underline"
  | "stamp" | "symbol" | "pin" | "attachment" | "measurement";

/** The construction fields the host stores alongside the geometry. */
export interface HostMetadata {
  subject?: string | null;
  body?: string | null;
  discipline?: string | null;
  assignee?: string | null;
  due_at?: string | null;
  cost_code?: string | null;
  labels?: string[];
  custom_fields?: Record<string, unknown>;
}

/** A measured quantity with its provenance. */
export interface HostQuantity {
  kind: string;
  raw_page_magnitude: number;
  calibration_id: string | null;
  value: number | null;
  unit: string;
  precision: number;
  formula_version: number;
  provisional: boolean;
}

/** A markup as the host holds it. */
export interface HostMarkup {
  id: string;
  documentRevisionId: string;
  page: number;
  kind: HostKind;
  status: HostStatus;
  geometrySchema: number;
  /** The drawing engine's own record, stored verbatim. */
  geometry: Record<string, unknown>;
  metadata: HostMetadata;
  quantity: HostQuantity | null;
  /** The optimistic-concurrency token. Send it back on an edit or the write is refused. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A page's scale, as the host holds it. */
export interface HostCalibration {
  id: string;
  page: number;
  units_per_page_unit: number;
  unit: string;
  source: "user-calibrated" | "declared-preset" | "extracted-from-sheet";
  preset_label: string | null;
  is_verified: boolean;
}

/** What opening a drawing produced. */
export interface OpenedDrawing {
  /** The project it went into — possibly one that was just created for it. */
  project: ProjectSummary;
  /** The drawing. */
  revision: RevisionSummary;
  /** True when this file was already in the project and its markups came back with it. */
  reopened: boolean;
}

/** The result of checking a project's integrity. */
export interface VerifyReport {
  ok: boolean;
  problem: string | null;
  sourcesChecked: number;
  auditEntries: number;
}

/** One line of the audit trail. */
export interface AuditEvent {
  seq: number;
  at: string;
  actor: string;
  action: string;
  outcome: "allowed" | "denied";
  reason: string | null;
  subject_id: string | null;
  subject_kind: string | null;
  document_revision_id: string | null;
  page: number | null;
  detail: Record<string, string>;
  prev_hash: string;
  chain_hash: string;
}

/** A markup the interface asks the host to store. */
export interface NewMarkupPayload {
  documentRevisionId: string;
  page: number;
  kind: HostKind;
  geometrySchema: number;
  geometry: Record<string, unknown>;
  metadata?: HostMetadata;
  quantity?: HostQuantity | null;
}

/** What the host reports after drawings are dropped on the window. */
export interface DroppedDrawings {
  /** Present when the import succeeded. */
  opened?: OpenedDrawing[];
  /** Present when it did not. */
  error?: CommandError;
}

/**
 * Listen for drawings dropped on the window.
 *
 * The drop itself is handled entirely in Rust — the paths never cross to this side, which is what
 * lets drag-and-drop exist without weakening the rule that the interface never names a file. What
 * arrives here is the result.
 *
 * Returns a function that stops listening. No-op without a host.
 */
export async function onDropped(handler: (event: DroppedDrawings) => void): Promise<UnlistenFn> {
  if (!hasHost()) return () => undefined;
  return listen<DroppedDrawings>("sheetforge://dropped", (event) => handler(event.payload));
}

/** Thrown when a command is called with no host present. */
export class NoHostError extends Error {
  constructor(command: string) {
    super(`${command} needs the SheetForge application; it is not available in a browser tab.`);
    this.name = "NoHostError";
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasHost()) throw new NoHostError(command);
  return invoke<T>(command, args);
}

// ---------------------------------------------------------------------------
// The command surface, in full
// ---------------------------------------------------------------------------

export const host = {
  appInfo: () => call<AppInfo>("app_info"),

  projectCreate: (name: string, jobNumber?: string) =>
    call<ProjectSummary>("project_create", { name, jobNumber: jobNumber ?? null }),
  projectOpen: () => call<ProjectSummary>("project_open"),
  projectCurrent: () => call<ProjectSummary | null>("project_current"),
  projectClose: () => call<void>("project_close"),
  projectVerify: () => call<VerifyReport>("project_verify"),

  /** The primary action: pick a PDF and show it, creating a project behind it if needed. */
  pdfOpen: () => call<OpenedDrawing>("pdf_open"),
  documentImport: () => call<RevisionSummary[]>("document_import"),
  documentList: () => call<RevisionSummary[]>("document_list"),
  /** The drawing's bytes, as an `ArrayBuffer` — raw, not JSON. */
  documentBytes: (revision: string) => call<ArrayBuffer>("document_bytes", { revision }),

  markupList: (revision: string) => call<HostMarkup[]>("markup_list", { revision }),
  markupCreate: (markup: NewMarkupPayload) => call<HostMarkup>("markup_create", { markup }),
  /**
   * Raise many at once — what an XFDF or BCF import uses.
   *
   * One round trip and one flush to disk instead of one of each per markup: measured at 96 µs per
   * record against 4.6 ms doing them singly. The batch lands whole or not at all.
   */
  markupCreateMany: (markups: NewMarkupPayload[]) =>
    call<HostMarkup[]>("markup_create_many", { markups }),
  markupUpdate: (
    id: string,
    edit: {
      geometry?: Record<string, unknown>;
      geometrySchema?: number;
      metadata?: HostMetadata;
      status?: HostStatus;
      quantity?: HostQuantity;
      clearQuantity?: boolean;
    },
    baseVersion: number,
  ) => call<HostMarkup>("markup_update", { id, edit, baseVersion }),
  markupDelete: (id: string, baseVersion: number) =>
    call<void>("markup_delete", { id, baseVersion }),

  calibrationSet: (calibration: {
    documentRevisionId: string;
    page: number;
    unitsPerPageUnit: number;
    unit: string;
    source: HostCalibration["source"];
    presetLabel?: string | null;
  }) => call<HostCalibration>("calibration_set", { calibration }),
  calibrationGet: (revision: string, page: number) =>
    call<HostCalibration | null>("calibration_get", { revision, page }),

  statusCounts: () => call<[HostStatus, number][]>("status_counts"),
  auditList: () => call<AuditEvent[]>("audit_list"),

  exportSave: (suggestedName: string, extension: string, bytes: Uint8Array) =>
    call<void>("export_save", {
      suggestedName,
      extension,
      // Tauri serialises a plain array here; the alternative is a raw-request channel, which is
      // worth doing when an export gets large enough to notice. Exports are tens of KB today.
      bytes: Array.from(bytes),
    }),
} as const;
