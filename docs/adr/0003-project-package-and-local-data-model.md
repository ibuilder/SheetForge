# 0003 — A `.sfproj` directory with SQLite inside

**Status:** Accepted · 2026-08-20

## Context

A project is a set of drawings, thousands of markup records, per-page scales and an audit trail. It
must survive a power cut, be handed to somebody, and open with no network.

Three shapes were considered: one opaque container file; a directory of loose JSON; a directory
with a database inside it.

## Decision

**A directory, with SQLite for the records and content-addressed files for the drawings.**

Against a **single container file**: it would have to be rewritten to add one markup. On a 400 MB
set that is slow, and it is precisely the moment a power cut destroys the whole project rather than
one record.

Against **loose JSON**: "open structural comments on Level 4" would mean parsing every file, and a
status change would mean rewriting one. Worse, there is no atomic multi-record write, so a crash
mid-save leaves an inconsistent set with no way to tell which files are current.

**SQLite** gives indexed queries over the set and an atomic, crash-safe write of one record.
Wrapping it in a **directory** means the large immutable part — the drawings — is written once at
import and never touched again, and when something does go wrong the PDFs are still PDFs that a
file manager can recover.

Supporting choices:

- **One project per package.** The file *is* the project. Otherwise you cannot hand a package to
  somebody without handing over other jobs as well.
- **`synchronous = FULL`**, against the usual WAL advice of `NORMAL`. A tablet losing power in a
  basement is the expected failure here, not the exotic one.
- **Every table `STRICT`.** Otherwise SQLite stores a string in a page-number column and the error
  surfaces days later on read.
- **Forward-only migrations.** A project opened on a newer build and then taken back to an older
  one is refused rather than reverse-migrated by code nobody has tested against that data.
- **Content-addressed drawings.** The SHA-256 is the identity, the filename and the integrity
  check, all at once.

## What it costs

- **A folder looks less like a document** than a single file does, and users may move parts of it.
  Integrity verification turns that from silent corruption into a clear report.
- **Zipping for transport is a separate act.** Deliberate: the user decides when a copy is made.
- **SQLite is a bundled dependency**, adding to binary size and to the audit surface.

## What would reverse it

Users routinely damaging packages by moving files inside them, or a transport story that demands a
single file. The fix would be a zipped container unpacked to a working directory on open — which
keeps the durability properties and changes only what sits on disk at rest.
