# 0005 — No paths across IPC, and capability-gated commands

**Status:** Accepted · 2026-08-20

## Context

The interface is a webview rendering PDFs that arrive by email from subcontractors. Two questions
follow: what can a compromised renderer reach, and what can a hostile document do?

## Decision

### The renderer never names a file

There is no command that takes a path, no filesystem plugin, no shell access and no generic bridge
command. Where a file must be chosen, the **native picker runs on the Rust side** and only an
opaque id crosses back.

The obvious alternative — `open_file(path)` plus a scope check — was rejected because a scope check
is a filter on an attacker-controlled string, and the history of that pattern is a history of
bypasses: normalisation differences, symlinks, UNC paths, 8.3 short names. Not accepting the string
at all removes the class.

The cost is real: drag-and-drop of a PDF onto the window is disabled in this version, because it
would hand the webview a path. It returns when the drop is handled entirely in Rust.

### The command surface is enumerable

About eighteen named commands, listed in one file. Each validates its payload, authorises the act
against the capability model, calls a domain use case, and maps the typed result. Business rules
are not in them.

### Capabilities are declared, not coded

Three capability files, each a few lines, saying exactly which plugin permissions the window holds.
`opener` is restricted to `http` and `https`, so a hyperlink in a drawing goes to the system browser
and can never navigate the application or reach a custom scheme handler.

Note the boundary honestly: Tauri's ACL governs core and plugin commands. **SheetForge's own
commands are gated by its own capability model in `sf-security`**, checked in Rust before the act,
with refusals written to the audit trail. Hiding a button is not a permission — the store is
reachable from an import, a migration and a host script, so the check lives where every path
crosses.

### Documents are hostile input

Sniffed before anything is written; bounded on size, page count, decompressed size, archive entries,
concurrent jobs and per-job time; parsed off the UI thread in cancellable work; never trusted for
their own claims about themselves.

### Errors carry no paths

Every message that crosses the boundary, reaches a log or lands in a diagnostic bundle is built to
be safe to show and safe to keep, and there are tests asserting it — because this is exactly the
kind of guarantee that decays silently as messages get improved.

## What it costs

- No drag-and-drop in this version.
- Every new file-touching feature needs a Rust-side dialog rather than a frontend one, which is
  more work per feature.
- The capability model duplicates a little of what a server would decide in a managed deployment.

## What would reverse it

Nothing foreseen. A managed deployment would *substitute* the role source, not remove the check.
