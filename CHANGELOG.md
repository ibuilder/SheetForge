# Changelog

Notable changes, newest first. Follows [Keep a Changelog](https://keepachangelog.com/) and
[semantic versioning](https://semver.org/); before 1.0 the minor version may break things, and any
break that touches stored data will say so here with a migration note.

## [Unreleased]

## [0.1.0] — 2026-08-20

First release. The core is built and tested; the shell is young. See
[docs/status.md](docs/status.md) for what is verified and what is not.

### Added

**Reviewing**
- Open a construction drawing set and navigate it: continuous or single-page, fit-width and
  fit-page, rotation, thumbnails, and tiled rasterisation so a D-size sheet stays readable at 800%.
- Search across sheet text, markup content and the sheet register at once, with phrase matching
  over the joined word stream.
- Revision compare with automatic alignment, difference clustering, and clouding of the changes.
- Slip-sheet migration with a per-markup verdict — unchanged, relocated, or needs a human — and a
  review queue rather than silent reapplication.
- CSI specification parsing into addressable sections and clauses, so a citation is a link.
- OCR for scanned sheets through a recogniser you supply; nothing is bundled and no engine is the
  default.

**Marking up**
- Rectangle, ellipse, polygon, polyline, line, arrow, freehand ink, revision clouds with real
  scalloped arcs, text, callouts, glyph-accurate highlight, strikeout and underline, dynamic
  stamps, symbols, issue pins and attachments.
- Markups as structured records: subject, note, status, discipline, assignee, due date, cost code,
  labels, spec citation and IFC references.
- A validated status workflow, with reopening routed through the start of the review rather than
  jumping into the middle of it.
- Undo and redo for every locally reversible action.

**Measuring**
- Distance, polyline length, area, perimeter, count, angle, radius and volume.
- Per-page calibration from a drawn dimension, a named scale preset, or a title block reading that
  stays provisional until a human confirms it.
- Feet-and-inches formatting and parsing.
- Every quantity carries its raw page magnitude, calibration, formula version, unit and precision,
  so re-calibrating a page re-derives every measurement on it.

**Keeping it**
- The `.sfproj` project package: content-addressed drawings kept byte-identical, SQLite records,
  and an integrity check that reports an altered or missing drawing rather than opening anyway.
- A hash-chained, tamper-evident audit trail, immutable at the database level and exportable as
  NDJSON.
- Optimistic concurrency on every write, so a concurrent edit becomes a conflict somebody resolves
  rather than one of two edits disappearing.
- Durable writes: WAL with `synchronous = FULL`, because a tablet losing power on site is the
  expected failure.

**Exporting**
- Flattened PDF, CSV and XLSX takeoff, XFDF, and BCF topics — each carrying the document revision,
  page, markup id, calibration and formula version.

**Platform**
- Windows, macOS, Linux, iOS and Android from one codebase.
- Signed update payloads, verified before they are applied.
- No telemetry, no account, no cloud. One outbound connection, for the update check, and it can be
  turned off.

### Known limitations

- Release binaries are not code-signed with an organisation certificate, so Windows SmartScreen and
  macOS Gatekeeper will warn on install.
- The name "SheetForge" has not had trademark clearance —
  [ADR-0009](docs/adr/0009-trademark-and-brand-clearance-status.md).
- No at-rest encryption of the project package; use full-disk encryption.
- No fuzzing corpus for hostile PDF input yet. This is the largest security gap.
- No third-party security audit and no penetration test.

[Unreleased]: https://github.com/ibuilder/SheetForge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ibuilder/SheetForge/releases/tag/v0.1.0
