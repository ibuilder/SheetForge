/**
 * The mapping between the engine's records and the host's.
 *
 * These are the tests that matter most in the interface layer, because a mistake here does not
 * crash — it loses a field, or silently reclassifies a reviewer's decision, and nobody notices
 * until the markup list disagrees with the drawing.
 */

import type { Annotation, AnnotKind, AnnotStatus, Calibration } from "@massingcloud/pdf-viewer";
import { describe, expect, it } from "vitest";
import type { HostMarkup, HostStatus } from "../src/bridge";
import {
  GEOMETRY_SCHEMA,
  fromHostCalibration,
  fromHostMarkup,
  fromHostSheet,
  statusPath,
  toHostCalibration,
  toHostKind,
  toHostMarkup,
  toHostMetadata,
  toHostQuantity,
  toHostSheet,
  toHostStatus,
} from "../src/mapping";

const ALL_KINDS: AnnotKind[] = [
  "rect", "ellipse", "polygon", "polyline", "line", "arrow", "cloud", "ink",
  "text", "callout", "highlight", "strikeout", "underline",
  "stamp", "pin", "symbol",
  "distance", "perimeter", "area", "count", "angle", "radius", "volume",
];

const ALL_STATUSES: AnnotStatus[] = ["open", "in_review", "accepted", "rejected", "resolved", "void", "info"];

const ALL_HOST_STATUSES: HostStatus[] = ["open", "in-progress", "for-review", "closed", "void"];

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "annot-1",
    kind: "cloud",
    sheetId: "A-201",
    page: 4,
    points: [
      { x: 72, y: 144 },
      { x: 216, y: 288 },
    ],
    author: "a.reviewer@example.com",
    createdAt: "2026-08-20T10:00:00.000Z",
    version: 1,
    status: "open",
    ...overrides,
  };
}

describe("kinds", () => {
  it("maps every engine kind to a host kind", () => {
    // A missing entry would be `undefined` at runtime and the host would refuse the write with a
    // parse error nobody could act on.
    for (const kind of ALL_KINDS) {
      expect(toHostKind(kind), kind).toBeTruthy();
    }
  });

  it("collapses every measurement kind onto one host kind", () => {
    for (const kind of ["distance", "perimeter", "area", "count", "angle", "radius", "volume"] as AnnotKind[]) {
      expect(toHostKind(kind)).toBe("measurement");
    }
  });

  it("keeps what was measured on the quantity, so collapsing the kind loses nothing", () => {
    const area = toHostQuantity(annotation({ kind: "area", quantity: { value: 64, unit: "ft²", raw: 5184 } }));
    const length = toHostQuantity(annotation({ kind: "distance", quantity: { value: 8, unit: "ft", raw: 72 } }));
    expect(area?.kind).toBe("area");
    expect(length?.kind).toBe("distance");
  });
});

describe("status", () => {
  it("maps every engine status to a host status", () => {
    for (const status of ALL_STATUSES) {
      expect(ALL_HOST_STATUSES, status).toContain(toHostStatus(status));
    }
  });

  it("treats a rejected comment as decided, not as withdrawn", () => {
    // `void` means raised in error. A rejected comment was considered and refused, which is a
    // different fact about the job, and the engine's own value survives on the verbatim record.
    expect(toHostStatus("rejected")).toBe("closed");
    expect(toHostStatus("void")).toBe("void");
  });

  it("counts an informational note as still outstanding", () => {
    expect(toHostStatus("info")).toBe("open");
  });
});

describe("statusPath", () => {
  it("is empty when there is nothing to do", () => {
    for (const status of ALL_HOST_STATUSES) {
      expect(statusPath(status, status)).toEqual([]);
    }
  });

  it("is a single step for a move the host allows directly", () => {
    expect(statusPath("open", "for-review")).toEqual(["for-review"]);
    expect(statusPath("in-progress", "closed")).toEqual(["closed"]);
    expect(statusPath("for-review", "in-progress")).toEqual(["in-progress"]);
    expect(statusPath("closed", "open")).toEqual(["open"]);
  });

  it("routes through open when the host refuses a jump out of a terminal state", () => {
    // The engine lets a reviewer move an accepted comment straight back to in-review. The host
    // will not, so the adapter reopens first. Two audit entries, and both of them true.
    expect(statusPath("closed", "for-review")).toEqual(["open", "for-review"]);
    expect(statusPath("void", "in-progress")).toEqual(["open", "in-progress"]);
  });

  it("always ends at the requested status, from anywhere to anywhere", () => {
    for (const from of ALL_HOST_STATUSES) {
      for (const to of ALL_HOST_STATUSES) {
        const path = statusPath(from, to);
        if (from === to) continue;
        expect(path.at(-1), `${from} -> ${to}`).toBe(to);
        expect(path.length, `${from} -> ${to} took ${path.length} steps`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("never proposes a step the host would refuse", () => {
    // The whole point: every step in the path has to be one the state machine in sf-domain
    // accepts, or the save fails halfway and leaves the record between two states.
    const allowed = (from: HostStatus, to: HostStatus): boolean => {
      if (from === to || to === "void") return true;
      if (from === "closed" || from === "void") return to === "open";
      return true;
    };
    for (const from of ALL_HOST_STATUSES) {
      for (const to of ALL_HOST_STATUSES) {
        let at = from;
        for (const step of statusPath(from, to)) {
          expect(allowed(at, step), `${at} -> ${step} (going ${from} -> ${to})`).toBe(true);
          at = step;
        }
      }
    }
  });
});

describe("metadata", () => {
  it("projects the construction fields the host indexes on", () => {
    const metadata = toHostMetadata(
      annotation({
        subject: "Duct clashes with beam",
        note: "Confirm the soffit height before fabrication.",
        discipline: "mechanical",
        assignee: "j.foreman@example.com",
        dueDate: "2026-09-01",
        trade: "23 HVAC",
        labels: ["level-4", "coordination"],
      }),
    );
    expect(metadata.subject).toBe("Duct clashes with beam");
    expect(metadata.body).toBe("Confirm the soffit height before fabrication.");
    expect(metadata.discipline).toBe("mechanical");
    expect(metadata.assignee).toBe("j.foreman@example.com");
    expect(metadata.cost_code).toBe("23 HVAC");
    expect(metadata.labels).toEqual(["level-4", "coordination"]);
  });

  it("turns a bare due date into an instant the host will accept", () => {
    expect(toHostMetadata(annotation({ dueDate: "2026-09-01" })).due_at).toBe("2026-09-01T00:00:00.000Z");
    expect(toHostMetadata(annotation()).due_at).toBeNull();
  });

  it("sends absent rather than whitespace, which the host refuses", () => {
    const metadata = toHostMetadata(annotation({ subject: "   ", note: "", trade: " " }));
    expect(metadata.subject).toBeNull();
    expect(metadata.body).toBeNull();
    expect(metadata.cost_code).toBeNull();
  });

  it("falls back to the takeoff assembly when there is no trade", () => {
    const metadata = toHostMetadata(
      annotation({ kind: "area", quantity: { value: 1, unit: "ft²", raw: 1, assembly: "03 30 00" } }),
    );
    expect(metadata.cost_code).toBe("03 30 00");
  });
});

describe("quantity", () => {
  it("carries the raw page magnitude, which is what makes re-calibration possible", () => {
    const quantity = toHostQuantity(annotation({ kind: "area", quantity: { value: 64, unit: "ft²", raw: 5184 } }));
    expect(quantity?.raw_page_magnitude).toBe(5184);
    expect(quantity?.value).toBe(64);
    expect(quantity?.provisional).toBe(false);
  });

  it("marks a quantity provisional when its magnitude cannot be re-derived", () => {
    // Without `raw` the number cannot survive a re-calibration, and saying so is better than
    // inventing a magnitude by dividing back through a scale that may have been wrong.
    const quantity = toHostQuantity(annotation({ kind: "area", quantity: { value: 64, unit: "ft²" } }));
    expect(quantity?.provisional).toBe(true);
  });

  it("is absent on a markup that measures nothing", () => {
    expect(toHostQuantity(annotation({ kind: "cloud" }))).toBeNull();
    // A quantity attached to a non-measurement kind is not a measurement either.
    expect(toHostQuantity(annotation({ kind: "text", quantity: { value: 1, unit: "ft" } }))).toBeNull();
  });
});

describe("whole records", () => {
  it("stores the engine record verbatim, including fields this build does not know about", () => {
    // The property everything else rests on. A future engine version adding a field must not lose
    // it by passing through here.
    const original = annotation({
      style: { color: "#c0392b", width: 2 },
      links: { spec: { section: "078400", clause: "1.2.A" }, ifcGuids: ["3n2K1$abc"] },
      ext: { hostSpecific: { anything: [1, 2, 3] } },
    }) as Annotation & { futureField?: string };
    original.futureField = "added by a later version";

    const stored = toHostMarkup(original, "revision-1");
    expect(stored.geometrySchema).toBe(GEOMETRY_SCHEMA);
    expect(stored.geometry).toEqual(original);

    const roundTripped = fromHostMarkup(asHostMarkup(stored.geometry, { version: 1 }));
    expect((roundTripped as typeof original).futureField).toBe("added by a later version");
    expect(roundTripped.links?.spec?.clause).toBe("1.2.A");
    expect(roundTripped.ext).toEqual({ hostSpecific: { anything: [1, 2, 3] } });
  });

  it("takes the version from the host, not from the stored payload", () => {
    // The stored payload was written when the version was 1; the host has since moved on. Reading
    // the stale number back would make the next save fail as a phantom conflict.
    const stored = toHostMarkup(annotation({ version: 1 }), "revision-1");
    const read = fromHostMarkup(asHostMarkup(stored.geometry, { version: 7 }));
    expect(read.version).toBe(7);
  });

  it("keeps the engine id when the host echoes it back", () => {
    const stored = toHostMarkup(annotation({ id: "annot-1" }), "revision-1");
    const read = fromHostMarkup(asHostMarkup(stored.geometry, { version: 1, id: "host-id" }));
    // The host owns identity once it has stored the record.
    expect(read.id).toBe("host-id");
  });
});

describe("calibration", () => {
  it("round-trips a preset scale", () => {
    const original: Calibration = {
      unitsPerPoint: 8 / 72,
      unit: "ft",
      label: '1/8" = 1\'-0"',
      source: "preset",
      page: 4,
    };
    const stored = toHostCalibration(original, "revision-1");
    expect(stored.source).toBe("declared-preset");
    expect(stored.unitsPerPageUnit).toBeCloseTo(8 / 72, 12);

    const back = fromHostCalibration({
      id: "cal-1",
      page: stored.page,
      units_per_page_unit: stored.unitsPerPageUnit,
      unit: stored.unit,
      source: stored.source,
      preset_label: stored.presetLabel,
      is_verified: true,
    });
    expect(back).toEqual(original);
  });

  it("treats a hand-drawn calibration as the strongest evidence and an imported one as provisional", () => {
    expect(toHostCalibration({ unitsPerPoint: 1, unit: "m", source: "measured", page: 1 }, "r").source)
      .toBe("user-calibrated");
    // Nobody here has checked an imported scale against the sheet, which is what the host's
    // provisional state names.
    expect(toHostCalibration({ unitsPerPoint: 1, unit: "m", source: "imported", page: 1 }, "r").source)
      .toBe("extracted-from-sheet");
  });

  it("maps the engine's document-wide scale onto page one", () => {
    // The engine uses page 0 for "the whole document"; the host numbers pages from 1 and would
    // refuse a page 0 outright.
    expect(toHostCalibration({ unitsPerPoint: 1, unit: "m", source: "preset", page: 0 }, "r").page).toBe(1);
  });
});

/** A host markup carrying `geometry`, for the round-trip tests. */
function asHostMarkup(
  geometry: Record<string, unknown>,
  overrides: { version: number; id?: string },
): HostMarkup {
  return {
    id: overrides.id ?? "annot-1",
    documentRevisionId: "revision-1",
    page: 4,
    kind: "cloud",
    status: "open",
    geometrySchema: GEOMETRY_SCHEMA,
    geometry,
    metadata: {},
    quantity: null,
    version: overrides.version,
    createdBy: "a.reviewer@example.com",
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:05:00.000Z",
  };
}

describe("the sheet register across the boundary", () => {
  it("sends what the engine read, marked as a guess rather than a fact", () => {
    // The engine's title-block heuristic produced this. It is not a person, and saying so is what
    // stops the store letting it overwrite somebody's correction later.
    const sent = toHostSheet(
      {
        sheetId: "rev#7",
        page: 7,
        number: "A-201",
        title: "SECOND FLOOR PLAN",
        discipline: "architectural",
        revision: "C",
      },
      "extracted",
    );

    expect(sent.source).toBe("extracted");
    expect(sent.page).toBe(7);
    expect(sent.number).toBe("A-201");
    expect(sent.revision).toBe("C");
  });

  it("turns what could not be read into null rather than an empty string", () => {
    // An empty string is a value somebody read; absent is the truth. The store treats a row with
    // nothing in it as one not worth writing, and that decision needs the difference.
    const sent = toHostSheet({ sheetId: "rev#1", page: 1 });
    expect(sent.number).toBeNull();
    expect(sent.title).toBeNull();
    expect(sent.discipline).toBeNull();
    expect(sent.revision).toBeNull();
  });

  it("reads a row back into the shape the engine expects", () => {
    const restored = fromHostSheet({
      page: 3,
      number: "M-401",
      title: "MECHANICAL PLANT",
      discipline: "mechanical",
      revision: "B",
      source: "confirmed",
      documentRevisionId: "0192f0c1-0000-7000-8000-0000000000aa",
    });

    expect(restored.page).toBe(3);
    expect(restored.number).toBe("M-401");
    expect(restored.discipline).toBe("mechanical");
    // Derived rather than stored: two records of one fact drift, and this one is computable.
    expect(restored.sheetId).toBe("0192f0c1-0000-7000-8000-0000000000aa#3");
  });

  it("omits an absent field rather than setting it to undefined", () => {
    // `exactOptionalPropertyTypes` makes these different, and the engine's own code branches on
    // whether the key is there.
    const restored = fromHostSheet({
      page: 1,
      number: null,
      title: null,
      discipline: null,
      revision: null,
      source: "extracted",
      documentRevisionId: "rev",
    });

    expect("number" in restored).toBe(false);
    expect("discipline" in restored).toBe(false);
  });
});
