# Threat model

The condensed version is in [SECURITY.md](../../SECURITY.md); this is the working version, in the
form the team actually reasons with.

## What we are protecting

| Asset | Why it matters |
|---|---|
| The drawings | Client confidential, sometimes security-sensitive (a building's services layout), somebody else's copyright |
| The markups | Contract evidence. "Who said this dimension was wrong, and when" |
| The audit trail | The thing that makes the above evidence rather than assertion |
| The quantities | A bid is built on them |
| The user's machine | The application opens files from strangers |

## Who we are defending against

| | Capability | In scope |
|---|---|---|
| **A hostile document** | Crafted PDF, attachment, XFDF, BCF or project package, arriving by email from a subcontractor | **Yes — the primary adversary** |
| **A compromised renderer** | XSS or a dependency compromise inside the webview | **Yes** |
| **A careless or curious user** | Moves files inside a package, edits the database with a SQLite browser | **Yes** |
| **A dishonest insider** | Wants to alter a markup or the trail after the fact to change what the record says | **Partly** — tamper-*evident*, not tamper-proof |
| **A network attacker** | On the path for the update check | **Yes** — signed payloads, TLS |
| **An attacker with the machine** | Full local access, can run anything as the user | **No** — out of scope for a local application |
| **A malicious maintainer / supply chain** | Publishes a compromised release | **Partly** — signing and licence policy help; no reproducible builds yet |

## The attacks we actually expect

### 1. A crafted PDF that exhausts memory or hangs the application

*Vector:* a page tree claiming millions of pages, a decompression bomb, a pathological content
stream.

*Mitigation:* size, page-count, decompressed-size and per-job time limits, all in one auditable
struct. Page counts are counted, not read from the file's own claim. Parsing runs off the UI thread
in cancellable work.

*Residual:* pdf.js is a large parser and the limits bound the damage rather than removing the
surface. **No fuzzing corpus yet** — the largest open gap.

### 2. A crafted project package that writes outside itself

*Vector:* a manifest naming `../../../../etc/passwd`, an absolute path, a UNC path, a null byte
truncating the path at the syscall, or a symlink inside the package pointing out of it.

*Mitigation:* every path is built through `contained_path`, which refuses all of those on the
components before touching the filesystem, then re-checks against the canonicalised root for
anything that exists. 28 tests, including the symlink case.

*Residual:* a package can still be enormous; the size limits bound that.

### 3. A compromised renderer reaching the disk

*Vector:* XSS in the interface, or a compromised npm dependency.

*Mitigation:* no filesystem capability, no shell, no generic bridge, no command taking a path, no
navigation away, no asset protocol, strict CSP with no `unsafe-eval`, and a command surface of
about eighteen named calls. What an attacker gains is the ability to do what the user could already
do in the interface.

*Residual:* that is still meaningful — reading and exporting the open project. Bounded by the
capability model.

### 4. Someone altering the record after the fact

*Vector:* editing `database.sqlite` directly to change a markup or remove an audit entry.

*Mitigation:* the trail is hash-chained, so one altered entry breaks every digest after it, and
verification names the first failure. `BEFORE UPDATE` and `BEFORE DELETE` triggers make the
immutability a property of the file. Drawings are content-addressed, so swapping one under a set of
markups fails verification.

*Residual:* **an attacker who drops the triggers can recompute the whole chain forward.** This is
stated openly in SECURITY.md. Closing it needs a key the local machine does not hold — a notary or
an HSM countersignature — which is a deployment decision. The chain hash is the value such a notary
would sign.

Truncating the tail is the one edit a bare chain cannot detect; the sequence number makes it visible
against an external high-water mark.

### 5. A malicious update

*Vector:* DNS or TLS compromise, or a compromised release pipeline.

*Mitigation:* payloads are signed and verified against a key compiled into the binary. The private
half exists only in the release secret store.

*Residual:* binaries are not yet code-signed with an organisation certificate, so the OS cannot
attest the publisher. No reproducible builds, so a compromised pipeline could not be detected by
rebuilding.

### 6. Data leaking through logs, errors or a diagnostic bundle

*Vector:* a drawing's filename in an error message; markup text in a log; a path in a support
bundle.

*Mitigation:* every error message that crosses the boundary is built to be safe, with tests
asserting no path, filename or SQL appears. Messages from the OS or a dependency go through a
redaction pass. There is no telemetry at all, so there is no pipeline to leak through.

*Residual:* redaction is best-effort on strings we did not author.

## Review

This model is reviewed when a new input format is accepted, a new command is added, a capability is
widened, or a dependency with a parser is introduced. Changes are recorded in an ADR.
