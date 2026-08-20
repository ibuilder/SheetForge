# 0008 — Apache-2.0, and no copyleft in the dependency tree

**Status:** Accepted · 2026-08-20

## Context

The product is free and open. The licence still has to be chosen deliberately, because it decides
who can adopt it.

Candidates: MIT, Apache-2.0, GPL-3.0, AGPL-3.0.

## Decision

**Apache-2.0** for SheetForge itself.

- **Over MIT:** an express patent grant and a patent-retaliation clause. In construction software,
  where the buyer is often an enterprise with a legal review, "does this carry a patent grant" is a
  question that gets asked and MIT's silence is a real friction.
- **Over GPL/AGPL:** the goal is for contractors, consultancies and public bodies to *use* this,
  including inside their own internal tooling. A copyleft licence makes an enterprise legal review
  a gate rather than a formality, and the practical result is that the people who most need a free
  alternative do not get to use it. The freedom to fork it commercially is a cost we accept for
  that reach.

### Dependency policy

**No copyleft anywhere in the shipped tree.** GPL, LGPL, AGPL, SSPL, source-available and
custom-or-unknown licences are refused, not reviewed case by case, because a permissive
distribution with one AGPL component is not a permissive distribution.

Enforced in CI rather than by discipline:

- Rust: `cargo deny` with an allow-list.
- npm: a licence check over the installed tree.
- Both fail the build; neither warns.

Every dependency, bundled binary, font, icon and sample file records source, version, licence and
notice obligation in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

The consequential application: **MuPDF is prohibited**, which is why
[ADR-0002](0002-pdf-rendering-engine-and-license-decision.md) chose pdf.js.

## What it costs

- Somebody can take this, close it, and sell it. That is the deal, and it is the deal that makes
  the reach possible.
- Some excellent AGPL libraries are unavailable to us.
- CI is slower by the length of two licence scans.

## What would reverse it

A change of goal — if the project ever needed to prevent a proprietary fork more than it needed
enterprise adoption. Relicensing would need every contributor's agreement, which is itself an
argument for getting this right now.
