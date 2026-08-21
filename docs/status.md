# Status: what is verified, and what is not

Version 0.1.0 · 2026-08-20

The README calls this early. This page says exactly how early, because "production-ready" and
"secure" are claims that need evidence behind them and this project does not make them without it.

## Verified, and how

| Claim | Evidence | Where |
|---|---|---|
| Domain invariants hold | 60 unit tests | `crates/sf-domain` |
| An area scales by the square of the factor, a volume by the cube | Asserted against a known drawing geometry | `sf-domain/src/measurement.rs` |
| Re-calibrating a page re-derives its quantities without redrawing | Unit test, and a store round-trip test | `sf-domain`, `sf-store` |
| An uncalibrated measurement is underived, not zero | Unit test | `sf-domain/src/measurement.rs` |
| A calibration from another page is refused | Unit test | `sf-domain/src/measurement.rs` |
| Illegal status transitions are refused | Unit tests, at the domain and at the store | `sf-domain`, `sf-store` |
| A stale write is refused and leaves the record untouched | Store integration test | `sf-store/tests/store.rs` |
| Tampering with the audit trail is detected | 18 unit tests, including a forged entry that fixes its own hash | `sf-audit` |
| The audit trail cannot be updated or deleted, even by raw SQL | Store integration test against a real file | `sf-store/tests/store.rs` |
| A committed write survives an abrupt close | Store integration test (leaked connection, no checkpoint) | `sf-store/tests/store.rs` |
| A committed write survives the process being killed | A real child process is spawned, commits, and is terminated with no chance to clean up | `sf-store/tests/crash.rs` |
| No generated path escapes the project package | Property test over thousands of adversarial strings; found and fixed a real defect | `sf-security/tests/hostile_input.rs` |
| Any tampering with the audit trail is detected | Property test over generated chains and generated edits, including re-signing the forged entry | `sf-audit/tests/tamper.rs` |
| Re-calibrating equals measuring at the new scale from the start | Property test over generated kinds, magnitudes and scale factors | `sf-domain/tests/invariants.rs` |
| A drawing altered on disk fails verification | Package test | `sf-package` |
| A missing drawing reports as missing, not as corrupt | Package test | `sf-package` |
| An engine record round-trips verbatim, including unknown fields | UI mapping test | `apps/ui/test/mapping.test.ts` |
| The status path never proposes a step the host would refuse | Exhaustive test over every pair | `apps/ui/test/mapping.test.ts` |
| Path traversal and symlink escape are refused | 28 unit tests | `sf-security` |
| Windows device names and unrepresentable filenames are refused on every platform | Unit tests | `sf-security` |
| No error message crossing the boundary carries a path, filename or SQL | Tests in three crates | `sf-domain`, `sf-store`, `sf-package`, `commands` |
| The desktop application builds and launches on Windows | Built and run; window opens and closes cleanly | — |
| A drawing opens and actually rasterises | Browser test against the built bundle, asserting non-blank pixels on the page canvas | `apps/ui/e2e/open-drawing.spec.ts` |
| The engine's toolset is installed, not just a page renderer | Browser test asserts the toolbar mounts | `apps/ui/e2e/open-drawing.spec.ts` |
| Opening a PDF needs no project set up first | Browser test drives the empty state through to a rendered drawing | `apps/ui/e2e/open-drawing.spec.ts` |
| Export is reachable by name, not only as an unlabelled glyph | Browser test opens the menu and finds each exporter | `apps/ui/e2e/open-drawing.spec.ts` |
| OCR runs entirely from bundled files, with nothing off-origin | Browser test recognises real pixels with every non-origin request blocked | `apps/ui/e2e/ocr.spec.ts` |
| A dropped drawing opens, and the interface never sees a path | Browser test pushes the host's drop event through a faithful IPC stub | `apps/ui/e2e/open-drawing.spec.ts` |
| The XLSX summary is a workbook Excel will actually open | 18 unit tests over the written parts, unpacked and inspected with a separate zip reader | `apps/ui/test/xlsx.test.ts` |
| The frontend bundles under a strict CSP | Inherited from the engine's own CSP suite | upstream |

**Totals: 204 Rust tests, 42 TypeScript unit tests, 10 browser tests.** The Rust figure includes
property tests that generate thousands of inputs each — path containment, format sniffing, audit
tampering, and measurement arithmetic — so the number of *cases* exercised is far higher. Clippy clean at `-D warnings` with pedantic lints
on; `cargo fmt` clean; TypeScript strict with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`; ESLint clean on type-checked rules.

The drawing engine brings its own suite: 381 unit tests plus a Playwright suite across Chromium,
WebKit and Firefox covering rasterisation, the pointer gesture loop, touch and pen, keyboard
operation, the compare pipeline and a strict-CSP load.

## Not verified

Listed because omitting them would make the table above dishonest.

| Gap | Why it matters | Tracked |
|---|---|---|
| **The IPC seam is stubbed, not driven** | The browser suite mocks `invoke` at the Tauri boundary, so everything above it is real code and everything below it — the commands, the dialogs — is covered only by Rust tests and by hand. A test that drives the packaged application has not been written | 0.2 |
| **The native file dialogs are not driven by any test** | They sit below the stub. Exercised by hand only | 0.2 |
| **The PDF parser itself is not fuzzed** | Path containment, format sniffing, size arithmetic and the audit chain now have property tests generating thousands of inputs each, and one found a real defect. pdf.js itself — the actual parser — is upstream and is not fuzzed by us | 0.3 |
| **No performance measurement** | No published budget for time-to-first-page, tile latency or memory on a large set. Nothing here claims performance | 0.2 |
| **Power loss is untested** | A committed write is now proven to survive the process being *killed* — a real child process, `TerminateProcess`/`SIGKILL`, no destructors. That proves SQLite committed, not that the platter did; testing the latter honestly needs hardware or a fault injector | 0.4 |
| **Built and run on Windows only** | macOS, Linux, iOS and Android are configured and compile in CI, but have not been run by a human | 0.2 |
| **Binaries are unsigned** | SmartScreen and Gatekeeper will warn | 0.2 |
| **No third-party security review** | No audit, no penetration test | 1.0 |
| **Accessibility is implemented, not verified** | Keyboard operation and semantics are built in and partly tested upstream; no screen-reader testing has been done here | 1.0 |
| **OCR accuracy is not measured against real sheets** | The browser test proves the engine loads and reads clean lettering. How it copes with a dyeline scan of a 1974 drawing is unmeasured here, and the engine's own benchmark says the answer is "poorly on small text" | 0.3 |
| **Migrations are tested at one version** | There is one schema version, so cross-version migration is untested by construction | when there are two |
| **The SBOM is not signed** | CI now produces a CycloneDX bill of materials over the resolved dependency tree on every run and keeps it for 90 days. Signing it, and attaching it to releases, is still outstanding | 0.3 |

## What this means for you

**Reasonable now:** trying it, reviewing a set, building it from source, contributing, evaluating
the architecture.

**Not yet:** depending on it for a contract deliverable without keeping your existing tool
alongside, or deploying it across an organisation.

The gaps above are the 0.2 milestone, in order.
