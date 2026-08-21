# What the competition does, and what we should

A feature audit against [Bluebeam Revu](https://support.bluebeam.com/user-manual/dashboard.html),
[UPDF](https://updf.com/whats-new/) and the general PDF editors, with a decision against each
line — because the useful output of a comparison is not a list of everything they have, it is a
list of what we will and will not build.

**The headline conclusion: "do everything they do" is the wrong target, and following it would
sink this project.** Bluebeam and UPDF are not competing with each other. Bluebeam is an AEC review
desk; UPDF is a general PDF editor with an AI assistant bolted on. Matching both means being worse
than both. SheetForge competes with **Bluebeam**, and treats the general-editor feature set as out
of scope unless a construction workflow needs it.

---

## 1. Where we already stand up

Present today, and at parity or better.

| | SheetForge | Bluebeam | Notes |
|---|---|---|---|
| Markup toolset (shapes, clouds, text, callouts, stamps, symbols) | ✅ | ✅ | Real scalloped clouds, glyph-accurate highlight/strikeout |
| Markups as structured records (status, discipline, assignee, due date, cost code) | ✅ | ✅ | Bluebeam's Markups List is the thing being matched |
| Faceted markup list and filtering | ✅ | ✅ | |
| Calibrated measurement, per page | ✅ | ✅ | |
| Takeoff roll-up by cost code | ✅ | ✅ | |
| Measurement **provenance** and re-derivation | ✅ | ⚠️ | Ours keeps the raw page magnitude, so re-calibrating re-derives. Bluebeam recalculates too; neither exposes formula versioning the way we do |
| Document compare with alignment | ✅ | ✅ | |
| Slip-sheet markup migration with a per-markup verdict | ✅ | ⚠️ | Bluebeam does slip-sheeting; the *needs-a-human* verdict queue is ours |
| Issue pins → BCF topics | ✅ | ⚠️ | Bluebeam reaches BCF through add-ins |
| XFDF interchange | ✅ | ✅ | |
| CSI specification parsing and clause citation | ✅ | ❌ | Genuinely ours |
| Tamper-evident audit trail | ✅ | ❌ | Genuinely ours |
| Offline by default, no account | ✅ | ✅ | |
| Cross-platform incl. mobile | ✅ | ❌ | Revu is Windows; the iPad app is a viewer |
| Price | Free, Apache-2.0 | Subscription | The whole point |

---

## 2. Real gaps worth closing

Things Bluebeam has, that construction people actually use, that we should build.

| Gap | Why it matters | Priority |
|---|---|---|
| **OCR wired to a provider** | Half the drawings on a refurbishment job are scans. Without OCR, search, spec parsing and title-block extraction all return nothing on them. The engine has the whole pipeline — tiling, coordinate mapping, provider interface — and no provider is configured, so the feature is dark | **0.2 — highest** |
| **Markup summary export to XLSX** | Bluebeam's Markup Summary is how a review gets sent to people who do not have the tool. We export CSV; a formatted workbook with a sheet per discipline is what actually gets emailed | 0.2 |
| **Page assembly** — extract, delete, rotate, reorder, insert, split | Sending one sheet from a 200-sheet set is a daily act. This is *document assembly*, not content editing: it never rewrites a content stream, so it does not violate our immutability rule — a new revision is written, the original stays untouched | 0.3 |
| **Batch operations across a set** | Bluebeam's Batch menu is a genuine differentiator: batch header/footer, batch link, batch summary. Reviewing a set means doing things to 200 sheets at once | 0.3 |
| **Encrypted / password-protected PDFs** | They arrive. Today we refuse them without a useful message; we should prompt and open | 0.3 |
| **Sheet hyperlinks** (Bluebeam's Batch Link) | Clicking a detail callout and landing on the detail sheet is the single most-used navigation feature in a real set | 0.3 |
| **Compare across a whole set**, not two sheets | Slip-sheeting a 200-sheet reissue one sheet at a time is not a workflow | 0.4 |
| **Tool chests / company tool sets that travel** | Partly present. What is missing is import/export so an organisation can standardise | 0.3 |
| **Digital signatures (verification)** | Reading and *verifying* an existing signature is legitimate and useful. Creating legally-operative ones is not — see below | 0.4 |

---

## 3. Deliberately not doing

Each of these is a real feature in Bluebeam or UPDF, and each is a decision rather than an
oversight.

| Not doing | Why |
|---|---|
| **Editing PDF text and graphics** (UPDF's headline feature) | On a construction job the issued PDF is the governing document. A tool that rewrites it produces a drawing that no longer matches what the architect sealed. This is the single clearest line in the product |
| **Convert PDF → Word / Excel / PowerPoint** | UPDF's other headline. Converting a *drawing* to Word is meaningless; converting a *specification* is occasionally useful and is what copy-paste is for. Exporting **markup and takeoff data** to Excel is a different thing and is on the list above |
| **Legally-operative e-signatures** | Regulated workflows carry compliance obligations a free tool cannot responsibly claim to meet. Stamps that look like signatures are not signatures and will not be presented as such |
| **AI chat with the document** | UPDF ships ten AI agents. An AI-derived answer about a drawing that somebody acts on, without provenance, is exactly the failure mode the measurement model exists to prevent. If this ever ships it will produce *proposals a human accepts*, with the automation recorded on the record |
| **Automatic quantity extraction** | Same reasoning, higher stakes. An unchecked automated count is a number nobody can defend in a dispute |
| **Cloud collaboration sessions** (Bluebeam Studio) | Not never — but local-first stays the default and a cloud is never required for basic use. See the roadmap's 0.5 |
| **Forms** — filling, creating, flattening | Construction PDFs are drawings, not forms. If submittal cover sheets turn out to matter, this returns |
| **Redaction** | A security-critical feature where a bad implementation is worse than none: leaving the text under a black rectangle is a data breach with a checkmark next to it. Out until it can be done properly |
| **DWG / DGN import** | Not without a tested, licensed, supportable importer. A half-working CAD importer is wrong on exactly the geometry somebody measures |

---

## 4. What the menus should be

Both Bluebeam and UPDF organise around a menu bar (File / Edit / View / Document / Batch / Tools /
Window). That fits an application with three hundred commands. SheetForge has perhaps forty, and a
menu bar would be ceremony imitating scale we do not have.

The current shape — and the reasoning:

```
┌──────────────────────────────────────────────────────────────────────┐
│ SheetForge   Riverside Tower    [Open PDF…]  [Export ▾] [Project ▾]  │
├────────────┬─────────────────────────────────────────────────────────┤
│ Drawings   │  ← the engine's own toolbar: tools, view, measure       │
│  A-201     │                                                          │
│  A-202     │     the sheet                                            │
├────────────┴─────────────────────────────────────────────────────────┤
│ status                                          All changes saved    │
└──────────────────────────────────────────────────────────────────────┘
```

- **Open PDF** is primary and singular, because it is what somebody launched the application to do.
- **Export** is a menu with words, built from the engine's action registry so it cannot fall behind
  what the engine offers. It replaces nine unlabelled glyphs that were discoverable by nobody.
- **Project** holds the housekeeping — add drawings, switch project, check integrity — which is
  needed occasionally and was previously competing for attention with the things that are not.
- **There is no Save**, and that is a decision, not an omission. See
  [the guide](guides/editing-pdfs.md#6-saving).

The engine's own toolbar stays as it is: it is a *drawing* toolbar, and a dense icon row is the
right shape for tools you use continuously and learn once. The mistake was letting **file
input/output** live there, where it is used rarely and needs a name rather than a symbol.

---

## 5. What this comparison is not

It is a reading of published documentation and reviews, not a hands-on bake-off. Nobody here has
run a licensed copy of Revu 21 side by side with SheetForge on the same drawing set, and the
parity claims in section 1 are claims about *feature existence*, not about quality, speed or
edge-case behaviour. Bluebeam is a mature product with two decades of accumulated handling for
drawings that are strange in ways we have not met yet.

Treat section 1 as "we have something in this box" and nothing stronger.

**Sources:** [Bluebeam Revu user manual](https://support.bluebeam.com/user-manual/dashboard.html) ·
[Revu 21 interface](https://support.bluebeam.com/revu/subscription/navigate-and-customize-the-interface-21.html) ·
[Revu Document menu](https://support.bluebeam.com/online-help/revu21/Content/RevuHelp/Menus/Document/Document-Menu--M.htm) ·
[Revu Batch menu](https://support.bluebeam.com/online-help/revu21/Content/RevuHelp/Menus/Batch/Batch-Menu.htm) ·
[UPDF version history](https://updf.com/whats-new/)
