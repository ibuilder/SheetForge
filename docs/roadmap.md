# Roadmap

What is next, and — more usefully — what is deliberately not coming.

No dates. This is an early open-source project and a date would be a guess dressed as a commitment.
Order within a milestone is roughly the order things will be done.

---

## 0.2 — Make the first release trustworthy

Nothing new. The gap between "it works" and "you can depend on it."

- **Code signing.** An organisation certificate for Windows and an Apple Developer identity for
  macOS, with keys in an HSM or cloud signing service. Ends the SmartScreen and Gatekeeper warnings
  and is the single biggest barrier to anyone installing this at work.
- **A hostile-PDF fuzzing corpus** wired into CI. The largest security gap today.
- **An installer smoke test in a clean VM** as a release gate, per platform. Half of this now
  exists: a bundle job builds installers on Windows, macOS and Linux weekly and on demand, which is
  what caught that the macOS and Linux bundles had never been produced by anything. Installing one
  and seeing what the operating system says is the half CI cannot do.
- **Performance budgets, measured**, on real hardware and a real drawing set: time to first page,
  tile latency at 800%, memory on a 200-sheet set. Then published, and failed against.
- **Crash recovery, tested by killing the process**, not by dropping a connection.
- ~~**Raw bytes for exports.**~~ *Done.* Exports crossed to the host as a JSON array of numbers,
  about five characters per byte to build, send and parse — unnoticeable for a spreadsheet, and
  150 MB of string for a 30 MB image, on the thread that draws the window. They now travel as a raw
  body with the name and extension as percent-encoded headers, matching the raw response
  `document_bytes` already returns in the other direction. The size refusal that stood in for the
  fix is gone. Not yet driven through a real webview — see [status](status.md).
- **Trademark clearance** for the name. See
  [ADR-0009](adr/0009-trademark-and-brand-clearance-status.md).

### Done since this was written

- **The diagnostic report** ADR-0007 promised in place of telemetry. Plain text, under Project →
  Save diagnostic report: build and machine facts, the limits in force, counts from the open
  project, and the redacted tail of the log. It reports *counts rather than contents* — "14
  drawings, 320 markups, audit trail intact" — so there is nothing in it a client could object to,
  and it is readable without a tool because a bundle nobody checks before sending is a telemetry
  upload with extra steps.

- **Markup summary and takeoff as a spreadsheet.** Three sheets — the markup register, the
  measurements with their provenance, and a roll-up by cost code — written as a real XLSX rather
  than a CSV a spreadsheet mangles. The roll-up groups by cost code *and unit*, because adding a
  length to an area because they share a code produces a number with no meaning and a spreadsheet
  will do it without complaint.

  Written by hand rather than with a library: an XLSX is a zip of a few XML parts, the drawing
  engine already has a zip for BCF archives, and the candidate libraries are between 200 KB and
  2 MB with one of them carrying a licensing question of its own.

- **Drag-and-drop of drawings**, handled entirely in Rust. The reason it was disabled — that a drop
  would hand the webview a filesystem path — turned out not to apply: Tauri delivers the drop as a
  window event, so the paths land on the host side and the interface is told only that drawings
  arrived. The boundary did not have to move for the feature to exist.

- **OCR, on the device.** Tesseract and its English model ship with the application — about 11 MB
  of WebAssembly and 2 MB of model — so a scanned sheet is recognised with the network unplugged
  and no page leaves the machine. Search, specification parsing and title-block extraction all work
  on scans as a result, because they read through one seam.

  What it is *not* is good at small lettering: against a generated title block at 300 DPI,
  Tesseract recovers about 3 of 8 expected strings where PaddleOCR recovers 8 of 8. Good enough to
  make a scanned specification searchable; not good enough to trust for automatic sheet numbering,
  and the interface never presents a recognised scale as verified. A better on-device engine is
  still wanted — see below.

## What Open PDF Studio has that we do not

[Open PDF Studio](https://github.com/OpenAEC-Foundation/open-pdf-studio) is the closest thing to a
peer this project has: free, open source, AEC-aimed, and built on the same foundations — Tauri 2, a
Rust backend, pdf.js. It is worth taking seriously rather than dismissing.

> **A licence note, because it matters.** Open PDF Studio is **LGPL-3.0**. Under
> [the licensing rules](../CLAUDE.md) copyleft is refused rather than reviewed, so no code, asset
> or snippet from it can come into this repository — and none has. What follows was written from
> its published feature list and its documentation. Features are not copyrightable; source is. The
> distinction is the whole of the boundary being observed here, and anyone implementing the items
> below should implement them, not port them.

The two products are aimed at different halves of the same desk. Open PDF Studio is a **general PDF
editor** that measures; SheetForge is a **review and takeoff desk** that happens to open PDFs. That
is why it has redaction, forms and watermarks and we have provenance, an audit chain and a project
package — and why the honest reading of its feature list is not "catch up" but "these specific
things are missing and some of them should not be".

### Worth having, and now scheduled

- **Page assembly** — *extraction done; the rest still to come.* Taking pages out of a set into a
  new drawing works, and does it the way [ADR-0010](adr/0010-page-assembly-produces-a-derived-revision.md)
  settled: a **new derived revision** carrying its own hash and a record of the issue it was cut
  from, never an edit of the original. Both documents stay in the project. Insert, replace, reorder,
  rotate and merge are the same machinery pointed at different selections and are not built yet;
  neither is carrying markups across, which wants the slip-sheet verdicts rather than a guess.

- **Export a sheet as an image.** *Shipped*, and the whole set as one archive with it — see below.

- **Snapping while measuring.** They snap to endpoints, midpoints, centres and edges. This is the
  single most on-mission item on their list: a takeoff traced by eye at 1/8" scale carries a
  centimetre of hand-wobble per click, and snapping removes it. Two honest tiers: snapping to the
  vertices and midpoints of *markups already on the page* is straightforward with the geometry the
  engine already exposes; snapping to the *drawing's own linework* needs vector extraction from the
  PDF content stream, which is a much larger piece of work. The first tier is worth having on its
  own and will be built first, with the interface saying which it is doing.

- **Printing, to scale.** We have none at all, which is a real gap on a desk that plots. The
  generic answer — export a flattened PDF and print that — works and is what people will do; the
  part worth building is the AEC-specific bit, which is plotting *at a stated scale* onto a stated
  sheet size, with the scale actually verified against the calibration rather than left to the
  print driver.

- **Watermarks, headers and footers on export.** *Partly done.* An issue status now stamps across
  an exported image, single sheet or whole set: translucent fill with an opaque outline, so it
  survives both dark linework and white paper, drawn after the markups so nothing can be laid over
  it to hide it. The status goes in the filename too, because a file called
  "A-201 (NOT FOR CONSTRUCTION).png" is harder to forward carelessly. Asked for every time rather
  than remembered — a remembered status is one that eventually goes out on the wrong drawing.
  Still to come: the same on a flattened PDF export, and page numbers and dates as a footer band.

- ~~**Redaction, as an export.**~~ *Done, on the terms it was set.* A page carrying a redaction is
  rasterised and the redacted areas are painted out before the pixels are encoded, so the text does
  not survive because there is no text. There is a test that greps the exported bytes for a string
  that exists nowhere else, on a fixture with uncompressed content streams — so "not found" cannot
  quietly mean "deflated". A page nobody redacted is copied from the source unchanged and keeps its
  text, its vectors and its size, so redacting one number on sheet 12 costs sheet 12 rather than
  the set. Markups are deliberately absent from the output: a redacted copy is made to be handed
  outside the review, and the review's own comments are the last thing to send with it.

- ~~**Bookmarks and document outline.**~~ *Done.* The engine parsed the outline and this
  application threw it away, leaving a reviewer to scroll two hundred sheets looking for the
  mechanical drawings on a set that already knew where they were. It now appears in the sidebar
  under the drawing list, indented by depth, each entry announcing the page it goes to. Absent
  entirely when the document carries no outline, because an empty heading reads as "this set has
  no structure" rather than "this file carries none". The tutorial sheet gained one, so the
  feature demonstrates itself and the test has a real document to run against.

- **Interface language and right-to-left.** They ship 39 languages with RTL. We ship one, and there
  is not a string catalogue in the codebase — every label is a literal. That is a structural gap,
  not a translation task, and pretending otherwise would understate it.

### Deliberately not taking

- **Interactive form filling (AcroForms and XFA).** Off-mission, and XFA in particular is a large
  scripting surface inside a file format this application treats as hostile input. A reviewer
  filling in a transmittal form should use a form filler.
- **Multiple documents in tabs.** The project *is* the container here, and its sheet register does
  the job tabs are doing there. Adding tabs on top would be two answers to one question.
- **Editing the text and graphics inside a drawing.** Unchanged from below: a positioning decision,
  not a missing feature.

### Done, prompted by this comparison

- **A sheet as a picture.** One page, with its markups on it, as a PNG at 96, 150 or 300 DPI —
  because the request a reviewer actually gets is "send me a picture of the bit you clouded", and
  the answer until now was a screenshot cropped to whatever was on screen. The markups are
  composited from the same renderer the viewer paints with, so the exported cloud cannot drift into
  a different shape from the one on screen, and there is a test that decodes the exported PNG and
  fails if the overlay went missing.

  It also surfaced a limit worth naming, and then removed it. Exported bytes used to cross to the
  host as a JSON array of numbers, roughly five characters per byte: invisible for a 40 KB
  spreadsheet, ruinous for a 30 MB image. Exports now travel as a raw body, so plot resolution is
  a real option rather than a refused one.

## What OpenTakeoff has that we do not

[OpenTakeoff](https://github.com/Kentucky-ai/opentakeoff) is an Apache-2.0 takeoff engine for
construction and flooring: browser-based, TypeScript, with an MCP server so an agent can drive the
same geometry a person does.

> **A licence note, and it is a different one this time.** OpenTakeoff is **Apache-2.0** — the same
> licence as this project. Unlike [Open PDF Studio](#what-open-pdf-studio-has-that-we-do-not),
> which is LGPL and therefore refused outright, code from OpenTakeoff *could* legitimately be
> reused here with attribution recorded in `THIRD_PARTY_NOTICES.md`. Nothing has been, so far: what
> follows was taken from its ideas rather than its source, and its ideas turned out to be the
> valuable part.

The two products are aimed at different jobs. OpenTakeoff is an **estimating engine** — conditions,
waste, roll goods, seam layout, buy lists — that reads drawings on the way to a number. SheetForge
is a **review desk** that measures. The overlap is measurement and provenance, and that is exactly
where the useful reading is.

### Where it independently reached the same conclusions

Worth writing down, because agreement arrived at separately is evidence the reasoning holds rather
than evidence of a house style:

- **"Scale is a gate, not a default."** It refuses to measure an unscaled sheet rather than assume
  1:1. This project reports an uncalibrated measurement as *underived* rather than as zero, for the
  same reason: a plausible wrong number is worse than an obvious absent one.
- **"Every record carries how it was made."** Method, confidence, and — a genuine addition — *the
  machine's original boundary when a human corrected it*. Our quantities keep their raw page
  magnitude and calibration, and the sheet register records whether a value was recognised,
  extracted, imported or confirmed. Keeping the superseded machine answer alongside the human one
  is the part we do not do.
- **"Agent work is pencil until a person inks it."** Automated output lands as dashed proposals a
  person accepts. That is precisely the condition this roadmap already places on automated quantity
  extraction, arrived at independently.

### Taken

- **Checking a dimension, graded.** *Shipped* — see below.

- **A review tally on the exported set.** Their marked-up PDF carries "a tally of how much of the
  set a person has actually reviewed". That is arguably more on-mission for a review desk than for
  an estimating tool, and the sheet register already holds what is needed to compute it. Scheduled.

### Worth having, and scheduled

- **Colour and hatch by condition, with a legend cover page.** Their export "burns the work into
  the drawings as drawn — condition colors, hatches, quantity chips, count markers — behind a
  legend cover with totals". Our exports carry markups in discipline colours with no key, so a
  recipient sees colours nobody has explained to them.

- **Quantity-level revision deltas.** Their revision compare exports *"which numbers moved, not
  which wall did"*. Ours is geometric — it clouds what changed on the sheet. Both are useful and
  they answer different questions; a quantity delta is what goes in front of somebody deciding
  whether a variation is real.

- **Waste applied to the ordered quantity, never to the measured one.** A clean distinction we do
  not model at all, because there is no materials layer here yet. If one ever arrives, this is the
  invariant it should be built on: what was measured is a fact about the drawing, what is ordered
  is a decision about the job, and conflating them makes the measurement unverifiable.

- **Inverting sheet pixels at render time for dark viewing**, rather than a CSS filter over the
  page. The difference shows up when printing a negative.

### Deliberately not taking

- **The training-data capture server.** OpenTakeoff banks shape geometry and provenance to build a
  training corpus — openly, as the point of the project. It is directly opposed to
  [ADR-0007](adr/0007-telemetry-privacy-and-diagnostics.md): nothing about a drawing leaves the
  machine, and "anonymised geometry" is not an exception, because a floor plate is identifying.
  This is a difference in what the two products are *for*, not a criticism of theirs.

- **One-click room detection**, except on the terms already set out under *Deliberately not
  coming* below: as a proposal a person accepts one at a time, never as a quantity that appears
  already made. Their design — dashed until inked, with the machine's original boundary retained —
  actually satisfies that condition, which is worth noting before anybody assumes the answer is no.

### Done, prompted by this comparison

- **Check a dimension.** Drag along something whose length is printed on the sheet, type what it
  says, and get a graded answer: within 1% the scale is right, within 5% is worth drawing again,
  beyond that something is wrong. Where a familiar mistake explains the number it is named — a
  half-size plot, feet read as inches, metres read as feet — because "1,100% out" tells nobody
  anything and "feet may have been entered where inches were meant" tells them where to look.

  The tutorial sheet has taught this since it shipped: calibrate against the printed `144'-0"`,
  then measure the far side and see whether it agrees. What was missing was a tool, so the lesson
  ended at *and now check it by hand*.

  The bands are in `sf-domain` with tests, not in a click handler — a tolerance that lives in the
  interface is one the importer will not obey, and one somebody widens on the afternoon it becomes
  inconvenient. Nothing is drawn on the sheet: a check is a question about the page, not a markup
  on it, and leaving a line behind would put a measurement in the register nobody asked to record.

## 0.3 — The review, end to end

- **Batch import** of a whole set, with sheet numbers read from title blocks rather than filenames.
- ~~**The sheet register as a queryable table**~~ *Done.* The engine had been reading title blocks
  all along and the host threw the result away on every save. It is kept now, with a record of how
  each value was known, and it is on screen: a Sheets panel listing the set by number, with **Find
  sheets at a revision…** narrowing it and saying which revision it is showing — a list silently
  reduced to a subset is one somebody reads as the whole set and acts on. A number nobody has
  checked is marked *unchecked* in words rather than in a shade of grey, because the reader who
  cannot tell two greys apart is the same reader about to quote it.

- ~~**Saved filters and views** that travel with the project.~~ *Done.* A named place in a drawing
  — page, zoom, position, and the markup filter that was active — kept with the project rather than
  lost on close. The filter travels with it because without it a restored view has the geometry and
  not the point: half the reason to save one is that everything else was hidden. Views are the one
  thing the engine holds that its storage adapter has no channel for, so these travel over the bus
  instead, and the list is written whole because that is the only way a deletion reaches the host.
- ~~**Attachment handling**: photos from a phone camera, sized and content-addressed.~~ *Mostly.*
  Filed into the project package under their content hash, so the same photo on three markups is
  stored once; refused past the attachment limit before anything is written; re-hashed on the way
  out, because a photograph of a defect is exactly the file somebody later claims was altered. The
  reference stored in the markup is a hash, not a URL — a `blob:` URL dies on reload and a `data:`
  URL would carry a three-megabyte photograph through every export that includes markups. What is
  left is display: opening one works, showing a thumbnail without fetching every attachment in the
  document does not, and that wants lazy resolution.

## 0.4 — Mobile in earnest

- **iOS and Android builds published** to TestFlight and a Play internal track.
- **Touch-first review**: the drawing engine already handles pinch, pan, palm rejection and stylus
  pressure; the project chrome around it needs to stop being a desktop layout squeezed narrow.
- **Import from the system document provider**, including Files, SharePoint and Drive, without the
  application ever handling a path.
- **A field mode**: pins, photos, voice notes, and a sync queue that drains when signal returns.
- **A better on-device recogniser.** PaddleOCR reads small title-block lettering far better than
  Tesseract and is roughly five times faster per tile. What it costs is `onnxruntime-web`, whose
  runtime assets are an order of magnitude larger than everything else the application ships. The
  provider is a single value, so the change is small; the packaging decision is the hard part.

## 0.5 — Working with other people

Still no mandatory cloud. Local-first stays the default.

- **A project package that merges**, so two reviewers can work the same set offline and reconcile.
  The optimistic-concurrency token and the audit chain are already the foundation for this.
- **An optional sync server**, self-hostable, that nobody is required to use.
- **Presence and advisory locking** when a server is present — the engine already models both.
- **Role assignment from a directory** rather than the single-owner default.

## 1.0 — When it is defensible

1.0 means: signed on every platform, a security review by somebody who did not write it, published
performance budgets that are enforced, a migration path proven across two schema versions, and
accessibility verified with a screen reader rather than asserted.

---

## Deliberately not coming

Saying no is the more useful half of a roadmap.

**Editing PDF content.** No changing the text or graphics inside a drawing. On a construction job
the issued PDF is the governing document; a tool that quietly rewrites it produces a drawing that
no longer matches what the architect signed. This is a positioning decision, not a missing feature.

**Legal e-signature.** Regulated signature workflows carry compliance obligations that a free tool
cannot responsibly claim to meet. Stamps that *look* like signatures are not signatures and will
not be presented as such.

**Automated quantity extraction.** "Point at the drawing and it counts the doors" is the most
requested feature in this category and the most dangerous. An unchecked automated quantity is a
number nobody can defend in a dispute. If it ever ships it will be as a *proposal* a human accepts
one at a time, with the automation recorded on the record — never as a measurement that appears
already made.

**AI-derived project facts presented as verified.** Same reasoning. An OCR-read scale is already
marked provisional until a human confirms it, and that is the pattern anything of this kind will
have to follow.

**DWG import.** Not without a tested, licensed and supportable importer. A half-working CAD
importer is worse than none: it will be wrong on exactly the geometry somebody measures.

**Plugins with unrestricted native execution.** The security boundary is the product. If a plugin
system arrives it will be sandboxed and capability-scoped, or it will not arrive.

**Mandatory cloud for basic use.** Ever. Everything above works with the network off.

---

## Asking for something

Open an issue describing the construction workflow, not the feature. "I need to check that every
fire-rated wall on the plans has a matching detail" tells us far more than "add a cross-reference
tool", and it is more likely to get built.
