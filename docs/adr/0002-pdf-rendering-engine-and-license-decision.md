# 0002 — Renderer: pdf.js in the webview

**Status:** Accepted · 2026-08-20

## Context

Something has to turn a PDF into pixels.

| Candidate | Licence | Notes |
|---|---|---|
| **pdf.js** | Apache-2.0 | Runs in the webview. Mature; enormous deployment surface via Firefox |
| **Pdfium** | Apache-2.0 (BSD-3 in parts) | Native, fast, needs a per-platform binary and an FFI layer |
| **MuPDF** | AGPL-3.0 or commercial | Excellent, and its licence is incompatible with how this is distributed |

## Decision

**pdf.js, in the webview** — behind the drawing engine's own renderer interface, so it stays
replaceable.

1. **The markup layer is already in the webview.** Markups are SVG over a rasterised page. A native
   renderer would mean shuttling tiles across the IPC boundary on every zoom and pan, and the
   coordinate mapping — the richest source of bugs in a markup tool — would straddle two languages.
2. **Licence.** Apache-2.0 with a patent grant: compatible with this project and with somebody
   else's proprietary fork. MuPDF is ruled out for a permissively-licensed distribution; an AGPL
   renderer inside a shipped desktop binary is not a fight worth having.
3. **One renderer on five platforms**, including mobile, where a Pdfium build would be another
   per-target binary to compile, sign and ship.
4. **It is among the most-attacked PDF parsers in the world** and gets fixed accordingly.

## What it costs

- **Slower than native on very large sheets.** A D-size drawing at 800% is roughly 27k x 17k device
  pixels; the engine tiles the visible region into modest canvases to stay under per-canvas limits,
  which is more machinery than a native renderer needs.
- **The parser sits inside the boundary we control least.** Mitigated by resource limits and a
  strict CSP — see [ADR-0005](0005-desktop-security-capabilities-and-threat-model.md) — not
  eliminated.
- **No native fallback** for a page pdf.js cannot handle.

## What would reverse it

Measured rendering performance failing an agreed budget on a real drawing set on the lowest
supported hardware. Pdfium would then go behind the same interface for rasterisation while markup
stays in the webview — the interface exists so that is a contained change.

MuPDF stays prohibited unless a commercial licence is purchased and recorded.
