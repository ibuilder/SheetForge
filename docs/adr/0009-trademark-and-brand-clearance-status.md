# 0009 — "SheetForge" is uncleared

**Status:** Open risk · 2026-08-20

## Context

The name is in the repository, the binary, the installer, the window title, the package format
extension and the documentation site. It has had **no professional trademark clearance.**

Preliminary searching found no obvious conflict for "SheetForge" in construction software, and that
is worth very little. "Forge" is crowded across software and industrial products, and a preliminary
search is not a clearance: infringement turns on similarity of sound, appearance, meaning, trade
channels and relatedness of services, not on whether an identical string is registered.

For context on how easily this goes wrong, two earlier candidates for this product were dropped
after a few minutes of searching: **Planforge** is an established project-portfolio platform, and
**RIVET** is a construction workforce-management product. Both are close enough to this market to
be unusable.

## Decision

**Ship under the name, record the risk, and do not build brand equity on it until it is cleared.**

- No company registration, no domain portfolio, no trademark filing and no paid marketing under
  this name until counsel has signed off.
- The name is recorded here as an open risk rather than assumed to be fine.
- The rename cost is deliberately kept low: the name appears in configuration and documentation
  rather than being woven through the code. A rename is a find-and-replace plus a package-format
  extension migration, not a rewrite.

### What a real clearance has to cover

- Exact marks, spacing variants, plurals, phonetic equivalents, word stems, translations, and the
  dominant term alone.
- Live *and* dead records, in the software and software-services classes, in every market that
  matters.
- Common-law use: search engines, app stores, GitHub, domains, corporate registries, social
  handles, AEC directories.
- Similarity analysis, not exact-string matching.

Domain and handle availability are operational checks. They are not evidence of trademark rights
and must not be mistaken for it.

## What it costs

If clearance fails, the rename touches the repository, the bundle identifier, the package
extension, the documentation site and any release already published. Every day of adoption raises
that cost, which is the reason this is a live risk and not a footnote.

## What would resolve it

A written clearance opinion from qualified trademark counsel, and a decision on whether to file on
an intent-to-use or use-in-commerce basis. Then this record is updated to Accepted with the opinion
referenced.

**This document is not legal advice.**
