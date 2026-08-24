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
| No serious WCAG 2.1 A/AA violations, including in forced colours | axe over the whole page — the drawing engine's interface included, not excluded | `apps/ui/e2e/accessibility.spec.ts` |
| The store stays responsive on a 5,000-markup, 200-sheet project | Timed against ceilings that catch an order-of-magnitude regression; real figures printed each run | `sf-store/tests/scale.rs` |
| Every header control is reachable and visible by keyboard alone | Real tab presses, then a computed-style check for a focus indicator | `apps/ui/e2e/accessibility.spec.ts` |
| The frontend bundles under a strict CSP | Inherited from the engine's own CSP suite | upstream |
| The tutorial sheet is a genuine two-page PDF, not a stale or truncated asset | Rust test over the embedded bytes | `apps/desktop/src-tauri/src/commands.rs` |
| The tutorial's printed dimensions match the scale its title block claims | Rust test over the arithmetic the generator emits | `apps/desktop/src-tauri/src/commands.rs` |
| The committed tutorial sheet matches the script that generates it | CI regenerates it and fails on any difference | `.github/workflows/ci.yml` |
| The tutorial opens on a first run, and does not open itself again | Browser tests over both halves of the behaviour | `apps/ui/e2e/open-drawing.spec.ts` |
| A sheet exports as a real PNG at the resolution asked for | Browser test decodes the exported bytes and checks the PNG header and IHDR dimensions | `apps/ui/e2e/open-drawing.spec.ts` |
| An unmarked sheet exports with no colour on it | Browser test counts saturated pixels in the exported image | `apps/ui/e2e/open-drawing.spec.ts` |
| An export name with accents, an em dash or an emoji survives the ASCII header it travels in | Rust round-trip tests over what `encodeURIComponent` produces | `apps/desktop/src-tauri/src/commands.rs` |
| A malformed export name is refused rather than repaired | Rust tests over truncated, non-hex and non-UTF-8 escapes | `apps/desktop/src-tauri/src/commands.rs` |
| The markups reach the exported image, not just the screen | Browser test seeds a markup through the host, checks it is on screen, then decodes the exported PNG and finds its colour | `apps/ui/e2e/open-drawing.spec.ts` |
| The Windows installers actually build | `tauri build` run once on Windows: an MSI, an NSIS installer and an updater signature for each | local, not CI — see below |

**Totals: 220 Rust tests, 42 TypeScript unit tests, 28 browser tests.** The Rust figure includes
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
| **Rendering performance is unmeasured** | The *store* is now benchmarked against a realistic project — 5,000 markups over 200 sheets — with ceilings in CI that catch order-of-magnitude regressions, and the numbers are printed on every run. What is still unmeasured is the part users feel most: time to first page, tile latency at high zoom, and memory on a 200-sheet set | 0.3 |
| **Power loss is untested** | A committed write is now proven to survive the process being *killed* — a real child process, `TerminateProcess`/`SIGKILL`, no destructors. That proves SQLite committed, not that the platter did; testing the latter honestly needs hardware or a fault injector | 0.4 |
| **Built and run on Windows only** | macOS, Linux, iOS and Android are configured and compile in CI, but have not been run by a human | 0.2 |
| **Binaries are unsigned** | SmartScreen and Gatekeeper will warn | 0.2 |
| **The raw-bytes export transport has not been driven through a real webview** | Exports now cross to the host as a raw body rather than as a JSON array of numbers. The decoding either side is unit-tested, the payload and header shapes are the ones `@tauri-apps/api` declares, and the browser suite drives them against a stub that models the transport — but no test drives the actual injected IPC, because the browser suite stops at that seam by design. A first release should have somebody export a file from the packaged application before it is published | 0.2 |
| **Bundling runs in CI only at release** | The CI desktop job builds with `--no-bundle`, so the installer packaging — WiX, NSIS, the icon set, the licence file — is exercised only by the release workflow and by hand. It has been run once on Windows and produced both installers; the macOS and Linux bundles have never been produced at all | 0.2 |
| **No release has been cut** | The release workflow has never run. It needs `TAURI_SIGNING_PRIVATE_KEY` in the repository secrets, without which every installed copy would be unable to update | 0.2 |
| **No third-party security review** | No audit, no penetration test | 1.0 |
| **No screen-reader testing** | Automated rule checking now runs on every build — axe over WCAG 2.1 A and AA, keyboard operation driven with real key presses, forced-colours and reduced-motion emulated — and it found a real ARIA defect on its first run. But automated tools catch perhaps a third of real barriers, and nobody who uses a screen reader has tried this | 1.0 |
| **Spatial accuracy on a drawing is a visual task** | No amount of markup makes placing a measurement on a sheet non-visual. Stated rather than solved | — |
| **OCR accuracy is not measured against real sheets** | The browser test proves the engine loads and reads clean lettering. How it copes with a dyeline scan of a 1974 drawing is unmeasured here, and the engine's own benchmark says the answer is "poorly on small text" | 0.3 |
| **Migrations are tested at one version** | There is one schema version, so cross-version migration is untested by construction | when there are two |
| **The SBOM is not signed** | CI now produces a CycloneDX bill of materials over the resolved dependency tree on every run and keeps it for 90 days. Signing it, and attaching it to releases, is still outstanding | 0.3 |

## What this means for you

**Reasonable now:** trying it, reviewing a set, building it from source, contributing, evaluating
the architecture.

**Not yet:** depending on it for a contract deliverable without keeping your existing tool
alongside, or deploying it across an organisation.

The gaps above are the 0.2 milestone, in order.
