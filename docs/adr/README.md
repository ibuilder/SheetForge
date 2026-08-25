# Decision records

One file per decision that would otherwise get re-litigated every six months. Each says what was
decided, what it costs, and what would make us change our mind — that last part being the one most
ADRs leave out and the one that makes them useful later.

Superseded records stay, marked as superseded, because reasoning that turned out to be wrong is
worth keeping.

| | Decision | Status |
|---|---|---|
| [0001](0001-shell-selection-tauri-vs-electron.md) | Shell: Tauri 2, not Electron | Accepted |
| [0002](0002-pdf-rendering-engine-and-license-decision.md) | Renderer: pdf.js in the webview | Accepted |
| [0003](0003-project-package-and-local-data-model.md) | A `.sfproj` directory with SQLite inside | Accepted |
| [0004](0004-markup-coordinate-system-and-measurement-provenance.md) | PDF user space; quantities carry provenance | Accepted |
| [0005](0005-desktop-security-capabilities-and-threat-model.md) | No paths across IPC; capability-gated commands | Accepted |
| [0006](0006-update-signing-and-release-process.md) | Signed update payloads; code signing outstanding | Accepted, partly unimplemented |
| [0007](0007-telemetry-privacy-and-diagnostics.md) | No telemetry at all | Accepted |
| [0008](0008-open-source-license-and-sbom-policy.md) | Apache-2.0; no copyleft in the dependency tree | Accepted |
| [0009](0009-trademark-and-brand-clearance-status.md) | "SheetForge" is uncleared | **Open risk** |
| [0010](0010-page-assembly-produces-a-derived-revision.md) | Assembling pages produces a new revision, never an edit | Accepted |
| [0011](0011-counting-symbols-from-vector-content.md) | Count symbols from vector content, not pixels | **Proposed** — blocked on CAD-export evidence |
