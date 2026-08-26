**Title:** The drawing scroller cannot be focused, so scrolling a sheet needs a pointer

**Found against:** `36794b3c54fcfd62e3a0d2d5984cfc45cac83340`
**Tool:** axe-core, WCAG 2.1 A/AA · rule `scrollable-region-focusable` · **serious**

---

### What happens

The element that scrolls the drawing is a scrollable region with no keyboard focus. A keyboard-only
user can page, zoom and fit — the engine's own shortcuts cover those well — but cannot scroll
*within* a page. On a D-size sheet at any useful zoom, that is most of the drawing.

Fit-page technically reaches every part of the sheet, but at a scale where the lettering a reviewer
is trying to read is a few pixels tall. So the content is not genuinely reachable without a mouse.

### Reproducing

1. Open a large sheet — ARCH D or A1.
2. Zoom to 200% or more.
3. Put the mouse down and try to reach the bottom-right of the sheet using only the keyboard.

axe reports `scrollable-region-focusable` against the scroller.

### Suggested fix

`tabindex="0"` on the scrolling element, plus an accessible name so the tab stop announces as
something rather than as an unlabelled group — `aria-label="Drawing"` or similar. Browsers give
arrow-key scrolling to a focused scrollable region for free, so the behaviour largely comes with
the attribute.

Worth checking it lands in a sensible tab order relative to the toolbar, so tabbing from the last
tool reaches the drawing rather than skipping past it.

### Why this one matters more than the axe severity suggests

This is a document review tool. "You can see the whole sheet, but only at a zoom where you cannot
read it" is close to saying the product does not work without a mouse — for exactly the users least
likely to have precise pointer control.

### Why we are reporting rather than patching

The scroller is created and owned by the engine. As with the listbox defect, it is listed in our
accessibility suite as known-upstream rather than excluded, so our build will notice when it is
fixed.
