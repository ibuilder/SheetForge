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
| A drawing altered on disk fails verification | Package test | `sf-package` |
| A missing drawing reports as missing, not as corrupt | Package test | `sf-package` |
| An engine record round-trips verbatim, including unknown fields | UI mapping test | `apps/ui/test/mapping.test.ts` |
| The status path never proposes a step the host would refuse | Exhaustive test over every pair | `apps/ui/test/mapping.test.ts` |
| Path traversal and symlink escape are refused | 28 unit tests | `sf-security` |
| Windows device names and unrepresentable filenames are refused on every platform | Unit tests | `sf-security` |
| No error message crossing the boundary carries a path, filename or SQL | Tests in three crates | `sf-domain`, `sf-store`, `sf-package`, `commands` |
| The desktop application builds and launches on Windows | Built and run; window opens and closes cleanly | — |
| The frontend bundles under a strict CSP | Inherited from the engine's own CSP suite | upstream |

**Totals: 166 Rust tests, 24 TypeScript tests.** Clippy clean at `-D warnings` with pedantic lints
on; `cargo fmt` clean; TypeScript strict with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`; ESLint clean on type-checked rules.

The drawing engine brings its own suite: 381 unit tests plus a Playwright suite across Chromium,
WebKit and Firefox covering rasterisation, the pointer gesture loop, touch and pen, keyboard
operation, the compare pipeline and a strict-CSP load.

## Not verified

Listed because omitting them would make the table above dishonest.

| Gap | Why it matters | Tracked |
|---|---|---|
| **No end-to-end test through the real application** | The Rust and TypeScript halves are each tested; the seam between them is exercised by hand, not by CI | 0.2 |
| **No fuzzing of hostile PDF input** | Bounds are unit-tested; the parser is not fuzzed. Largest security gap | 0.2 |
| **No performance measurement** | No published budget for time-to-first-page, tile latency or memory on a large set. Nothing here claims performance | 0.2 |
| **Crash recovery is simulated, not real** | The durability test leaks a connection; it does not kill the process or cut power | 0.2 |
| **Built and run on Windows only** | macOS, Linux, iOS and Android are configured and compile in CI, but have not been run by a human | 0.2 |
| **Binaries are unsigned** | SmartScreen and Gatekeeper will warn | 0.2 |
| **No third-party security review** | No audit, no penetration test | 1.0 |
| **Accessibility is implemented, not verified** | Keyboard operation and semantics are built in and partly tested upstream; no screen-reader testing has been done here | 1.0 |
| **Migrations are tested at one version** | There is one schema version, so cross-version migration is untested by construction | when there are two |
| **No SBOM** | Licence policy is enforced in CI; a signed bill of materials is not produced | 0.2 |

## What this means for you

**Reasonable now:** trying it, reviewing a set, building it from source, contributing, evaluating
the architecture.

**Not yet:** depending on it for a contract deliverable without keeping your existing tool
alongside, or deploying it across an organisation.

The gaps above are the 0.2 milestone, in order.
