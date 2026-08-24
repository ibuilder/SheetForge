/**
 * Translating between the drawing engine's records and the host's.
 *
 * The two models overlap but are not the same, and pretending otherwise is how markup data gets
 * quietly lost. The rules here are chosen so that **nothing the engine wrote is ever discarded**:
 *
 * - The engine's `Annotation` is stored **verbatim** as the host's opaque geometry payload. Every
 *   field the engine understands — styles, replies, spec citations, IFC GUIDs, provenance, the
 *   `ext` escape hatch — round-trips untouched, including fields added by a future engine version
 *   that this code has never heard of.
 * - The host's own columns are a **projection** of that record, not a second copy of it. They
 *   exist so the store can index, filter, roll up and export without parsing a JSON blob, and so
 *   the audit trail can name what changed.
 *
 * When the two disagree on read, the engine's record wins for everything except `version`, which
 * is the host's optimistic-concurrency token and belongs to the host.
 *
 * ## Status
 *
 * The engine has seven statuses and the host five, so the projection is lossy in one direction and
 * lossless in the other: the engine's exact value survives inside the verbatim record, while the
 * host stores the rolled-up state a report counts. See {@link toHostStatus}.
 */

import type {
  Annotation,
  AnnotKind,
  AnnotStatus,
  Calibration,
  SheetMeta,
} from "@massingcloud/pdf-viewer";
import type {
  HostCalibration,
  HostKind,
  HostMarkup,
  HostMetadata,
  HostQuantity,
  HostSheet,
  HostStatus,
  NewSheet,
  SheetSource,
} from "./bridge";

/**
 * The schema version written alongside every stored annotation.
 *
 * Bumped when this mapping changes in a way a reader has to know about. Stored per record rather
 * than per file so a project written across two versions stays readable.
 */
export const GEOMETRY_SCHEMA = 1;

// ---------------------------------------------------------------------------
// Kind
// ---------------------------------------------------------------------------

const KIND_TO_HOST: Record<AnnotKind, HostKind> = {
  rect: "rectangle",
  ellipse: "ellipse",
  polygon: "polygon",
  polyline: "polyline",
  line: "line",
  arrow: "arrow",
  cloud: "cloud",
  ink: "ink",
  text: "text",
  callout: "callout",
  highlight: "highlight",
  strikeout: "strikeout",
  underline: "underline",
  stamp: "stamp",
  pin: "pin",
  symbol: "symbol",
  // Every measurement kind collapses to one host kind. What was measured is not lost — it is in
  // the quantity's own `kind`, which is the field a takeoff groups by anyway.
  distance: "measurement",
  perimeter: "measurement",
  area: "measurement",
  count: "measurement",
  angle: "measurement",
  radius: "measurement",
  volume: "measurement",
};

/** The host kind for an engine kind. */
export function toHostKind(kind: AnnotKind): HostKind {
  return KIND_TO_HOST[kind];
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_TO_HOST: Record<AnnotStatus, HostStatus> = {
  open: "open",
  in_review: "for-review",
  accepted: "closed",
  resolved: "closed",
  // Terminal and decided, which is `closed` rather than `void`: `void` means withdrawn — raised in
  // error — and a rejected comment was not raised in error, it was considered and refused. The
  // distinction is preserved exactly in the verbatim record; this is only what a roll-up counts.
  rejected: "closed",
  void: "void",
  // An informational note still wants somebody's eyes, so it counts as outstanding.
  info: "open",
};

/** The host status for an engine status. */
export function toHostStatus(status: AnnotStatus): HostStatus {
  return STATUS_TO_HOST[status];
}

/** Whether the host permits a direct move between two of its statuses. */
function hostAllows(from: HostStatus, to: HostStatus): boolean {
  if (from === to) return true;
  if (to === "void") return true;
  if (from === "closed" || from === "void") return to === "open";
  return true;
}

/**
 * The sequence of host statuses needed to get from `from` to `to`.
 *
 * The host's workflow refuses a jump straight out of a terminal state into the middle of the
 * review — a closed item reopens at the start, so that somebody says what is wrong with it before
 * it is back in review. The engine has no such rule, so a reviewer can legitimately move an
 * accepted comment back to *in review* in one action.
 *
 * Rather than refuse that edit — which would look like a bug — or weaken the host's rule, this
 * returns the legal path: `closed → open → for-review`. Two audit entries instead of one, which
 * reads as *reopened, then sent back for review*, and is a more truthful record than a single
 * entry claiming a move that never happened.
 *
 * Returns an empty array when there is nothing to do.
 */
export function statusPath(from: HostStatus, to: HostStatus): HostStatus[] {
  if (from === to) return [];
  if (hostAllows(from, to)) return [to];
  // The only impassable case is terminal → mid-workflow, and `open` is always reachable from a
  // terminal state, so a single intermediate step is always enough.
  return ["open", to];
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Blank strings mean "unset" on the way to the host, which rejects whitespace-only values. */
function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The host's construction fields, projected from an engine record. */
export function toHostMetadata(annotation: Annotation): HostMetadata {
  return {
    subject: text(annotation.subject),
    body: text(annotation.note),
    discipline: text(annotation.discipline),
    assignee: text(annotation.assignee),
    // The engine's `dueDate` is an ISO date (BCF's shape); the host stores an instant. Midnight
    // UTC is the honest reading of a bare date and is what BCF consumers assume.
    due_at: annotation.dueDate ? `${annotation.dueDate.slice(0, 10)}T00:00:00.000Z` : null,
    // The engine calls this `trade` and means the same thing a cost code does on a takeoff.
    cost_code: text(annotation.trade) ?? text(annotation.quantity?.assembly),
    labels: annotation.labels?.map((label) => label.trim()).filter(Boolean) ?? [],
    custom_fields: {},
  };
}

// ---------------------------------------------------------------------------
// Quantity
// ---------------------------------------------------------------------------

const QUANTITY_KIND: Partial<Record<AnnotKind, HostQuantity["kind"]>> = {
  distance: "distance",
  perimeter: "perimeter",
  area: "area",
  count: "count",
  angle: "angle",
  volume: "volume",
  // The host has no radius kind: a radius is a length, and it scales linearly like one. Which
  // tool drew it stays on the verbatim record.
  radius: "distance",
};

/**
 * The host's quantity for a measured annotation, or `null` when there is nothing measured.
 *
 * `raw` is the field that matters. It is the page-space magnitude before any scale was applied,
 * and it is what lets a page be re-calibrated later without every measurement on it being redrawn.
 * An engine record without it can still be stored, but the host will treat its value as
 * underivable rather than invent a magnitude by dividing back through a scale that may have been
 * wrong in the first place.
 */
export function toHostQuantity(annotation: Annotation): HostQuantity | null {
  const kind = QUANTITY_KIND[annotation.kind];
  const quantity = annotation.quantity;
  if (!kind || !quantity) return null;

  return {
    kind,
    raw_page_magnitude: quantity.raw ?? 0,
    calibration_id: null,
    value: Number.isFinite(quantity.value) ? quantity.value : null,
    unit: quantity.unit,
    precision: 2,
    formula_version: 1,
    // The engine does not model scale confidence, so a quantity arriving from it is marked
    // provisional exactly when its magnitude cannot be re-derived.
    provisional: quantity.raw === undefined,
  };
}

// ---------------------------------------------------------------------------
// Whole records
// ---------------------------------------------------------------------------

/** What the host needs to store a new annotation. */
export function toHostMarkup(
  annotation: Annotation,
  documentRevisionId: string,
): {
  documentRevisionId: string;
  page: number;
  kind: HostKind;
  geometrySchema: number;
  geometry: Record<string, unknown>;
  metadata: HostMetadata;
  quantity: HostQuantity | null;
} {
  return {
    documentRevisionId,
    page: annotation.page,
    kind: toHostKind(annotation.kind),
    geometrySchema: GEOMETRY_SCHEMA,
    // Verbatim, including anything this build does not recognise.
    geometry: annotation as unknown as Record<string, unknown>,
    metadata: toHostMetadata(annotation),
    quantity: toHostQuantity(annotation),
  };
}

/**
 * The engine's record, read back out of the host.
 *
 * The stored payload *is* the annotation, so this is mostly an unwrap. Two fields are taken from
 * the host's own columns rather than the payload, because the host owns them: `id`, which the host
 * assigned, and `version`, which is the concurrency token the next write has to quote.
 */
export function fromHostMarkup(markup: HostMarkup): Annotation {
  const stored = markup.geometry as unknown as Annotation;
  return {
    ...stored,
    id: markup.id,
    page: markup.page,
    version: markup.version,
    updatedAt: markup.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

const CALIBRATION_SOURCE: Record<Calibration["source"], HostCalibration["source"]> = {
  preset: "declared-preset",
  declared: "declared-preset",
  measured: "user-calibrated",
  // An imported scale came from another system and nobody here has checked it against the sheet,
  // which is exactly the state `extracted-from-sheet` names: usable, but provisional until a human
  // agrees with it.
  imported: "extracted-from-sheet",
};

/** The host's form of a page calibration. */
export function toHostCalibration(
  calibration: Calibration,
  documentRevisionId: string,
): {
  documentRevisionId: string;
  page: number;
  unitsPerPageUnit: number;
  unit: string;
  source: HostCalibration["source"];
  presetLabel: string | null;
} {
  return {
    documentRevisionId,
    // The engine uses page 0 for "the document default"; the host has no such concept and numbers
    // pages from 1, so a document-wide scale is stored as page 1's.
    page: calibration.page === 0 ? 1 : calibration.page,
    unitsPerPageUnit: calibration.unitsPerPoint,
    unit: calibration.unit,
    source: CALIBRATION_SOURCE[calibration.source],
    presetLabel: calibration.label ?? null,
  };
}

/** The engine's form of a stored calibration. */
export function fromHostCalibration(calibration: HostCalibration): Calibration {
  const source: Calibration["source"] =
    calibration.source === "user-calibrated"
      ? "measured"
      : calibration.source === "declared-preset"
        ? "preset"
        : "imported";
  return {
    unitsPerPoint: calibration.units_per_page_unit,
    unit: calibration.unit,
    ...(calibration.preset_label ? { label: calibration.preset_label } : {}),
    source,
    page: calibration.page,
  };
}

// ---------------------------------------------------------------------------
// The sheet register
// ---------------------------------------------------------------------------

/**
 * The engine's sheet metadata, on its way to the host.
 *
 * The engine reads title blocks from the PDF's own text layer, or from OCR output on a scan. It
 * does not distinguish the two in {@link SheetMeta}, and the host insists on knowing — so the
 * caller says which, and the default is the more cautious of the two.
 */
export function toHostSheet(sheet: SheetMeta, source: SheetSource = "extracted"): NewSheet {
  return {
    page: sheet.page,
    number: sheet.number ?? null,
    title: sheet.title ?? null,
    discipline: sheet.discipline ?? null,
    revision: sheet.revision ?? null,
    source,
  };
}

/**
 * The host's row, back into the engine's shape.
 *
 * `sheetId` is the engine's key for a sheet across re-issues of a container file. The host keys on
 * (document, page) instead, so it is reconstructed here rather than stored — two records of the
 * same fact drift, and this one is derivable.
 */
export function fromHostSheet(sheet: HostSheet): SheetMeta {
  return {
    sheetId: `${sheet.documentRevisionId}#${sheet.page}`,
    page: sheet.page,
    ...(sheet.number === null ? {} : { number: sheet.number }),
    ...(sheet.title === null ? {} : { title: sheet.title }),
    ...(sheet.discipline === null
      ? {}
      : { discipline: sheet.discipline as NonNullable<SheetMeta["discipline"]> }),
    ...(sheet.revision === null ? {} : { revision: sheet.revision }),
  };
}
