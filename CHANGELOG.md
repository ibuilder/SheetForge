# Changelog

Notable changes, newest first. Follows [Keep a Changelog](https://keepachangelog.com/) and
[semantic versioning](https://semver.org/); before 1.0 the minor version may break things, and any
break that touches stored data will say so here with a migration note.

## [0.1.2] — 2026-09-12

**The first release that can update itself, and the first with build provenance.** It is still an
unsigned preview in the code-signing sense: nothing is code-signed or notarised, so SmartScreen and
Gatekeeper still warn. Only the Windows build has been run by a person. See
[docs/status.md](docs/status.md).

### Security

- **Size ceilings now apply before a file is read, not after.** Importing a drawing read the whole
  file into memory and only then checked it against the 512 MB ceiling — so a far larger file was
  loaded before being refused, and a device or a named pipe dropped on the window was read until
  memory ran out. Files are now refused from their metadata, re-checked through the opened handle,
  and read no more than one byte past the ceiling, which also stops a file that reports a size it
  does not have. The same bounded read covers attachments, sources read back out of a project
  package — which may come from somebody else — and imports.
- **XFDF and markup-set imports are measured.** The drawing engine read these files whole inside
  the window, with no ceiling on the way, although the threat model names a hostile XFDF from a
  subcontractor as the primary adversary. They now come through the host's native picker and the
  same bounded read, and no route — the menu or the engine's own toolbar — can reach the old ones.
  Loading a markup set, which replaces every markup on the drawing, now asks first.
- **The page-count ceiling is enforced.** It was listed as a defence in the threat model and shown
  as in force in the diagnostics report, and nothing ever compared a document's page count with it.
  Documents past it are now refused before anything is written, on a count taken from the file's
  contents rather than its own claim.
- **The diagnostics report no longer overstates.** Ceilings that exist only as values — the job
  timeout, concurrency, decompressed-stream, package and archive limits — were listed under
  "Limits in force". They are now listed as declared and not yet enforced, and the threat model is
  corrected to match.

### Fixed

- **Jumping and zooming on a large set no longer stall for seconds after opening it.** On a
  200-sheet set a jump took about 3 seconds and a zoom about 4 — for the first couple of minutes
  after opening, whatever the distance — while opening itself took under half a second. The drawing
  engine's sheet panel was redrawing every thumbnail once per sheet as it read the title blocks:
  about 40,000 thumbnail draws, and everything else queued behind them. Its thumbnails are meant to
  load lazily, but the list they watch never scrolled, so every one was always "in view". Bounding
  the list's height makes them lazy again: 2,014 draws, done in eight seconds, a jump in 60 ms and a
  zoom in 87 ms. It also stops the thumbnail list pushing every other sidebar panel twenty thousand
  pixels down. The underlying causes are the engine's and are reported upstream.

### Added

- **Rendering is measured.** A browser test opens a synthetic 200-sheet set and times the first
  sheet, a jump deep into the set, a zoom, and the memory left after paging across it — against
  loose ceilings meant to catch an order-of-magnitude regression, with the figures printed on every
  run. The timings come from marks the application records locally; nothing is sent anywhere. The
  set is generated and lighter than a real CAD export, so the figures are a floor.

- **Every release file carries signed build provenance, and a bill of materials.** From the next
  release, anybody can confirm a download was built by this repository's release workflow from a
  named commit, and has not been changed since:

  ```bash
  gh attestation verify SheetForge_0.1.2_x64-setup.exe --repo ibuilder/SheetForge
  ```

  For installers that are not code-signed this is the strongest check available, and it needs no
  secret — it is signed with the workflow's own identity and recorded in the public Sigstore log. It
  does not silence SmartScreen or Gatekeeper; only a paid certificate does that. The release also
  gains `SBOM.cdx.json`, listed in `SHA256SUMS.txt` and attested against the installers it
  describes. 0.1.1 predates all of this.

- **Checking for updates, with an off switch.** A few seconds after start SheetForge asks whether a
  newer version exists. It is the one network request the application makes, and ADR-0007 allows it
  on the condition that it can be turned off — *Project ▾ → Stop checking for updates on start* —
  so switched off, it sends nothing at all rather than asking and ignoring the answer.

  A check on start only ever announces. It never raises a dialog, because one arriving while
  somebody types a markup turns a stray Enter into consent to download and restart. The Project
  menu then offers *Install SheetForge 0.1.2…* by name, and that asks before doing anything.

  Installing downloads and verifies first, then saves every markup, then installs. The order is
  forced by Windows, where the installer ends the application the moment it starts. And the save is
  confirmed from the drawing engine's own state rather than by waiting for it, because the engine's
  save resolves even when it fails — waiting and carrying on would install over unsaved work.

  Nothing can be updated *to* until a release is built with the updater key. 0.1.1 predates this
  and needs one manual reinstall.

### Changed

- **A redacted copy says what it leaves out.** Its bookmarks, title and other document properties
  are not carried over from the source — deliberately. They are text nobody reviewed when choosing
  what to black out, and a bookmark can be titled with exactly the name that was just removed from
  the sheet it points to. That was already true; what changed is that exporting now says so, since
  the person sending the file on would never find out by opening it. A test now fails if either the
  outline or the title can be recovered from a redacted copy, reading the output as a PDF reader
  would rather than searching its bytes — a byte search was shown to miss a planted leak.

- **The updater key is real.** The public key shipped since the first commit had no private half
  anybody held, so every update would have been rejected — the updater was inert while appearing
  configured. A key pair was generated on the maintainer's machine, its private half stored as a
  repository secret and never written down anywhere else, and the public half is below. Releases
  from 0.1.2 on are signed with it; 0.1.1 and earlier cannot be updated from and need one manual
  reinstall.

## [0.1.1] — 2026-09-10

**The first build anybody outside this repository can download.** 0.1.0 was built and drafted but
never published, and this supersedes it rather than following it: the 0.1.0 installers carry the
pdf.js arbitrary-execution advisory below, and a Windows installer whose uninstaller demands
administrator rights it does not need. Neither should reach anybody.

It is still an **unsigned preview**. Nothing is code-signed or notarised, so SmartScreen and
Gatekeeper will warn; and it was built without the updater signing key, so **it cannot update
itself** — anything installed from it stays on 0.1.1 until it is uninstalled and replaced by hand.
Verify downloads against the attached `SHA256SUMS.txt`. Only the Windows build has been run by a
person; the macOS and Linux builds compile in CI and nobody has launched them. See
[docs/status.md](docs/status.md).

### Fixed

- **The Windows installer no longer asks for administrator rights.** It was configured to offer
  both a per-machine and a per-user install, and NSIS asks for elevation when it might need it —
  so the installer *and the uninstaller* raised a UAC prompt even though the install actually
  landed entirely in the user's own profile, registered under `HKCU`. Refuse or dismiss that
  prompt and the uninstall fails silently, leaving the application listed in Add or remove
  programs with no way to shift it. Found by installing the build and then trying to remove it.

  The NSIS installer is now **per-user only**, which needs no administrator at all. That is the
  right default for who actually runs this: a contractor or an estimator on a managed laptop
  frequently *cannot* elevate, and an installer that demands it is one they cannot use. Fleet
  deployment has the MSI, which is the path IT departments use anyway and is per-machine by
  design.

### Security

- **pdf.js raised to 6.2.108**, closing [CVE-2026-16633](https://github.com/advisories/GHSA-hq66-cqwq-w95j)
  — arbitrary JavaScript execution on opening a malicious PDF, rated high. This is the library that
  parses the input this whole application treats as hostile, so it is the last dependency that
  should be behind.

  The shipped configuration was already covered: the advisory's own stated mitigations are
  disabling PDF scripting or setting a CSP, and the application ships `script-src 'self'` with no
  `'unsafe-eval'`, with `dangerousDisableAssetCspModification` off. That is mitigation rather than
  a fix, and it does not apply to the development server, so the version was raised regardless.

- **CI now checks the JavaScript dependencies for advisories**, which it never did. The Rust half
  of the tree has been gated on `cargo-deny` since the first commit; the JavaScript half was not
  gated at all, which is how the above sat in the lockfile until GitHub mentioned it on a push.
  Set at `--audit-level=high` deliberately: a gate that fires on every transitive advisory in a
  build tool is a gate people learn to skip, and a check nobody reads looks like coverage without
  being any.

### Added

- **A running takeoff on screen**, in the sidebar under the sheet register. Totals what has been
  measured on the open drawing by cost code *and* unit, and updates as each measurement is filed.
  Every other quantity output here is a file, which is the wrong shape for the thing a reviewer is
  building while they measure: the point is catching the measurement that landed under the wrong
  cost code at the moment it was made, rather than in a spreadsheet the following week.

  One code in two units stays two lines. Adding a volume to an area would produce a number with a
  plausible magnitude sitting under a real cost code — wrong in no way a reader can see.

  What is not counted is said in words beneath the totals, not shown as a badge or a colour: the
  reader who most needs to know that three measurements are missing is the one about to quote the
  number.

- **Compare the quantities on two drawings** — *Project ▾ → Compare quantities with…*. Totals the
  measured quantities of both by cost code and unit and writes the comparison as CSV: what moved,
  by how much, and in which direction. The lines that did **not** move are in the file too, because
  a schedule of only the differences cannot be checked — a line that held and a line that was never
  compared look identical without them. Measurements taken on a page with no scale, or at a scale
  nobody has confirmed, are excluded from the totals and named at the foot of the file rather than
  counted as zero.

  It compares against any other drawing in the project rather than against "the previous issue of
  this one": every import creates its own document, so that relationship does not exist in the
  store today, and offering a control that could never work would be worse than asking.

## [0.1.0] — 2026-08-24

Built and drafted, never published — superseded by 0.1.1 before it reached anybody. The core is
built and tested; the shell is young. See
[docs/status.md](docs/status.md) for what is verified and what is not.

### Added

**Reviewing**
- Open a construction drawing set and navigate it: continuous or single-page, fit-width and
  fit-page, rotation, thumbnails, and tiled rasterisation so a D-size sheet stays readable at 800%.
- Search across sheet text, markup content and the sheet register at once, with phrase matching
  over the joined word stream.
- Revision compare with automatic alignment, difference clustering, and clouding of the changes.
- Slip-sheet migration with a per-markup verdict — unchanged, relocated, or needs a human — and a
  review queue rather than silent reapplication.
- CSI specification parsing into addressable sections and clauses, so a citation is a link.
- OCR for scanned sheets through a recogniser you supply; nothing is bundled and no engine is the
  default.

**Marking up**
- Attachments: site photos and voice notes filed into the project rather than inlined into the
  markup, content-addressed and size-limited. Re-hashed when read back, because a photograph of a
  defect is exactly the file somebody later claims was altered.
- Rectangle, ellipse, polygon, polyline, line, arrow, freehand ink, revision clouds with real
  scalloped arcs, text, callouts, glyph-accurate highlight, strikeout and underline, dynamic
  stamps, symbols, issue pins and attachments.
- Markups as structured records: subject, note, status, discipline, assignee, due date, cost code,
  labels, spec citation and IFC references.
- A validated status workflow, with reopening routed through the start of the review rather than
  jumping into the middle of it.
- Undo and redo for every locally reversible action.

**Measuring**
- **Check a dimension.** Drag along something whose length is printed on the sheet, type what it
  says, and get a graded answer rather than a percentage: within 1% the scale is right, within 5%
  is worth drawing again, beyond that something is wrong. Where a familiar mistake explains the
  number it is named — a half-size plot, feet read as inches, metres read as feet. A wrong scale
  makes every length on the page wrong and every area wrong by its square, with nothing on screen
  looking unusual, and this is the two-second defence.
- Distance, polyline length, area, perimeter, count, angle, radius and volume.
- Per-page calibration from a drawn dimension, a named scale preset, or a title block reading that
  stays provisional until a human confirms it.
- Feet-and-inches formatting and parsing.
- Every quantity carries its raw page magnitude, calibration, formula version, unit and precision,
  so re-calibrating a page re-derives every measurement on it.

**Keeping it**
- The `.sfproj` project package: content-addressed drawings kept byte-identical, SQLite records,
  and an integrity check that reports an altered or missing drawing rather than opening anyway.
- A hash-chained, tamper-evident audit trail, immutable at the database level and exportable as
  NDJSON.
- Optimistic concurrency on every write, so a concurrent edit becomes a conflict somebody resolves
  rather than one of two edits disappearing.
- Durable writes: WAL with `synchronous = FULL`, because a tablet losing power on site is the
  expected failure.

**Exporting**
- Flattened PDF, CSV and XLSX takeoff, XFDF, and BCF topics — each carrying the document revision,
  page, markup id, calibration and formula version.
- One sheet as a PNG, with its markups on it, at 96, 150 or 300 DPI — screen, print or plot. The
  markups are composited from the same renderer the viewer paints with, so an exported cloud cannot
  drift into a different shape from the one on screen.
- **Redaction that removes the content.** A Redact tool, and an export that rasterises any page
  carrying a redaction with the redacted areas painted out before the pixels are encoded — so the
  text is gone rather than covered. A black box over text a copy-paste still recovers is worse than
  no redaction, because it is believed. Pages with no redaction on them are copied unchanged and
  keep their text. Markups are not included: a redacted copy is made to be handed outside the
  review.
- An issue status stamped across an exported image — "NOT FOR CONSTRUCTION" or whatever you are
  issuing under. A marked-up review copy that reaches a subcontractor looking like an issued
  drawing is how somebody builds the wrong thing.
- An exported set opens with a legend: what each colour means, in words beside the swatch, with
  counts by discipline and status — and a tally of how many sheets carry any markup at all. Without
  it a recipient reads an unmarked sheet as reviewed and found correct, when it may simply never
  have been opened.
- Every sheet as PNGs in one ZIP, at screen or print resolution. One save dialog rather than one
  per sheet, and no folder picker — which would have meant a directory handle held across calls
  and a second place for "no command takes a path" to be got wrong.
- Exports cross to the host as raw bytes rather than as a JSON array of numbers, which cost about
  five characters per byte to build, send and parse. The name and extension travel as
  percent-encoded headers, so a drawing called `Plan étage` keeps its accent. This is what makes a
  plot-resolution image an export rather than a frozen window.

**Assembling**
- Extract pages into a new drawing — "send the subcontractor the six mechanical sheets". The
  extract is a new revision recording which issue it was cut from; the original is never edited,
  because a revision's identity is the hash of its bytes and editing in place would make
  verification report your own work as tampering. Both documents stay in the project.

**Getting back to work**
- The projects you had open lately, in the Project menu. Closing the application used to mean
  finding your work again through a folder dialog.
- The host keeps the locations and names each one to the interface by an opaque handle, so the
  set of places this command can reach is exactly the set of projects you have already opened
  through a native dialog. A project that has moved is listed and disabled rather than hidden.

**Navigating**
- Saved views that survive closing the project: a named place in a drawing, with the markup filter
  that was active when you saved it.
- The sheet register in the sidebar: the set listed by sheet number and title, with **Find sheets
  at a revision…** to answer "which sheets are at Rev C?". A sheet number nobody has checked is
  marked *unchecked* — most of them are read off title blocks by a heuristic, and on a scanned set
  that reading is frequently wrong.
- The drawing's own outline, in the sidebar. A construction set exported from Revit or Bluebeam
  carries one — disciplines at the top, sheets under them — and a 200-sheet set is much faster to
  move around by it than by a flat list. Hidden entirely when the document has none.

**Getting started**
- A tutorial drawing ships with the application: a two-page ARCH D sheet with a title block, a
  column grid, a legend and a graphic scale. It opens itself once, on a genuinely first run, and
  is available afterwards from the Project menu and from the empty screen.
- The tutorial carries its own outline, so the contents panel demonstrates itself on the first
  document a new user ever opens.
- The practice sheet carries a dimension printed as `144'-0"` whose geometry is exactly 1296 PDF
  points — 144 feet at 1/8" = 1'-0". Calibrating against it and measuring the far side gives an
  answer the sheet itself can confirm, so the calibration lesson is checkable rather than asserted.
- The sheet is generated by `scripts/make-welcome-sheet.mjs` and reviewed as code; CI regenerates
  it and fails if the committed file has drifted.

**Platform**
- Windows, macOS, Linux, iOS and Android from one codebase.
- Signed update payloads, verified before they are applied.
- No telemetry, no account, no cloud. One outbound connection, for the update check, and it can be
  turned off.

### Known limitations

Listed here as prominently as the features, because a first release is mostly a list of things
nobody has checked yet. [docs/status.md](docs/status.md) is the long version.

- Release binaries are not code-signed with an organisation certificate, so Windows SmartScreen and
  macOS Gatekeeper will warn on install.
- **The drawing engine's own interface has two serious accessibility defects** — empty panels that
  still announce themselves as lists of options, and a drawing scroller that cannot be focused by
  keyboard. They are in a dependency, they are listed rather than hidden, and any *new* defect
  fails the build.
- **No installer has been run on a clean machine.** CI packages the application on all three
  platforms, which proves it builds; nobody has installed one.
- **The raw IPC transport is exercised only against a stub.** Every export crosses that seam. The
  browser suite stops there by design, so the first person to export from a packaged build is
  testing it.
- **The updater has never delivered an update**, because there is no previous release to update
  from. That path ships unexercised end to end.
- The name "SheetForge" has not had trademark clearance —
  [ADR-0009](docs/adr/0009-trademark-and-brand-clearance-status.md).
- No at-rest encryption of the project package; use full-disk encryption.
- No fuzzing corpus for hostile PDF input yet. This is the largest security gap.
- No third-party security audit and no penetration test.

[Unreleased]: https://github.com/ibuilder/SheetForge/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ibuilder/SheetForge/releases/tag/v0.1.1
[0.1.0]: https://github.com/ibuilder/SheetForge/releases/tag/v0.1.0
