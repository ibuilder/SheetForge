<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="96" alt="">

# SheetForge

**Open-source construction drawing review, markup and calibrated takeoff.**
Windows, macOS, Linux, iOS and Android. Works with the network off.

[Documentation](https://ibuilder.github.io/SheetForge/) ·
[Editing PDFs](docs/guides/editing-pdfs.md) ·
[Takeoffs](docs/guides/takeoffs.md) ·
[Architecture](docs/architecture.md) ·
[Security](SECURITY.md)

</div>

---

## What it is

A drawing review desk for people who build things. Estimators, project engineers, superintendents,
architects and coordinators — not a general-purpose office PDF editor.

The premise is one decision, and everything else follows from it: **a markup is a project record,
not ink.** A revision cloud on a drawing carries who raised it, against which revision of which
sheet, in which discipline, what it measures, who owns it, when it is due, and every status it has
passed through. The shape on screen is one projection of that record. CSV, XFDF, BCF and a
flattened PDF are others.

That is the difference between a document annotator and a review desk. You can filter to "open
structural comments on Level 4", roll them into a takeoff, export them as BCF topics for the
coordination model, and have them survive a slip-sheet.

## Why it exists

Bluebeam Revu is the tool this industry runs on, and it is a good one. It is also per-seat,
Windows-only in practice, and increasingly subscription-gated — which puts it out of reach of the
subcontractors, small consultancies and public-sector teams who are handed the same drawings and
asked to review them properly.

SheetForge is Apache-2.0 and free, and it is deliberately narrow: it does the construction job
extremely well rather than doing everything a PDF can do adequately.

| | SheetForge | Bluebeam Revu | UPDF / general editors |
|---|---|---|---|
| Licence | Apache-2.0, free | Per-seat subscription | Per-seat subscription |
| Platforms | Win · macOS · Linux · iOS · Android | Windows (iPad viewer) | Varies |
| Markups as structured records | Yes — status, discipline, assignee, due date, cost code | Yes | No — comments only |
| Calibrated takeoff with provenance | Yes, per page, re-derivable | Yes, per page | Rarely, or unitless |
| Revision compare and slip-sheet migration | Yes, with a per-markup verdict | Yes | No |
| BCF round-trip to the coordination model | Yes | Via add-ins | No |
| CSI specification parsing and clause citation | Yes | No | No |
| Tamper-evident audit trail | Yes, hash-chained | No | No |
| Works fully offline | Yes, by design | Yes | Varies |
| Arbitrary content editing of a PDF | **No — deliberately** | Partly | Yes |

The last row is the honest one. SheetForge does not rewrite the text and graphics inside somebody
else's drawing, and it is not going to. On a construction job the source PDF is the governing
document; editing it is not a feature, it is a liability. Markups live beside the drawing, and the
issued bytes stay byte-identical.

## What it does

**Review.** Open a set, navigate it, search across sheet text, markup content and the sheet
register at once. Compare two issues of a sheet with automatic alignment — plot origins drift
between issues, and a naive pixel diff reports the whole drawing as changed.

**Mark up.** Rectangle, ellipse, polygon, polyline, line, arrow, freehand ink, real scalloped
revision clouds, text, leader callouts, highlight, strikeout, underline, dynamic stamps, symbols
and issue pins. Highlight and strikeout select **real glyphs**, so a selection spanning three lines
records three quads and draws three bands rather than one block swallowing the margins.

**Measure.** Distance, polyline length, area, perimeter, count, angle, radius and volume, against a
scale you set per page — because a plan sheet and the enlarged detail beside it are different
scales, and a document-wide factor produces confidently wrong numbers on half the set. Feet and
inches render as `12'-6 1/2"`, not `12.54 ft`.

Every quantity keeps the raw page-space magnitude it came from, so **re-calibrating a page
re-derives every measurement on it** instead of forcing the estimator to draw them again. A
quantity whose scale is gone reports as underived rather than as zero, and a scale that was read
off the sheet by OCR is marked provisional until a human confirms it. SheetForge never silently
infers a measurement scale.

**Slip-sheet.** When a sheet is re-issued, carrying markups forward blindly is worse than losing
them — a comment reading "verify this dimension" sitting over a dimension that has since changed is
actively misleading. Each markup gets a verdict: unchanged, relocated, or *needs a human*, and
lands in a review queue with an audit trail.

**Cite the specification.** A CSI spec book is parsed into addressable sections and clauses, so
`07 84 00 §1.2.A` is a link rather than a string somebody typed.

**Export.** Flattened PDF, CSV and XLSX takeoff, XFDF for every other review tool, and BCF topics
for the coordination model — each carrying the document revision, page, markup id, calibration and
formula version the number came from.

## Install

Signed installers for each platform are on the
[releases page](https://github.com/ibuilder/SheetForge/releases).

| Platform | Package |
|---|---|
| Windows 10/11 | `.msi` or `.exe` (NSIS, per-user or per-machine) |
| macOS 10.15+ | `.dmg` (Apple silicon and Intel) |
| Linux | `.AppImage`, `.deb`, `.rpm` |
| iOS / Android | See [docs/mobile.md](docs/mobile.md) |

Updates are delivered as signed payloads and verified against a public key compiled into the
application; an unsigned or mis-signed update is discarded rather than applied.

## Build from source

Needs [Node 20.11+](https://nodejs.org), [Rust 1.82+](https://rustup.rs) and the platform
toolchain Tauri requires ([prerequisites](https://tauri.app/start/prerequisites/)).

```bash
git clone https://github.com/ibuilder/SheetForge.git
cd SheetForge
npm install
npm run desktop:dev
```

Everything the project checks, in one command each:

```bash
npm run check          # TypeScript: typecheck, lint, unit tests
cargo test --workspace # Rust: 166 tests across the five core crates
cargo clippy --workspace --all-targets -- -D warnings
npm run desktop:build  # signed-ready installers for this platform
```

## How it is put together

The drawing engine is [`@massingcloud/pdf-viewer`](https://github.com/MassingCloud/massing-pdf), an
MIT-licensed, framework-agnostic library that owns rendering, the markup vocabulary, measurement
geometry, compare, specifications and interchange. SheetForge is the native shell around it: the
project store, the audit trail, the security boundary, packaging and updates.

```
apps/ui          TypeScript interface — the engine, the project chrome, the IPC edge
apps/desktop     Tauri 2 host: commands, capabilities, dialogs, updater
crates/
  sf-domain      entities, invariants, the status state machine, measurement provenance
  sf-store       SQLite schema, forward migrations, repositories
  sf-package     the .sfproj package: content-addressed drawings, manifest, integrity
  sf-audit       hash-chained, tamper-evident audit events
  sf-security    resource limits, path containment, the capability model
```

Business rules live in Rust, never solely in the interface or the command layer — a rule enforced
in a click handler is a rule the importer does not obey. The webview is treated as untrusted even
though it is loaded from bundled assets: there is no filesystem plugin, no shell access, no generic
bridge command, and no command that accepts a path. Where a file has to be chosen, the native
picker runs on the Rust side and only an opaque id crosses the boundary.

See [docs/architecture.md](docs/architecture.md) and the
[decision records](docs/adr/) for why each of those is the way it is.

## Your drawings stay yours

- Nothing is uploaded. There is no account, no cloud, and no telemetry that reports document
  content — the default is no telemetry at all.
- A project is a folder you can see, back up and hand to somebody.
- Source PDFs are stored byte-identical and addressed by SHA-256, so a package whose drawings have
  been altered on disk fails its integrity check rather than opening with different drawings than
  the markups were made against.
- The audit trail is hash-chained: one altered entry breaks every digest after it.

[PRIVACY.md](PRIVACY.md) states this in full, including what it does *not* promise.

## Status

**Early.** Version 0.1: the core is built and tested, and the shell is young.

What is verified, and how, is listed in [docs/status.md](docs/status.md) — including the parts that
are not yet verified. The project does not claim to be production-ready, secure or performant on
anybody's say-so; those words are used only where a recorded test, measurement or review backs them
up. Two things worth knowing before you depend on it:

- **The name is not cleared.** "SheetForge" has had no professional trademark clearance. See
  [ADR-0009](docs/adr/0009-trademark-and-brand-clearance-status.md).
- **Release binaries are not yet code-signed** with an organisation certificate, so Windows
  SmartScreen and macOS Gatekeeper will warn. Tracked in
  [docs/runbooks/release.md](docs/runbooks/release.md).

[The roadmap](docs/roadmap.md) says what comes next and, more usefully, what is deliberately not
coming.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the workflow, the licence rules for anything you bring in
with you, and the one rule that has no exceptions: **never commit a real project document.**
Fixtures are synthetic, open-licensed or explicitly authorised — never a customer's drawings.

Security issues: please read [SECURITY.md](SECURITY.md) and report privately rather than in a
public issue.

## Licence

[Apache-2.0](LICENSE). Third-party components and their licences are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
