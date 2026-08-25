# 0011 — Count symbols from the vector content, not from pixels

**Status:** Proposed · 2026-08-25

## Context

Selecting a symbol once and counting every instance of it across a set is the largest single time
saving available in a takeoff. It is the feature every competitor advertises, and the one an
estimator asks for first: *how many of these are there?*

Every tool that offers it reaches for computer vision. Bluebeam's VisualSearch, and the AI symbol
detection layered on it, work on the rendered page; the open-source projects in this space use
YOLO. That is a reasonable choice if you treat a drawing as pixels.

We do not. The same instinct that reads the sheet register out of title blocks rather than
filenames applies here: a construction PDF is usually **vector**, and the structure is right there.

### What a repeated symbol actually is

A vector producer does not re-emit a symbol's geometry at each position. It emits the geometry
once, in the symbol's own local coordinates, and places each instance with a **transform**. So:

- the path data of every instance is byte-identical in local space;
- the position, rotation, scale and mirroring all live in the current transformation matrix;
- the paths belonging to one instance are exactly the paths drawn under one matrix.

That makes counting a matching problem over local geometry, with the matrix carrying placement —
not a recognition problem over pixels.

### Evidence

Spiked in `scripts/symbol-spike/`, which is committed so the claim can be re-run rather than taken
on trust. A synthetic plan is printed to PDF **through Chromium** — an independent producer, not
this repository emitting its own operators, which is the only way to test whether the technique
survives somebody else's serialisation.

The plan deliberately contains the cases expected to break it. Result:

| Symbol | Instances | Recovered |
|---|---|---|
| Door — leaf, swing, jamb | 6 | all, as **one** symbol of three paths, at 0°, 90°, 180°, 270° and two mirrored |
| Duplex receptacle | 14 | all, as one symbol of two paths |
| Grid bubble | 8 | all |
| Non-repeating linework | — | correctly singletons |

31 placed groups resolved to 6 distinct symbols. Nothing was unreadable. Recovered spacings were
exactly 0.75 of the source's, which is the 96-to-72 unit conversion — so the positions are right,
not merely self-consistent.

**This disproved the concern recorded when the idea was first written down.** Rotation and mirroring
were expected to defeat matching. They do not, and the reason is the useful part: the geometry never
rotates, the matrix does.

## Decision

**Count symbols by matching local path geometry, grouped by shared transform, with computer vision
reserved for scanned sheets.**

- A **symbol** is the set of paths drawn under one matrix, hashed together in order.
- An **instance** is one such group whose hash matches another's.
- **Placement** — position, rotation, mirroring — is read from the matrix, and reported *relative to
  the page's own base matrix*. PDF space is y-up; against a y-down source, an absolute reading calls
  every instance mirrored.
- Orientation is **reported, not collapsed**. "Six doors" and "the four turned 90°" are both real
  questions, and which one is wanted is the reader's to decide, not ours to bake in.
- A page with no vector content is a scanned page, and falls through to the OCR path that already
  exists. Nothing here replaces that.

### Why this over a model

- **The count is exact and re-derivable.** A confidence score is not something that can go in an
  audit chain. This is the same argument as `raw_page_magnitude`: a quantity has to be defensible
  later, not merely plausible now.
- **It ships no model weights.** The better recogniser in the roadmap is blocked on precisely that
  packaging problem — `onnxruntime-web`'s assets dwarf everything else the application ships.
- **No provenance question.** A trained model has a licence and a training set, and ADR-0008 refuses
  what cannot be established. Weights are exactly the kind of artefact whose provenance is murky.

## Consequences

### Accepted

- **Near-identical is not identical.** A symbol whose instances differ by a rounded coordinate will
  hash differently and count as two. Tolerant matching is a later refinement and a later risk: the
  moment two shapes are "close enough", the count stops being exact, which is the property this
  design exists to protect. Ship exact matching first and let the count be honestly low rather than
  quietly wrong.
- **Grouping by shared matrix is a heuristic.** Two unrelated paths drawn under one matrix become
  one "symbol". On the spike's control linework this produced a singleton, which is harmless, but a
  densely nested drawing may group things a person would not.
- **A symbol drawn at two scales is two symbols**, because the local geometry differs. Whether that
  is right depends on the drawing; it is at least predictable.

### Open, and blocking acceptance

**Chromium is a real producer, but it is not a CAD exporter.** Whether AutoCAD, Revit and the plot
drivers in common use serialise symbols the same way is unverified, and it is the question this ADR
turns on. If they re-emit geometry per instance with per-instance rounding, exact matching degrades
badly and the design needs rethinking rather than tuning.

Confirming it requires a CAD-exported set. Under the house rules a customer or third-party drawing
must never enter this repository, and that is not negotiable for a convenience. The honest options
are to obtain a genuinely public-domain or openly-licensed drawing set whose provenance can be
recorded in `THIRD_PARTY_NOTICES.md`, or to have somebody run the spike against their own drawings
and report the counts without the file ever being committed.

**Until that is answered this ADR stays Proposed, and no feature is built on it.**

## Alternatives considered

- **Template matching on the rendered page.** Works on scanned and vector alike, and is what the
  fallback path would use. Rejected as the primary because it is approximate by construction, needs
  a tolerance nobody can defend in an audit, and is far slower on a D-size sheet at plot resolution.
- **A trained detector (YOLO or similar).** What the competition does, and genuinely better at
  scanned sheets and at symbols that vary. Rejected as the primary on packaging, provenance, and the
  audit-chain argument above. Worth revisiting for the scanned fallback if the OCR packaging
  question is ever settled.
- **Form XObject names.** Simplest of all where a producer uses them — but the spike's producer used
  none, and a technique that only works on some producers is one that fails silently on the rest.
