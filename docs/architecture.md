# Architecture

## The shape

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Webview  ·  untrusted                                                    │
│                                                                           │
│   @massingcloud/pdf-viewer      apps/ui                                   │
│   ─────────────────────────     ─────────────────────────────             │
│   rendering, tiles, tools       chrome.ts    project frame                │
│   markup vocabulary             mapping.ts   engine record ⇄ host record  │
│   measurement geometry          adapter.ts   StorageAdapter → host        │
│   compare, specs, OCR           bridge.ts    the only import of Tauri     │
│   XFDF · BCF · CSV · flatten                                              │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │  ~18 named commands. No paths. No fs.
                                   │  No shell. No generic bridge.
┌──────────────────────────────────┴────────────────────────────────────────┐
│  Rust host  ·  trusted                                                    │
│                                                                           │
│   apps/desktop/src-tauri     commands are thin adapters:                  │
│                              validate → authorise → use case → map        │
│                                                                           │
│   sf-package    the .sfproj package, content-addressed, integrity-checked │
│   sf-store      SQLite: schema, forward migrations, repositories          │
│   sf-audit      hash-chained, tamper-evident events                       │
│   sf-security   resource limits · path containment · capabilities         │
│   sf-domain     entities · invariants · state machine · provenance        │
└───────────────────────────────────────────────────────────────────────────┘

Dependencies point inward. sf-domain knows about nothing above it.
```

## The five decisions everything else follows from

### 1. Rules live in Rust, not in the interface

A rule enforced in a click handler is a rule the importer does not obey, and the migration does not
obey, and the next interface does not obey. So `sf-domain` owns what a markup *is*: which status
moves are legal, what a quantity must carry, that a page number is inside its document, that a
stale write is refused.

`sf-domain` has no I/O, no database, no PDF engine and no Tauri. It compiles and tests in under a
second, which is why its 60 tests describe the product's actual invariants rather than a
convenient subset.

### 2. The webview is untrusted

Not because we distrust our own code, but because an XSS in a document-adjacent interface is a
realistic bug and the blast radius should be bounded. There is no filesystem capability, no shell,
no generic bridge command and no command that accepts a path. Where a file must be chosen, the
native picker runs on the Rust side and only an opaque id crosses back.

The full boundary is in [SECURITY.md](../SECURITY.md).

### 3. Source PDFs are immutable and content-addressed

A markup refers to a `DocumentRevision`, never to a file path. The revision's identity is the
SHA-256 of the PDF's bytes, which is also its filename inside the package. Consequences:

- The bytes the architect issued stay byte-identical — the only version of events a dispute will
  accept.
- The same sheet arriving in two transmittals is stored once.
- A package whose drawings were altered on disk fails verification rather than opening with
  different drawings than the markups were made against.

### 4. Geometry is PDF user space, and the engine owns its vocabulary

All coordinates are PDF user units (1/72"), top-left origin, unrotated — never viewport pixels,
which are correct at exactly one zoom level on one monitor.

The host stores the engine's whole annotation record **verbatim** as an opaque, versioned,
size-bounded JSON payload, and projects the fields it needs to index into its own columns. This is
a trade, taken deliberately: re-declaring the shape vocabulary in Rust would mean two definitions
that must agree, and the failure mode when they drift is a markup that will not round-trip. What
the domain is authoritative about instead is the part it can be: that the payload is well-formed,
bounded, versioned, and on a page that exists.

The cost is that Rust cannot query inside the geometry. That has not been needed; when it is, the
fields get promoted to columns with a migration.

### 5. A quantity carries its provenance

Never a bare float. Raw page magnitude, calibration, formula version, unit, precision, and whether
the scale was human-verified. That is what makes re-calibration re-derive rather than require
redrawing, and what makes an unverified scale visible on every number it produced.

See [`sf-domain/src/measurement.rs`](../crates/sf-domain/src/measurement.rs) — it is the most
commented file in the project, because it is the one whose bugs are invisible.

## The crates

| Crate | Owns | Tests |
|---|---|---|
| `sf-domain` | Entities, invariants, the status state machine, measurement provenance, ids | 60 |
| `sf-audit` | Hash-chained events, chain verification, log redaction | 18 |
| `sf-security` | Resource limits, path containment, filename rules, capabilities | 28 |
| `sf-store` | SQLite schema, forward migrations, repositories, optimistic concurrency | 28 |
| `sf-package` | The `.sfproj` layout, content addressing, atomic writes, integrity | 20 |
| `sheetforge` | Tauri host: commands, state, capability files, plugins | 12 |

## The project package

```
Riverside Tower.sfproj/
  manifest.json          format version, project identity, every drawing that should be here
  database.sqlite        markups, calibrations, the audit trail
  sources/<sha256>.pdf   drawings, byte-identical
  attachments/<sha256>   photos and files
  cache/                 regenerable; never trusted, always safe to delete
  audit.ndjson           optional portable export of the trail
```

**A directory, not a single file.** A container would have to be rewritten to add one markup —
slow on a 400 MB set, and precisely the moment a power cut destroys the file. A directory lets
SQLite write transactionally to the part that changes while the drawings, the large immutable part,
are never touched again after import. When something does go wrong, the PDFs are still PDFs and a
file manager can recover them.

**One project per package.** The file *is* the project. A multi-project store would mean a package
you cannot hand to somebody without handing over other jobs too.

## Storage

SQLite, WAL, `synchronous = FULL`.

The usual advice for WAL is `synchronous = NORMAL`, which is faster and can lose the last
transactions on an OS crash or power cut. That trade is wrong here: a tablet losing power in a
basement is the *expected* failure on a construction site, not the exotic one, and durability is
the whole promise of local-first. The cost is a flush per commit, and commits are debounced by
autosave rather than issued per pen stroke.

Every table is `STRICT`. Without it SQLite stores whatever it is given — a page number can be the
string `"four"` — and the error surfaces days later as a parse failure on read.

Migrations are **forward-only and append-only**. There are no down-migrations: a user who opens a
project on a newer build and then goes back is a real scenario, and the honest answer is to refuse
to open it rather than run a reverse migration nobody has tested against their data.

## Concurrency

Every write quotes the version it was made against. A stale write is refused with both versions
named, so a second reviewer's edit surfaces as a conflict somebody resolves rather than as one of
two edits quietly disappearing. Read-apply-write happens inside one transaction, so two writers
cannot both read version *n*, both pass the check, and both write *n+1*.

## Where the two models meet

The engine and the host overlap but are not identical, and pretending otherwise is how markup data
gets lost. [`apps/ui/src/mapping.ts`](../apps/ui/src/mapping.ts) is the whole of the translation,
and its rules are:

- The engine's record is stored **verbatim**, including fields this build has never heard of.
- The host's columns are a **projection** for indexing, filtering and roll-up — not a second copy.
- On read, the engine's record wins for everything except `id` and `version`, which the host owns.

Two mismatches are worth knowing about:

**Status.** The engine has seven statuses, the host five. `rejected` maps to `closed` rather than
`void`, because `void` means *raised in error* and a rejected comment was considered and refused —
a different fact about the job. The engine's exact value survives verbatim.

**The workflow.** The engine lets a reviewer move an accepted comment straight back to *in review*;
the host's state machine will not take that step. Rather than refuse the edit — which would look
like a bug — or weaken the rule, the adapter walks the legal path: `closed → open → for-review`.
Two audit entries instead of one, reading as *reopened, then sent back for review*, which is more
truthful than a single entry claiming a move that never happened.

## Mobile

iOS and Android build from the same library through `tauri::mobile_entry_point`. The differences
are handled where they arise rather than by forking the shell: no window state to persist, and file
pickers are system document providers, which the dialog plugin already abstracts. The interface is
the same bundle, with a responsive layout and touch and pen handling that the drawing engine
already owns.

See [mobile.md](mobile.md).

## Decision records

The reasoning behind each of these, with the alternatives that were rejected:

- [0001 — Shell selection: Tauri vs Electron](adr/0001-shell-selection-tauri-vs-electron.md)
- [0002 — PDF rendering engine and licence](adr/0002-pdf-rendering-engine-and-license-decision.md)
- [0003 — Project package and local data model](adr/0003-project-package-and-local-data-model.md)
- [0004 — Coordinate system and measurement provenance](adr/0004-markup-coordinate-system-and-measurement-provenance.md)
- [0005 — Desktop security capabilities and threat model](adr/0005-desktop-security-capabilities-and-threat-model.md)
- [0006 — Update signing and release process](adr/0006-update-signing-and-release-process.md)
- [0007 — Telemetry, privacy and diagnostics](adr/0007-telemetry-privacy-and-diagnostics.md)
- [0008 — Open-source licence and SBOM policy](adr/0008-open-source-license-and-sbom-policy.md)
- [0009 — Trademark and brand clearance status](adr/0009-trademark-and-brand-clearance-status.md)
