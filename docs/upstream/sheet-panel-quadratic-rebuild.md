**Title:** Opening a large set redraws every sheet thumbnail once per sheet — quadratic, and it stalls navigation for minutes

**Found against:** `36794b3c54fcfd62e3a0d2d5984cfc45cac83340`
**Area:** the sheets plugin (`sheet-index` panel) and `AnnotationStore.setSheet`
**Severity here:** serious — every jump and zoom waits ~3 s for the first one to two minutes after opening a 200-sheet set

---

### What happens

After a document loads, the sheets plugin reads each page's title block in turn and calls
`store.setSheet()` once per page. Three things then compound:

1. **`setSheet` always emits `sheet:changed`**, even when the metadata is identical to what the
   store already holds.
2. **The sheet panel rebuilds its entire list on every `sheet:changed`** — `innerHTML = ""`, then
   every card recreated — rather than updating the one card that changed.
3. **The lazy thumbnail loader is not lazy.** Its `IntersectionObserver` uses the list element as
   `root`. `.mpdf-sheet-list` is declared `overflow-y: auto` but nothing bounds its height, and its
   panel is `flex: none`, so the list grows to the full height of every card and never scrolls —
   the sidebar scrolls instead. Every card is therefore always "intersecting", and every thumbnail
   is drawn on every rebuild.

So *N* sheets produce *N* rebuilds, each drawing *N* thumbnails: **N² thumbnail renders**, all
competing with the main view for the same worker and main thread.

### Measured

A synthetic 200-sheet ARCH D set (a grid, ~3,000 wall segments and 120 labels per sheet), 1440×900
window, counted by instrumenting the page:

| | as shipped | with the list's height bounded |
|---|---|---|
| Thumbnail renders after opening | ~40,000 projected; 42,000 at 60 s and still climbing | **2,014**, then none |
| Time to read every title block | ~90–110 s | **~8 s** |
| Jump to another sheet, while that runs | **~3,000 ms**, regardless of distance | **60 ms** |
| Zoom in, while that runs | **~3,900 ms** | **87 ms** |

The jump cost was the same for sheet 2 as for sheet 199, and a main-thread profile put the time in
`fillText` and `save` — the thumbnails' text, not the page being navigated to. The main view itself
behaved correctly throughout: two tiles on screen at a time, released as expected.

At 1,000 sheets, a size construction sets reach, the same arithmetic is about a million thumbnail
renders.

### What we did in the meantime

We bound the list's height in our own stylesheet:

```css
.mpdf-sheet-list {
  max-height: min(60vh, 720px);
}
```

That makes the list the scrolling element the observer already assumes, so only thumbnails in view
are drawn and defect 3 goes away. It restores what your stylesheet's `overflow-y: auto` evidently
intended, and it has a second benefit: with 200 thumbnails, the unbounded list pushed every panel
below it — tool chest, specifications — about 20,000 px down the sidebar.

It does not touch defects 1 and 2. The panel still rebuilds 200 times after opening; each rebuild is
merely cheap now.

### Suggested fixes, any one of which breaks the quadratic

- **`setSheet`**: skip the emit when the incoming metadata equals what is stored.
- **The panel**: update the one card for `meta.page` on `sheet:changed` instead of rebuilding the
  list — or at least coalesce rebuilds into one per animation frame, so a burst of 200 becomes one.
- **The observer**: use the nearest scrolling ancestor as `root` (or `null` for the viewport), so
  laziness does not depend on a stylesheet giving the list a height.
- **The reader**: batch the extraction and set every sheet at once, rather than one `setSheet` per
  page with an `await` between each.

### Regression guard on our side

Our browser suite opens the 200-sheet set, waits for title blocks to be read, and fails if more than
8,000 thumbnails were drawn — a count, so machine speed cannot move it. It fails at ~57,000 with the
height bound removed. If any of the fixes above lands, the count should fall further, and we will
drop our CSS.
