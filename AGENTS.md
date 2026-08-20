# SheetForge — engineering rules

Read this before changing anything. It is also `AGENTS.md`; the two are the same file.

## Mission

A secure, local-first construction PDF workspace: viewing, markup as structured records, calibrated
measurement with provenance, and durable local storage. Windows, macOS, Linux, iOS, Android.

Tauri 2, Rust core, TypeScript interface. Do not add Electron; see
[ADR-0001](docs/adr/0001-shell-selection-tauri-vs-electron.md).

## Before you change code

1. Read the README, the relevant ADR, the threat model and the existing tests for what you are
   touching.
2. Look at how it behaves now before proposing a replacement.
3. Work out the domain invariants, persistence implications, IPC contract changes, security
   effects and migration needs.
4. State your assumptions. Do not invent compatibility, performance, licensing or security claims.
5. For anything sourced from outside — code, an asset, a font, a document, a dependency — check
   provenance and licence first.

## Architecture rules

- Business rules go in `crates/sf-domain`, never solely in the interface or the command layer. A
  rule in a click handler is a rule the importer does not obey.
- Keep the interface, IPC, PDF engine, database, filesystem and crypto outside the domain core.
  Dependencies point inward.
- Markup geometry is **PDF user space**, never viewport pixels.
- `f64` for CPU coordinate and measurement arithmetic; `f32` only at the GPU boundary.
- Source PDFs are immutable and content-addressed. Markups and audit data live separately.
- UUIDv7 for identifiers. RFC 3339 UTC for timestamps, minted through `sf_domain::now()` so the
  in-memory value matches what is persisted.
- Version every persistent schema and IPC contract, and write the migration test.

## Security rules

- PDFs, attachments, imports, deep links and every IPC payload are hostile input.
- Enforce the limits in `sf-security`. Use bounded, cancellable background work.
- Never expose generic filesystem, shell, network or process access to the interface. No command
  takes a path — the native picker runs in Rust.
- Commands stay narrow, schema-validated, capability-checked and tested for the denial case.
- Never log document content, OCR text, markup text, paths, tokens, credentials or PII. There are
  tests asserting this; keep them passing rather than updating them.
- Do not weaken the CSP, the webview isolation or a capability to make a feature easier. Find
  another way or write an ADR.
- Audit exports, deletions, revision changes, role changes and refusals.

## Licensing rules

- No dependency, binary, font, icon, sample drawing or copied snippet without recording source and
  licence in `THIRD_PARTY_NOTICES.md`.
- Copyleft (GPL, LGPL, AGPL, SSPL, source-available, unknown) is refused, not reviewed. MuPDF is
  prohibited.
- Never put a customer or third-party drawing in fixtures, examples, screenshots, benchmarks or
  this repository.

## Quality rules

- Small, coherent, buildable, reviewable changes.
- A test with every behaviour change; a regression fixture with every parser or corruption defect.
- Do not block the UI thread.
- Do not silently discard work, merge conflicting edits without a policy, or report success after a
  partial failure.
- Undo and redo for every locally reversible markup action.
- Keyboard-operable, and never colour alone to carry meaning.
- Comments explain *why* — the decision, the rejected alternative, the failure mode being avoided.
  `crates/sf-domain/src/measurement.rs` is the house style.

## Before you say it is done

Run the formatter, the linter, the typechecker, the test suites and the licence checks. Report
exactly what ran and what did not, **including what you skipped and why**.

Do not describe anything as production-ready, secure, compliant, compatible or performant unless a
recorded test, review or measurement supports it. When part of a change is unverified, say which
part. [docs/status.md](docs/status.md) is the standard: it lists the gaps as prominently as the
guarantees.
