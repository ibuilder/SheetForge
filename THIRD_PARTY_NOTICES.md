# Third-party notices

SheetForge is [Apache-2.0](LICENSE). It is built on the components below, each under its own
licence, and this file records source, licence and obligation for the ones we chose deliberately.

**Policy:** no copyleft anywhere in the shipped tree. GPL, LGPL, AGPL, SSPL, source-available and
custom-or-unknown licences are refused rather than reviewed case by case — see
[ADR-0008](docs/adr/0008-open-source-license-and-sbom-policy.md). This is enforced in CI by
`cargo deny` and an npm licence check, both of which fail the build rather than warning.

The lists below are the direct, deliberate dependencies. The complete transitive tree, with
versions, is in `Cargo.lock` and `package-lock.json`; CI checks every entry in both.

## The drawing engine

| Component | Licence | Source |
|---|---|---|
| `@massingcloud/pdf-viewer` | MIT | <https://github.com/MassingCloud/massing-pdf> |

The construction drawing review engine: rendering, the markup vocabulary, measurement geometry,
compare and slip-sheet, specification parsing, OCR wiring, and XFDF/BCF/CSV interchange. SheetForge
is the native shell around it. Pinned to a commit rather than a range, so a build is reproducible.

## Runtime

| Component | Licence | Source |
|---|---|---|
| pdf.js (`pdfjs-dist`) | Apache-2.0 | <https://github.com/mozilla/pdf.js> |
| `pdf-lib` | MIT | <https://github.com/Hopding/pdf-lib> |
| Tauri 2 and its plugins | MIT or Apache-2.0 | <https://github.com/tauri-apps/tauri> |
| SQLite (via `rusqlite`, bundled) | Public domain | <https://sqlite.org> |
| `rusqlite` | MIT | <https://github.com/rusqlite/rusqlite> |
| `serde`, `serde_json` | MIT or Apache-2.0 | <https://serde.rs> |
| `chrono` | MIT or Apache-2.0 | <https://github.com/chronotope/chrono> |
| `uuid` | MIT or Apache-2.0 | <https://github.com/uuid-rs/uuid> |
| `sha2` (RustCrypto) | MIT or Apache-2.0 | <https://github.com/RustCrypto/hashes> |
| `hex` | MIT or Apache-2.0 | <https://github.com/KokaKiwi/rust-hex> |
| `thiserror` | MIT or Apache-2.0 | <https://github.com/dtolnay/thiserror> |
| `log` | MIT or Apache-2.0 | <https://github.com/rust-lang/log> |

## Build and test

| Component | Licence |
|---|---|
| Vite, Vitest | MIT |
| TypeScript | Apache-2.0 |
| ESLint, `typescript-eslint` | MIT |
| Playwright | Apache-2.0 |
| `happy-dom` | MIT |
| `tempfile` | MIT or Apache-2.0 |

Not shipped in the binary.

## Explicitly excluded

| Component | Licence | Why |
|---|---|---|
| **MuPDF** | AGPL-3.0 or commercial | Incompatible with a permissive distribution. See [ADR-0002](docs/adr/0002-pdf-rendering-engine-and-license-decision.md) |

## Assets

| Asset | Provenance |
|---|---|
| Application icon | Original work, generated for this project, Apache-2.0 with the rest |
| Fonts | None bundled. The interface uses the platform system font stack |
| Sample drawings | **None in the repository.** The engine's demo generates its own synthetic set at runtime |

No customer drawing, consultant drawing or third-party document is in this repository, and none may
be added — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Corrections

If something here is wrong or missing, that is a bug worth reporting. Open an issue with the
component and the correct licence.
