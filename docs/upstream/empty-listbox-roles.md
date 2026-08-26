**Title:** Empty panels keep `role="listbox"`, so a screen reader announces options that are not there

**Found against:** `36794b3c54fcfd62e3a0d2d5984cfc45cac83340`
**Tool:** axe-core, WCAG 2.1 A/AA · rule `aria-required-children` · **critical**

---

### What happens

Three panels — Markups, Issue pins and Saved views — declare `role="listbox"` (or `role="list"`)
and keep that role when they hold nothing. Empty, each contains a single paragraph of explanatory
text, which is not a permitted child of `listbox`.

A screen reader announces a list of options. Somebody navigating by list is told there is something
to choose from, moves into it, and finds a sentence. There is no way to tell from the announcement
that the panel is simply empty — it sounds like a list whose contents failed to load.

### Reproducing

1. Open any document with no markups, no issue pins and no saved views — a freshly imported
   single-sheet PDF will do.
2. Run axe-core over the page, or navigate the three panels with a screen reader.

axe reports `aria-required-children` against each panel.

### Suggested fix

Drop the role while the collection is empty, and restore it when it is not. The explanatory
paragraph then reads as ordinary text, which is what it is.

We hit exactly this in our own sheet list and fixed it that way:

```js
if (rows.length === 0) {
  list.removeAttribute("role");
  list.removeAttribute("tabindex");
  list.removeAttribute("aria-activedescendant");
  // ... show the explanatory paragraph
  return;
}
list.setAttribute("role", "listbox");
list.setAttribute("tabindex", "0");
```

Removing `tabindex` matters as much as the role: an empty listbox that keeps a tab stop strands a
keyboard user on a control with nothing in it.

### Why we are reporting rather than patching

It is in the engine's own DOM and we do not own that markup. We have listed it in our accessibility
suite as a known upstream defect rather than excluding it, so a new defect still fails our build —
which also means our suite will start failing when this is fixed, and that is how we will know to
drop the entry. A note on the fixing PR would save us the guess.
