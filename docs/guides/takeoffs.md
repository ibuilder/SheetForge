# Takeoffs

Measuring a drawing so the number can be defended.

A quantity on a takeoff is a claim about a building, and an estimator who cannot answer *"where did
1,240 SF come from?"* cannot defend a bid. Everything in this guide exists to make that question
answerable six months later.

---

## 1. Set the scale first

**Nothing measures until the page is calibrated.** SheetForge will not guess, and it will not
quietly fall back to 1:1. An uncalibrated measurement reports as *underived* — a dash, not a
number — because a zero would be indistinguishable from a real measurement of nothing.

There are three ways to set it, and they are not equally trustworthy.

### Draw a known dimension — the strongest

Pick **Calibrate**, draw a line along something whose real length is printed on the sheet, and type
that length. Use the printed graphic scale bar if there is one, or an overall dimension string.

This is the only method that survives re-plotting. A sheet whose title block says `1/8" = 1'-0"`
may well have been plotted to fit A3 for a meeting, and the graphic scale bar shrank with the
drawing while the title block did not. The bar is the witness that still tells the truth.

If your hand-drawn calibration lands within 1.5% of a standard scale, SheetForge labels it as that
scale — so `1/8" = 1'-0"` shows as `1/8" = 1'-0"`, not as `0.111 ft/pt`.

### Choose a named preset — good, if the plot is true

`1/4" = 1'-0"`, `1:100`, and the rest. Fast and exact when the sheet was plotted at full size.

### Let OCR read the title block — a suggestion, never a fact

If the sheet has been recognised, SheetForge can offer the scale it read. It arrives marked
**provisional** and every quantity derived from it is flagged, until you confirm it. Confirming is
one click; it is a separate click on purpose.

> SheetForge never silently infers a measurement scale, and never presents an OCR-derived scale as
> verified. An unverified scale that quietly becomes authoritative is how a bid goes out wrong.

### One scale per page — not per document

A plan sheet and the enlarged detail beside it are different scales. A document-wide factor
produces confidently wrong numbers on half the set, and they look completely plausible. Calibrate
each page you measure on.

### Units

Set the unit when you calibrate: `ft`, `in`, `m`, `mm`. Imperial lengths render as feet and inches
— `12'-6 1/2"`, not `12.54 ft` — and typing accepts `12'-6"`, `6 1/2"`, `3/4"`, `300mm` or
`4 meters`.

---

## 2. Measure

| Tool | Measures | Scales with |
|---|---|---|
| **Distance** | A straight run between two points | the scale |
| **Polyline length** | A multi-segment run — a wall, a pipe route, a kerb line | the scale |
| **Perimeter** | The closed length around an area | the scale |
| **Area** | An enclosed region | the scale **squared** |
| **Volume** | An area times a depth or height you supply | the scale **cubed** |
| **Count** | A tally — doors, fixtures, sprinkler heads | nothing |
| **Angle** | An included angle in degrees | nothing |
| **Radius** | An arc radius | the scale |

That third column is not decoration. A page-space area scales by the *square* of the scale factor:
applying the factor once produces a number that looks like an area, is wrong by the whole scale
factor, and passes every eyeball check. SheetForge applies the right exponent per measurement kind,
and there is a test that says so.

Counts and angles need no scale at all, so they work on an uncalibrated page.

### While you draw

- Snap to angle with `Shift`.
- `Space` places a point, `Enter` finishes, `Backspace` removes the last point.
- A running total shows as you go.
- A measurement is a markup like any other, so it carries a subject, a discipline, an assignee and
  a cost code. That is how it rolls up.

---

## 3. Bucket it

Put a **cost code** (the engine calls it *trade*) on each measurement, or a takeoff **assembly**:
`03 30 00`, `09 Finishes`, `Bid package 3`. Then the roll-up groups by it, and the CSV lands in
your estimate already sorted rather than as 400 loose numbers.

Labels stack on top for anything the cost code does not capture — `level-4`, `phase-2`, `alternate`.

---

## 4. If the scale was wrong

Re-calibrate the page. **Every measurement on it re-derives.**

This is the single most useful property of the takeoff and it is worth understanding why it works.
A quantity is never stored as a bare number. It carries:

| It keeps | So that |
|---|---|
| The **raw page-space magnitude** — the geometry before any scale | the number can be recomputed from a new scale |
| The **calibration** it was derived through | you can see which scale produced it |
| The **formula version** | a number computed under an older rule can be identified rather than silently mixed in |
| Its **unit and precision** | the displayed value means what it says |
| Whether the scale was **verified** | an unconfirmed scale is visible on every number it produced |

So fixing a wrong scale is fixing the scale — not redrawing eighty measurements. And if a
calibration is removed, the quantities go back to *underived* rather than to zero: a visible state
you can act on, instead of a plausible number that is wrong.

---

## 5. Where the scale came from

Each quantity displays its provenance, and a **provisional** flag when the scale behind it has not
been confirmed by a human. Provisional numbers are meant to be visible: an unverified takeoff going
into a bid is a commercial risk, and somebody should get the chance to notice.

Check before you export:

- [ ] Every page you measured on is calibrated.
- [ ] No calibration is still marked provisional.
- [ ] Detail pages carry their own scale, not the plan's.
- [ ] Areas are in the unit you think they are — `ft²` is not `ft`.
- [ ] Counts and angles are on the page you meant, even though they ignore scale.

---

## 6. Export the numbers

**CSV** or **XLSX**, from the takeoff panel. Each row carries what makes it defensible:

| Column | |
|---|---|
| Markup id | Stable. The same row in next week's export is the same measurement |
| Document revision + page | Which issue of which sheet it was measured on |
| Kind | `area`, `distance`, `count` … |
| Raw page magnitude | The geometry before scale — lets anyone recompute your number |
| Calibration + verified | Which scale, and whether a human confirmed it |
| Value + unit + precision | The number as displayed |
| Formula version | Which computation produced it |
| Cost code, discipline, subject, author, status | The roll-up dimensions |

Anyone handed that spreadsheet can recompute every figure from the raw magnitude and the scale
without opening SheetForge. That is what "defensible" means in practice.

Every export is written to the audit trail.

---

## 7. Worked example

A second-floor plan, ARCH D, printed `1/8" = 1'-0"`, and you need the slab area.

1. **Calibrate.** Draw along the overall dimension string. It reads `144'-0"`; type `144'`.
   SheetForge computes ≈ `0.1111 ft` per PDF point and, being within 1.5% of a standard scale,
   labels the page `1/8" = 1'-0"`.
2. **Sanity-check it.** Measure a column bay you know is `30'-0"`. If it comes back `30'-0"`,
   the scale is right. If it comes back `15'-0"`, the sheet was plotted at half size and your
   calibration just saved the bid. *Do this every time.*
3. **Measure the slab.** Area tool, trace the perimeter, `Enter`. `12,480 SF`.
4. **Bucket it.** Cost code `03 30 00`, subject "L2 slab on metal deck", discipline structural.
5. **Export.** The CSV row carries `raw_page_magnitude = 1010880` page units², the calibration id,
   `verified = yes`, and the revision and page it came from.

Six months later, in a dispute about the quantity: the row names Rev C of sheet S-201 page 4, the
scale that was used, who confirmed it and when — and the audit trail shows nobody changed it since.

---

## 8. What this will not do for you

Stated plainly, because a takeoff tool that overclaims is worse than one that does less:

- **No automatic quantity extraction.** SheetForge does not read a drawing and tell you how many
  doors are on it. Automated measurement that has not been checked by a person is a number nobody
  can defend, and it is deliberately not in this version. See the
  [roadmap](../roadmap.md) for what is being considered and under what conditions.
- **No model-based quantities.** This measures drawings, not IFC models. Issues round-trip to the
  coordination model through BCF; quantities do not.
- **No estimating.** There is no cost database, no labour rate and no assembly pricing. The output
  is quantities, bucketed by cost code, for the estimating system you already have.
- **Accuracy is bounded by the drawing.** A measurement is exactly as good as the scale it was
  taken at and the drawing it was taken from. On a medium-resolution scan of an old drawing, that
  is a real limit and no amount of decimal places changes it.

---

## Next

- [Marking up drawings](editing-pdfs.md) — the review workflow around the measurements
- [Architecture](../architecture.md) — where measurement provenance is enforced, and how
