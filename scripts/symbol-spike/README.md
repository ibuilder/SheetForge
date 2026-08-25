# Symbol counting spike

Evidence for the vector symbol-counting design in
[ADR-0011](../../docs/adr/0011-counting-symbols-from-vector-content.md). Committed so the claim can
be re-run rather than taken on trust.

```bash
node scripts/symbol-spike/print-plan.mjs scripts/symbol-spike/plan.html /tmp/plan.pdf
node scripts/symbol-spike/count-symbols.mjs /tmp/plan.pdf
```

`plan.html` is a synthetic floor plan — an invented building, drawn here, carrying no third-party
work. It deliberately contains the cases that were expected to break the technique: six doors at
0, 90, 180 and 270 degrees plus two mirrored, fourteen receptacles, eight grid bubbles, and some
non-repeating linework as a control.

Expected output: 31 placed groups resolving to 6 distinct symbols — the door as **one** symbol of
three paths appearing six times with its orientations named, the receptacle as two paths appearing
fourteen times, the bubble as one path appearing eight times, and the control linework as
singletons.

This is a spike, not a component. It is not wired into the application and has no tests; when the
technique becomes a feature it should be reimplemented in the domain with tests, and this directory
deleted.
