# 0010 — Assembling pages produces a new revision, never an edit

**Status:** Accepted · 2026-08-24

## Context

Every PDF tool that opens a drawing set can extract, reorder, rotate and merge pages. Reviewers ask
for it constantly, and the reasons are ordinary: pull the six mechanical sheets out of a 200-sheet
issue to send to the M&E subcontractor; put a revised sheet back in the right place; turn a section
that was plotted sideways.

The obvious implementation is the one every other tool uses — open the file, change the pages, save
it. That implementation is unavailable here, and the reason is the thing this record exists to fix
in place.

[ADR-0003](0003-project-package-and-local-data-model.md) makes source PDFs **immutable and
content-addressed**. A revision's identity *is* the SHA-256 of its bytes. Markups are anchored to a
revision. Verification rehashes every drawing and reports a mismatch as tampering. Slip-sheeting
compares one revision against another.

Editing a source in place breaks all four at once: the hash no longer matches, so verification
reports the user's own edit as corruption; markups are anchored to bytes that no longer exist; and
the drawing in the package stops being the drawing the architect issued — which is the single
property this application is built to preserve.

There is also a professional argument, and on a construction job it is the stronger one. The issued
PDF is the governing document. A tool that lets somebody remove three sheets from an issue and hand
on something still called "Issue C" has produced a forgery, whether or not anybody intended one.

## Decision

**Page assembly produces a new document revision. The source is never modified.**

Concretely:

1. The assembled PDF is built from the source's pages and imported as a **new revision**, hashed
   and stored like any other import. Both revisions exist afterwards.
2. The new revision records **what it was made from** — the originating revision and the operation
   — so the question "where did this come from?" has an answer six months later. That is a schema
   change, not a comment: `derived_from` and `derivation` on `document_revisions`.
3. The derivation is **audited**, like an export and for the same reason: it is the act of
   producing a document that leaves the review.
4. Markups do **not** follow automatically. Pages have moved, and a comment anchored to page 14 of
   the source is not a comment about page 3 of the extract. The existing slip-sheet machinery —
   which gives each markup a verdict of unchanged, relocated, or *needs a human* — is the right
   answer, and until it is wired to this path the derived revision starts clean.
5. The new revision is **named for its derivation**, not silently given the source's name. Two
   documents in one project called `A-201` with different page counts is a trap.

### Why not offer an in-place mode as well

Because the failure is silent and the blast radius is the whole product. A user who edits in place
sees nothing wrong until verification reports tampering — at which point the audit trail is
telling them their project is corrupt when in fact they used a feature. Every argument for the
convenience is an argument for making the derived path fast, not for having two.

## Consequences

**Good.** Verification keeps meaning what it says. Markups keep their anchors. The original issue
survives in the package, so an extract can always be traced back to what it was cut from — which is
exactly the provenance a dispute turns on.

**The cost.** Disk: an extract of six sheets from a 200-sheet set stores the extract as well as the
original. That is the correct trade — the original is the evidence — but it is a real cost on a
large job and it is not hidden.

**Also a cost.** The sheet register gets busier. A project where somebody extracts frequently
accumulates derived revisions, and the interface will need to distinguish "issued" from "derived"
rather than listing them as equals. That is a real design problem and it is deferred, not solved
here.

**A migration.** `document_revisions` gains two columns, which makes this the first schema change
since the format existed — and therefore the first exercise of the forward-only migration path that
[ADR-0003](0003-project-package-and-local-data-model.md) specified and nothing had yet tested.

## Alternatives considered

**Edit in place, and re-hash.** Rejected. It makes the content hash a record of the last edit
rather than of the issued document, which removes the ability to say "these bytes are what the
architect sent" — the property everything else here is built on.

**Keep the assembly in memory and only ever export it.** Tempting, and genuinely simpler: no
schema change, no register clutter. Rejected because an assembled document nobody can mark up is
half a feature — the reason to extract the mechanical sheets is usually to review them — and
because an export with no record of what it came from is exactly the provenance gap this project
exists to close.

**Store the recipe rather than the bytes** — "pages 4, 7 and 12 of revision X" — and rebuild on
demand. Attractive on disk, and rejected on identity: a document with no bytes has no hash, so it
cannot be verified, cannot be sent, and cannot be the thing a markup is anchored to. It also fails
the moment somebody wants to hand the extract to a subcontractor.
