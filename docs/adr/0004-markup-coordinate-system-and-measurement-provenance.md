# 0004 — PDF user space, and quantities that carry their provenance

**Status:** Accepted · 2026-08-20

## Context

Two decisions that look like implementation detail and are actually the product.

**Coordinates.** A markup drawn at 400% on a 4K monitor has to appear in the same place at 100% on
a laptop, after a rotation, in a flattened PDF, and on a re-plotted A3 copy.

**Quantities.** An estimator who cannot answer "where did 1,240 SF come from?" cannot defend a bid.

## Decision

### Geometry is PDF user space

1/72 inch, top-left origin, unrotated — the space pdf.js reports at scale 1. Never viewport pixels,
which are correct at exactly one zoom on one monitor. Rotation, crop box, media box and user units
are modelled explicitly rather than assumed away.

`f64` for all CPU coordinate and measurement arithmetic; `f32` only at the GPU submission boundary.
Every annotation additionally carries a 0..1 anchor within the page box, so a different renderer can
place it without knowing the page geometry.

PDF export delegates the conversion to pdf.js's own `convertToPdfPoint` rather than hand-rolling a
y-flip. A hand-rolled flip is correct only when CropBox equals MediaBox and `/Rotate` is 0, and it
fails silently on exactly the scanned and re-plotted sheets that most need reviewing.

### A quantity is never a bare number

It carries the raw page-space magnitude, the calibration that converted it, the formula version, the
unit and precision, and whether the scale was verified by a human. Four properties follow:

1. **Re-calibrating a page re-derives every quantity on it.** The magnitude survives, so a page
   whose scale was wrong is fixed by fixing the scale, not by redrawing the takeoff.
2. **An uncalibrated measurement is *underived*, not zero.** A zero is indistinguishable from a
   real measurement of nothing.
3. **The scale exponent matches the dimensionality.** An area scales by the factor *squared*.
   Applying it once yields a number that looks like an area, is wrong by the whole scale factor,
   and passes every eyeball check. This is the most expensive silent bug a takeoff tool can have.
4. **An unverified scale is visible on every number it produced.** An OCR-read scale is provisional
   until a human confirms it, and the flag travels with the quantity.

Calibration is **per page**, never per document: a plan sheet and its enlarged detail are different
scales, and a document-wide factor is confidently wrong on half the set.

## What it costs

- Storage per quantity is larger than a float. Irrelevant next to what it buys.
- Applying page 2's calibration to a page 1 measurement is a hard error rather than a warning,
  which occasionally surprises a caller. That is the correct direction to fail in.
- The formula version must be bumped by hand when a computation changes, and forgetting is not
  caught automatically. A real gap.

## What would reverse it

Nothing about the coordinate decision; the format forces it.

The provenance model would only change by growing — a per-quantity confidence interval for scans,
where resolution genuinely bounds accuracy.
