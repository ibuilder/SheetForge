# Contributing

Thank you — genuinely. A free alternative to per-seat construction software only exists if people
build it.

## The one rule with no exceptions

**Never commit a real project document.**

Not a customer's drawings, not a consultant's, not one you found online, not one with the title
block cropped off. Not in fixtures, not in tests, not in a screenshot, not in an issue attachment,
not in a benchmark.

Test fixtures are synthetic (the drawing engine generates its own sample set), open-licensed with
the licence recorded, or documents you have **written authorisation** to use. If you are not sure,
the answer is no.

This is not pedantry. Drawings carry client names, addresses, security details of real buildings,
and somebody else's copyright.

## Getting set up

Needs Node 20.11+, Rust 1.82+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
for your platform.

```bash
git clone https://github.com/ibuilder/SheetForge.git
cd SheetForge
npm install
npm run desktop:dev
```

## Before you open a pull request

```bash
npm run check                                        # typecheck, lint, unit tests
cargo test --workspace                               # Rust tests
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

CI runs all of these plus a licence policy check and CodeQL. Warnings are errors; that is
deliberate, and it is why the tree is clean.

## What a good change looks like

**Small, coherent, buildable, reviewable.** One concern per pull request.

**With a test.** Every behaviour change. For a parser, rendering or data-corruption defect, a
regression fixture as well — that class of bug comes back.

**Rules in the domain, not in the interface.** A rule enforced in a click handler is a rule the
importer does not obey. Business logic belongs in `crates/sf-domain`; the command layer validates,
authorises, calls, and maps.

**Comments that say why, not what.** The code already says what it does. Explain the decision, the
alternative you rejected, the failure mode you are avoiding. `crates/sf-domain/src/measurement.rs`
is the house style.

**Honest claims.** Do not describe something as secure, performant, compatible or production-ready
unless a recorded test, review or measurement says so. If part of your change is unverified, say
which part.

## Things that will be sent back

- A markup rule that lives only in the interface.
- Geometry stored in viewport pixels rather than PDF user space.
- A silently-inferred measurement scale, or a quantity without its provenance.
- A new command that accepts a filesystem path, or a widened capability, to make a feature easier.
- Document text, markup text, paths, tokens or PII in a log line or an error message.
- A dependency added without recording its source and licence, or any copyleft licence
  (GPL, LGPL, AGPL, SSPL, source-available) — see
  [ADR-0008](docs/adr/0008-open-source-license-and-sbom-policy.md).
- Blocking the UI thread.
- Reporting success after a partial failure.

## Dependencies

Adding one is a decision, not a convenience. Record source, version, licence and notice obligation
in `THIRD_PARTY_NOTICES.md` in the same pull request. Copyleft is refused rather than reviewed.

## Reporting a bug

Include: what you did, what happened, what you expected, your OS and application version, and
whether the drawing was vector or scanned. A **synthetic** file that reproduces it is worth more
than a description — and see the rule at the top.

## Security

Do not open a public issue. [SECURITY.md](SECURITY.md) has the private channel.

## Licence and provenance

Contributions are licensed under [Apache-2.0](LICENSE). By opening a pull request you confirm you
wrote the contribution or have the right to submit it, and that it carries no obligation
incompatible with Apache-2.0.

If you used an AI assistant, that is fine — review it as your own work before submitting, and do
not submit generated code you have not read and tested. The same rule applies to icons, copy and
sample data.

## Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Briefly: be decent, critique the work rather than the
person, and remember that a construction professional filing a bug is not obliged to know how a
hash chain works.
