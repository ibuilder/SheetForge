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
| No serious WCAG 2.1 A/AA violations **in this project's own interface**, including in forced colours | axe over the whole page, with a drawing open, and with the engine's known defects listed rather than excluded — see the gap below | `apps/ui/e2e/accessibility.spec.ts` |
| The register distinguishes a confirmed sheet number from a guessed one in text, not colour | Browser test asserts the word and the accessible name | `apps/ui/e2e/accessibility.spec.ts`, `apps/ui/e2e/open-drawing.spec.ts` |
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
| A drawing's own outline is listed and jumps to the page it names | Browser test against the tutorial sheet, which carries a real outline | `apps/ui/e2e/open-drawing.spec.ts` |
| A drawing with no outline shows no empty panel | Browser test against a document with no bookmarks | `apps/ui/e2e/open-drawing.spec.ts` |
| The page counter survives adversarial input and stays inside the domain ceiling | Property tests over generated near-miss PDF tokens, plus every prefix of each | `apps/desktop/src-tauri/src/commands.rs` |
| A file that is nothing but page markers stops rather than counting forever | Unit test against a file crafted to exceed the ceiling | `apps/desktop/src-tauri/src/commands.rs` |
| Counting pages stays linear in file size | 8 MB of non-matching bytes against a ceiling that catches a scan inside a scan | `apps/desktop/src-tauri/src/commands.rs` |
| What the engine reads off a title block is sent to the host as a guess, never as confirmed | Browser test inspects every row that crossed the boundary | `apps/ui/e2e/open-drawing.spec.ts` |
| A register row survives the round trip in both directions | 4 unit tests over the mapping, including absent-versus-empty | `apps/ui/test/mapping.test.ts` |
| Every command checks a capability or is named as exempt with a reason | The source checks itself, and the check was verified by removing a guard and watching it fail | `apps/desktop/src-tauri/src/commands.rs` |
| A revision comparison groups by cost code *and* unit, so a length is never added to an area | 12 domain tests over totalling and comparison | `crates/sf-domain/src/delta.rs` |
| The running takeoff on screen and the exported comparison cannot report different totals | A domain test asserting both paths return the identical `f64`, compared by its bits rather than within a tolerance | `crates/sf-domain/src/delta.rs` |
| A quantity re-derived at the same scale is not reported as a change | Domain test over a difference in the last few bits, and one over a difference worth pricing | `crates/sf-domain/src/delta.rs` |
| What a comparison left out is reported rather than dropped | The command counts underived and unconfirmed quantities separately | `apps/desktop/src-tauri/src/commands.rs` |
| An exported set opens with a legend, and the review tally counts sheets rather than markups | 6 unit tests over the summary, including that a redaction does not count as review | `apps/ui/test/legend.test.ts` |
| A dimension check grades agreement and names a familiar mistake rather than reporting a percentage | 8 domain tests over the bands, the signed direction, and the mistakes it will and will not name | `crates/sf-domain/src/scale_check.rs` |
| A dimension typed as `144'-6"` is read as 144.5, and `144'-13"` is refused | 11 unit tests over the forms people write on drawings | `apps/ui/test/scale-check.test.ts` |
| An attachment is content-addressed, so the same photo on three markups is stored once | Package test | `crates/sf-package/src/lib.rs` |
| An attachment altered on disk is refused rather than handed back | Package test rewrites the file and expects a failure | `crates/sf-package/src/lib.rs` |
| An attachment past the size limit is refused before anything is written | Package test checks the directory is still empty afterwards | `crates/sf-package/src/lib.rs` |
| A saved view survives a restart, and deleting one actually deletes it | Store round-trip test replacing the set, plus a browser test that the restore runs on open | `crates/sf-store/tests/store.rs`, `apps/ui/e2e/open-drawing.spec.ts` |
| A view whose zoom or centre could not be restored is refused rather than stored | Domain tests over non-finite, zero, negative and absurd values | `crates/sf-domain/src/view.rs` |
| A sheet number a machine guessed never overwrites one a person confirmed | Store test: an OCR re-read of `A-201` as `A-2O1` is rejected, and a person correcting it afterwards still lands | `crates/sf-store/tests/store.rs` |
| The register answers "which sheets are at Rev C?" across the project | Store test, case-insensitively and sorted by number | `crates/sf-store/tests/store.rs` |
| A project two schema versions behind reaches the current one | Migration test asks the schema itself rather than trusting the recorded version | `crates/sf-store/tests/migration.rs` |
| An extract is filed as a new revision recording what it came from | Store round-trip test, plus a browser test asserting the derivation and origin that crossed the boundary | `crates/sf-store/tests/store.rs`, `apps/ui/e2e/open-drawing.spec.ts` |
| A page selection is read the way people write one, and refused when it names a page that is not there | 8 unit tests over ranges, repeats, both ends, backwards ranges and malformed input | `apps/ui/test/assemble.test.ts` |
| A project written by the previous build still opens, with its data intact | Integration tests build a real version-1 database from the shipped migration and open it with the current build | `crates/sf-store/tests/migration.rs` |
| Opening twice does not run a migration twice | Integration test — `ADD COLUMN` fails on a second run, so a version recorded wrongly means a project that opens once and never again | `crates/sf-store/tests/migration.rs` |
| A project from a newer build is refused rather than half-understood | Integration test | `crates/sf-store/tests/migration.rs` |
| A recent project is named to the interface by a handle, never by a location | Rust test asserts no path component appears in what is serialised, plus a handle the host never issued resolves to nothing | `apps/desktop/src-tauri/src/recent.rs` |
| Opening a recent project sends a handle and nothing that could be a path | Browser test inspects what actually crossed the boundary | `apps/ui/e2e/open-drawing.spec.ts` |
| A project that has moved is listed and disabled rather than hidden | Browser test | `apps/ui/e2e/open-drawing.spec.ts` |
| A marked-up PDF is refused while redactions exist | Browser test asserts the refusal is shown and that nothing reached the host to be written | `apps/ui/e2e/redaction.spec.ts` |
| Redacted text is not in the exported file | Browser test searches the exported bytes for a string that exists nowhere else, on an uncompressed fixture so "absent" cannot mean "deflated" | `apps/ui/e2e/redaction.spec.ts` |
| A page nobody redacted keeps its text | Browser test, so the safe implementation and rasterising everything are distinguishable | `apps/ui/e2e/redaction.spec.ts` |
| The application packages into installers on Windows, macOS and Linux | A bundle job builds all three, weekly and on demand, and keeps what it produced | `.github/workflows/bundle.yml` |
| An issue status is stamped on the exported pixels, not just the filename | Browser test decodes the export and finds the stamp's colour on a drawing that has none of its own | `apps/ui/e2e/open-drawing.spec.ts` |
| Every sheet exports as one ZIP with an entry per page | Browser test reads the entry names out of the archive it produced | `apps/ui/e2e/open-drawing.spec.ts` |
| The markups reach the exported image, not just the screen | Browser test seeds a markup through the host, checks it is on screen, then decodes the exported PNG and finds its colour | `apps/ui/e2e/open-drawing.spec.ts` |
| The Windows installers actually build | `tauri build` run once on Windows: an MSI, an NSIS installer and an updater signature for each | local, not CI — see below |

**Totals: 285 Rust tests, 71 TypeScript unit tests, 46 browser tests.** The Rust figure includes
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
| ~~**The IPC seam is stubbed, not driven**~~ | *Closed 2026-08-25.* The packaged Windows build was installed and driven by hand through a full round trip: a markup drawn on the tutorial sheet, filed by `markup_create`, reported as saved, and exported back out as CSV carrying the id, sheet, page, type, status, discipline, author and RFC 3339 timestamps the domain minted. Two exports crossed the raw-bytes transport — a 2.6 MB PNG and the CSV — and both arrived intact. What this does not cover is every other command: the ones exercised were `tutorial_open`, `document_bytes`, `sheet_record`, `markup_create` and `export_save` | done |
| **The native file dialogs are not driven by any test** | They sit below the stub. Exercised by hand only | 0.2 |
| **The PDF parser itself is not fuzzed** | Path containment, format sniffing, size arithmetic, the audit chain and now the page counter have property tests generating thousands of inputs each, and one found a real defect. The page counter is the only PDF parsing this repository does, and it is covered; pdf.js — the parser that reads the document properly — is upstream and is not fuzzed by us. That is the part still open | 0.3 |
| **Rendering performance is unmeasured** | The *store* is now benchmarked against a realistic project — 5,000 markups over 200 sheets — with ceilings in CI that catch order-of-magnitude regressions, and the numbers are printed on every run. What is still unmeasured is the part users feel most: time to first page, tile latency at high zoom, and memory on a 200-sheet set | 0.3 |
| **Power loss is untested** | A committed write is now proven to survive the process being *killed* — a real child process, `TerminateProcess`/`SIGKILL`, no destructors. That proves SQLite committed, not that the platter did; testing the latter honestly needs hardware or a fault injector | 0.4 |
| **Built and run on Windows only** | macOS, Linux, iOS and Android are configured and compile in CI, but have not been run by a human | 0.2 |
| **Binaries are unsigned** | SmartScreen and Gatekeeper will warn | 0.2 |
| ~~**The raw-bytes export transport has not been driven through a real webview**~~ | *Closed 2026-08-25.* The packaged Windows application was installed and driven by hand: the tutorial opened, and a 300 DPI plot export of an ARCH D sheet was saved through the native dialog. The file on disk is 10800 x 7200 pixels and 2,751,432 bytes, and every one of its 673 PNG chunks passes its CRC with the stream consuming exactly the file's length — so a 2.6 MB payload crossed the real injected IPC as raw bytes without a byte changing. The suggested name and extension survived the percent-encoded headers intact, spaces included, and the native picker opened with both already filled in | done |
| **No installer has been run on a *clean* machine** | The NSIS installer has been installed **and uninstalled** on the machine that built it. It installs per-user to `%LOCALAPPDATA%\Programs\SheetForge`, writes a working Start menu shortcut, registers under `HKCU`, launches and renders — and removing it takes the binary, the shortcut and the registry entry, leaving the projects in `Documents` alone, which is the half that matters. Doing that found and fixed a real defect: it asked for administrator rights it did not need. What the build machine still cannot show is what a stranger sees, because Windows trusts output it compiled itself — SmartScreen's real first-run behaviour remains unobserved | 0.2 |
| **No release has been cut** | The release workflow has never run. It needs `TAURI_SIGNING_PRIVATE_KEY` in the repository secrets, without which every installed copy would be unable to update | 0.2 |
| **No third-party security review** | No audit, no penetration test | 1.0 |
| **An unsoundness advisory sits in the Linux dependency tree and cannot be fixed here** | `glib` 0.18.5 carries [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g), unsoundness in the `Iterator` impls for `VariantStrIter`, patched in 0.20. It is not a direct dependency: it arrives through the whole GTK3 stack Tauri binds on Linux — `gtk`, `webkit2gtk`, `gdk`, `pango` and neighbours — so reaching 0.20 means the gtk-rs 0.20 migration, which is upstream's to make and not something a patch here can force. Nothing in this workspace calls `VariantStrIter`, and the advisory is unsoundness rather than a remotely reachable defect, but it is listed rather than filtered out of view | upstream |
| ~~**Nothing checked the JavaScript dependencies for advisories**~~ | *Closed.* `cargo-deny` had gated the Rust half of the tree since the first commit and nothing gated the JavaScript half, which is how a high-severity arbitrary-execution advisory against pdf.js — the library that parses the hostile input — sat in the lockfile until GitHub mentioned it on a push. CI now runs `npm audit --audit-level=high` on every build, and the advisory is closed by raising pdf.js to 6.2.108 | done |
| **A redacted copy loses the source's bookmarks** | `copyPages` moves pages, not the document around them, so a redacted copy of a set with a discipline outline arrives with no outline. The output is at least named rather than blank. Nothing in the interface warns of this yet | 0.3 |
| **The drawing engine's own interface has serious accessibility defects** | Until this build, the accessibility suite had only ever tested the opening screen — no drawing open means none of the engine's toolbar or panels are mounted, so the previous claim that they were "included, not excluded" was wrong. Opening a drawing and scanning found two: three empty engine panels keep a `listbox` role, so a screen reader announces options that are not there (**critical**); and the drawing scroller cannot be focused, so scrolling it needs a pointer (**serious**). They are in a dependency and are not ours to fix. They are listed in the test rather than excluded from it, so a *new* defect still fails the build, and they should be reported upstream | 0.3 |
| **Attachments are stored but barely shown** | Photos and voice notes are filed in the project, content-addressed, size-limited and audited, and open in a tab on demand. What is missing is display: a markup carrying a photo does not show a thumbnail, because the stored reference is a hash rather than a URL the renderer can load, and turning it into one on load means fetching every attachment in the document. Lazy resolution is the next piece | 0.3 |
| ~~**The revision comparison has no interface**~~ | *Closed.* **Project ▾ → Compare quantities with…** runs it and writes the answer as CSV. It compares the open drawing against any other in the project rather than against "the previous issue", because every import creates its own document and that relationship does not exist in the store — so the control asks which drawing rather than offering one that is permanently unavailable. The browser suite drives the menu and parses the file the way a spreadsheet would, including a cost code containing a comma and a quotation mark. What is still missing is showing the answer *on screen*: today it leaves as a file | done |
| **No screen-reader testing** | Automated rule checking now runs on every build — axe over WCAG 2.1 A and AA, keyboard operation driven with real key presses, forced-colours and reduced-motion emulated — and it found a real ARIA defect on its first run. But automated tools catch perhaps a third of real barriers, and nobody who uses a screen reader has tried this | 1.0 |
| **Spatial accuracy on a drawing is a visual task** | No amount of markup makes placing a measurement on a sheet non-visual. Stated rather than solved | — |
| **OCR accuracy is not measured against real sheets** | The browser test proves the engine loads and reads clean lettering. How it copes with a dyeline scan of a 1974 drawing is unmeasured here, and the engine's own benchmark says the answer is "poorly on small text" | 0.3 |
| ~~**Migrations are tested at one version**~~ | *Closed.* There are two versions now, and the upgrade path is tested for real: a version-1 database is built from the shipped migration, opened by the current build, and checked for its data, its recorded version, a second open, and refusal of a version from the future | done |
| **The SBOM is not signed** | CI now produces a CycloneDX bill of materials over the resolved dependency tree on every run and keeps it for 90 days. Signing it, and attaching it to releases, is still outstanding | 0.3 |

## What this means for you

**Reasonable now:** trying it, reviewing a set, building it from source, contributing, evaluating
the architecture.

**Not yet:** depending on it for a contract deliverable without keeping your existing tool
alongside, or deploying it across an organisation.

The gaps above are the 0.2 milestone, in order.
