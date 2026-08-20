# Marking up drawings

How to review a construction drawing set in SheetForge: what each tool is for, what a markup
carries besides its shape, and how to get the result back out.

> **What this is not.** SheetForge does not edit the text and graphics inside a PDF. There is no
> "change this dimension to 3600" and there will not be. On a construction job the issued PDF is
> the governing document, and a tool that quietly rewrites it produces a drawing that no longer
> matches what the architect signed. Your markups live *beside* the drawing; the issued bytes stay
> byte-identical and are checked against their SHA-256 every time you verify the project.
>
> If you need to fill a form, redact a document, or re-typeset a page, that is a different tool and
> you should use one.

---

## 1. Start a project

**New project** creates a `.sfproj` folder wherever you point it. That folder *is* the project:
the drawings, the markups, the audit trail and the scales all live inside it. Zip it and send it,
put it on a network share, back it up with everything else — it is a folder, not a database you
have to export from.

**Add drawings** imports PDFs into it. Each one is:

- checked for size and sniffed to confirm it is really a PDF, before anything is written;
- filed under the SHA-256 of its bytes, so the same sheet arriving in two transmittals is stored
  once rather than twice under two names;
- recorded as a **revision** of a document, not as a file.

That last distinction is the one that pays off later. `A-201` is a document; the issue of it you
imported on 14 March is a revision. A markup is raised against the revision, so in six months you
can still say which drawing a comment was made on. See [Slip-sheeting](#7-when-a-sheet-is-re-issued).

---

## 2. The toolset

Pick a tool from the toolbar, draw on the sheet, press `Esc` to put it away.

### Shapes

| Tool | Use it for |
|---|---|
| **Rectangle**, **Ellipse** | Boxing an area of the drawing you are commenting on |
| **Polygon**, **Polyline** | Following a wall run, a slab edge, a routed service |
| **Line**, **Arrow** | Pointing at the thing you mean |
| **Freehand ink** | Sketching a fix in place. Stylus pressure is recorded even though the line draws at one width, so a future build can render variable width from markups you make today |
| **Revision cloud** | The one everybody uses. Real scalloped arcs, with the arc density adapting to the path length so a small cloud does not look like a different symbol from a large one |

### Text

| Tool | Use it for |
|---|---|
| **Text** | A note placed on the sheet |
| **Callout** | A note with a leader pointing at what it is about |
| **Highlight**, **Strikeout**, **Underline** | Marking *real text* on the sheet — a spec clause, a keyed note, a schedule row |

Highlight, strikeout and underline select actual glyphs, not a dragged box. A selection spanning
three lines records three quads and draws three bands, on screen and in the exported PDF, rather
than one block swallowing the margins. That is also what gives a specification citation something
to anchor to.

They need a text layer. A scanned sheet has none — see [OCR](#8-scanned-sheets).

### Construction

| Tool | Use it for |
|---|---|
| **Stamp** | `REVIEWED`, `FOR CONSTRUCTION`, `AS-BUILT` — dynamic, so date and author fill themselves in |
| **Symbol** | A reusable library symbol |
| **Issue pin** | A numbered issue that becomes a BCF topic or an RFI. Use this rather than a cloud when the thing needs *tracking*, not just noting |
| **Attachment** | A site photo or a file, anchored to a point on the sheet |

### Measurement

Covered in [Takeoffs](takeoffs.md).

---

## 3. What a markup carries

This is the part that separates a review desk from an annotator. Select a markup and the panel on
the right holds the fields a review actually runs on:

| Field | Why it is there |
|---|---|
| **Subject** | The one line that shows in the markup list. Write it as the thing to be done, not "see cloud" |
| **Note** | The body. Everything a reader needs to act without opening the drawing |
| **Status** | Where it sits in the review — see below |
| **Discipline** | Architectural, structural, MEP … Drives the colour, so the redline convention holds without anyone standardising a colour picker |
| **Assignee** | Who owns it |
| **Due date** | When it is needed by |
| **Trade / cost code** | The takeoff bucket it rolls into |
| **Labels** | Whatever your job needs to filter on — `level-4`, `bid-package-3` |
| **Spec citation** | A link to `07 84 00 §1.2.A`, not a string somebody typed |

Fill in the subject and the discipline at minimum. A markup list of forty items all reading
"Untitled" is the same as no markup list.

### Status is a workflow, not a label

```
        ┌──────────────────────────────────────────┐
        ↓                                          │
     ┌──────┐    ┌─────────────┐    ┌────────────┐ │  ┌────────┐
     │ Open │ ⇄  │ In progress │ ⇄  │ For review │ ─┴─▶│ Closed │
     └──────┘    └─────────────┘    └────────────┘    └────────┘
        ↑                                                  │
        └──────────────── reopen ──────────────────────────┘

     Anything can be voided (withdrawn — raised in error or superseded).
```

Two rules are enforced rather than suggested:

- **A closed item reopens at the start.** It cannot jump straight back into review, because that
  would skip the step where somebody says what is wrong with it.
- **Every move is recorded.** Status changes, assignments, comments, exports, deletions and
  revision migrations all become audit entries. See [the audit trail](#9-the-audit-trail).

If you move an accepted comment straight back to *in review*, SheetForge does it in two steps —
reopened, then sent back for review — and both appear in the trail. That is a more truthful record
than one entry claiming a move that never happened.

---

## 4. Working the set

**Filter.** The markup list is faceted: status, discipline, author, assignee, page, label. "Open
structural comments on Level 4" is three clicks, and the drawing dims everything else.

**Search.** One query across sheet text, markup content and the sheet register at once, kept
distinguishable in the results and located on the page. Phrase matching runs over the joined word
stream, so a phrase split across separate PDF text runs — the normal case — still matches.

**Saved views.** A page, a zoom, a position and a rotation you can return to or hand to somebody.

**Keyboard.** The whole review is keyboard-operable, because a reviewer works a set with one hand
on the keys:

| Key | Does |
|---|---|
| `Alt`+`←` / `→` | Step through the markups on this sheet, announcing where you are among them |
| Arrow keys | Nudge the selection, or aim a drawing cursor |
| `Space` | Place a point while drawing |
| `Enter` | Finish the shape |
| `Esc` | Put the tool away |
| `Ctrl`/`Cmd`+`Z` / `Shift`+`Z` | Undo / redo — every locally reversible markup action |

---

## 5. Tool sets

A company tool set fixes the colours, line weights, subjects, disciplines and custom fields your
organisation uses, so twelve reviewers produce markups that filter and roll up together instead of
twelve personal conventions. Set it once and hand it round with the project.

---

## 6. Getting it back out

| Export | What it is for | What travels with it |
|---|---|---|
| **Flattened PDF** | Sending the marked-up set to somebody with no SheetForge | Markups burned into the page, at the right size and place |
| **CSV / XLSX** | The markup register, or the takeoff, in a spreadsheet | Document revision, page, markup id, status, discipline, assignee, quantity, calibration and formula version |
| **XFDF** | Every other PDF review tool reads it | Full geometry, plus a namespaced payload carrying the structured fields XFDF has no vocabulary for — lossless back into SheetForge, silently ignored elsewhere |
| **BCF** | Round-tripping issues into the coordination model | Topics with a decodable sheet anchor, so an issue comes back able to re-place itself on a sheet plotted at a different size |

Every export is an audit event. An export is a disclosure, and it is exactly the act somebody asks
about later.

The destination is always chosen by a native save dialog. SheetForge's interface never gets to
name a path on your disk — see [the security model](../../SECURITY.md).

---

## 7. When a sheet is re-issued

Import the new issue as a revision of the same document, then open **Compare**.

The two issues are rasterised at a common resolution and **aligned** first. This matters: plot
origins drift between issues, and without correction a naive pixel difference reports the whole
drawing as changed. The differences are then clustered and can be turned into real revision clouds
in the markup store — with authorship and status, not a throwaway picture.

Then **migrate** your markups forward. Each one gets a verdict rather than being silently reapplied:

| Verdict | What it means | What happens |
|---|---|---|
| **Unchanged** | The drawing under it is the same | Carried forward |
| **Relocated** | The content moved; the markup moves with it | Carried forward, position adjusted |
| **Needs a human** | The content under it changed, or is gone | Held in a review queue for you to decide |

Carrying markups forward blindly is worse than losing them. A comment reading "verify this
dimension" sitting over a dimension that has since changed is actively misleading, and the queue
exists so that never happens quietly.

---

## 8. Scanned sheets

A scan has no text layer, so search, specification parsing and title-block extraction all return
nothing on it. Turn on OCR and SheetForge recognises the page, after which all three work.

Two things to know:

- **You choose the recogniser.** SheetForge owns the tiling, the coordinate mapping and the
  wiring; the engine is a setting, because whether your drawings may leave the building is not
  something this application can know. An on-device recogniser keeps everything local; a cloud
  service will be faster and more accurate and will send the page to somebody else.
- **Resolution decides the outcome.** Sheets are tiled before recognition, because OCR needs
  roughly 18–20 pixels of character height. The 1/8" lettering on an ARCH D sheet is about 9px if
  you rasterise the whole sheet at once, and 37px at 300 DPI — where the sheet is 78 megapixels and
  exceeds both mobile canvas limits and every cloud API's per-image cap.

Anything OCR reads is a **suggestion**, and SheetForge marks it as one. In particular, a scale read
off a title block is never treated as verified until you confirm it — see
[Takeoffs](takeoffs.md#where-the-scale-came-from).

---

## 9. The audit trail

Every gated act — created, edited, status changed, deleted, calibrated, exported, imported, and
every act that was *refused* — becomes an entry carrying who, what, when, and against which
revision and page.

The trail is hash-chained: each entry carries the digest of the one before it, and its own digest
covers both. Altering one entry, removing one, or reordering two breaks every digest after the
change, and **Check integrity** reports the first entry that fails.

That makes it *tamper-evident*, not tamper-proof. Somebody with write access to the folder can
still destroy the log; what they cannot do is quietly change one line of it and leave the rest
standing. For a record that may end up as contract evidence, that is the property that matters.
[SECURITY.md](../../SECURITY.md) is explicit about the limit and what would raise it.

---

## 10. If something goes wrong

**Check integrity** re-hashes every drawing in the project and verifies the audit chain. It reports
one of:

| Result | Meaning | What to do |
|---|---|---|
| Verified | Everything matches | Nothing |
| A drawing is missing | A file was moved or deleted out from under the project | Restore it from a backup |
| A drawing has been altered | Its bytes no longer match the hash the markups were made against | Do not trust the set. Restore from a backup and re-verify |
| The audit trail is broken at entry *n* | The chain does not verify from that point | Treat the trail as unreliable from *n* onward, and investigate |

Markups are written durably as you work, so an abrupt shutdown loses at most the last few seconds
of drawing rather than the session. Reopening the project picks up where you left off.

---

## Next

- [Takeoffs](takeoffs.md) — calibration, measurement and quantities that can be defended
- [Architecture](../architecture.md) — how it is built, and why
- [Security](../../SECURITY.md) — the boundary, and what it does and does not promise
