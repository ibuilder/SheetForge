# 0001 — Shell: Tauri 2, not Electron

**Status:** Accepted · 2026-08-20

## Context

The drawing engine is a browser library: pdf.js for rasterisation, canvas and SVG for markup, real
DOM for the panels. So the shell's job is to host a webview and own everything a webview must not
own — the filesystem, the project database, native dialogs, the update channel.

Two shells could do that. The product has to run on Windows, macOS **and mobile**, because a
superintendent reviews drawings on a tablet on site and that is not a secondary use case.

## Decision

**Tauri 2.**

1. **Mobile.** Tauri 2 targets iOS and Android from the same codebase. Electron does not target
   mobile at all. On its own this decides it: half the product's platforms are unreachable
   otherwise.
2. **The native side wants to be Rust.** The document domain, the invariants, the local store, the
   hostile-input bounds and the audit chain are all things better written in a language that makes
   their failure modes hard to reach. Electron's native side is Node, which is a fine language and
   the wrong one for this particular set of jobs.
3. **The security boundary is declarative.** Tauri's capability files enumerate what the renderer
   may reach, in about a minute of reading. Electron's equivalent is a set of `webPreferences` plus
   IPC-handler discipline that has to be re-verified by reading code.
4. **Size.** Roughly 10 MB against roughly 120 MB, which matters to a subcontractor on a site
   connection.

## What it costs

- **A second toolchain.** Contributors need Rust and a platform C++ toolchain, not just Node. That
  is a real barrier to casual contribution and we accept it.
- **Two webviews, not one.** WebView2 on Windows and WKWebView on macOS and iOS behave differently.
  Electron ships one Chromium everywhere and that is genuinely simpler. The drawing engine's own
  suite already runs on Chromium, WebKit and Firefox precisely because per-canvas limits, pointer
  dispatch and IndexedDB semantics differ, so the cost is partly already paid.
- **A smaller ecosystem.** Fewer worked examples, fewer plugins, more first-party work.

## What would reverse it

- A required capability that exists only as a maintained Electron-specific SDK and cannot be built
  safely in Rust.
- WKWebView proving unable to render large drawing sets acceptably. This is the live technical risk
  and it is measured rather than assumed — see [status.md](../status.md).

Reversing would mean dropping mobile or maintaining two shells. The bar is high on purpose.
