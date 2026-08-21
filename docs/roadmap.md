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
- **An installer smoke test in a clean VM** as a release gate, per platform.
- **Performance budgets, measured**, on real hardware and a real drawing set: time to first page,
  tile latency at 800%, memory on a 200-sheet set. Then published, and failed against.
- **Crash recovery, tested by killing the process**, not by dropping a connection.
- **Trademark clearance** for the name. See
  [ADR-0009](adr/0009-trademark-and-brand-clearance-status.md).

### Done since this was written

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

## 0.3 — The review, end to end

- **Batch import** of a whole set, with sheet numbers read from title blocks rather than filenames.
- **The sheet register as a queryable table**, so "every sheet at Rev C" is a query rather than a
  scroll.
- **Saved filters and views** that travel with the project.
- **A diagnostics panel** and the user-assembled diagnostic bundle described in
  [ADR-0007](adr/0007-telemetry-privacy-and-diagnostics.md).
- **Attachment handling**: photos from a phone camera, sized and content-addressed.

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
