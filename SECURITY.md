# Security

## Reporting a vulnerability

Report privately, not in a public issue.

Use GitHub's [private vulnerability reporting](https://github.com/ibuilder/SheetForge/security/advisories/new)
on this repository. If that is unavailable to you, open a public issue saying only *"security issue,
please provide a private channel"* — no detail — and a maintainer will respond.

Please include what you did, what happened, what you expected, and the build you were on. A proof
of concept helps enormously. **Do not attach a real project's drawings**; a synthetic file that
reproduces the problem is worth more to us and safer for you.

| | |
|---|---|
| Acknowledgement | Within 5 working days |
| Initial assessment | Within 10 working days |
| Fix or documented mitigation | Depends on severity; we will tell you the plan and keep you updated |
| Credit | Offered in the advisory and the changelog, or withheld if you prefer |

This is a small project and those are targets, not a contractual SLA. We would rather state that
plainly than publish numbers we cannot keep.

**Supported:** the latest release only, until the project reaches 1.0.

---

## The threat model in one page

SheetForge is a local-first desktop and mobile application. It has no server, no account and no
network dependency for its core function. That removes whole categories of risk and concentrates
what remains into three places.

### 1. The documents

A drawing set arriving by email from a subcontractor is the normal case, which makes *"open this
PDF"* the widest attack surface in the product. Every PDF, attachment, imported project package and
interchange file is treated as hostile:

- **Sniffed before it is written.** A renamed `.docx`, a truncated download or an HTML error page
  saved as `.pdf` is refused at the door rather than discovered by the renderer.
- **Bounded.** Size, page count, decompressed size, archive entry count, concurrent job count and
  per-job wall time all have configured ceilings. They are in one place —
  [`sf-security`](crates/sf-security/src/lib.rs) — so they can be audited, and they are surfaced to
  the interface so it can refuse a file before spending a minute reading it.
- **Parsed off the UI thread**, in cancellable work, so a hostile document degrades into a refusal
  rather than a hang.
- **Never trusted for its own claims.** A page count is counted, not read out of `/Count`.

### 2. The renderer boundary

The interface is a webview. It is treated as untrusted **even though it is loaded from bundled
assets**, because an XSS in a document-adjacent interface is a realistic bug and the blast radius
of one should be *"they can do what the user could do in the interface"*, not *"they can read the
disk"*.

| | |
|---|---|
| Filesystem plugin | **Not enabled.** There is no `fs` capability |
| Shell / process execution | **Not enabled** |
| Generic bridge command | **Does not exist.** The command surface is enumerated in [`commands.rs`](apps/desktop/src-tauri/src/commands.rs) and is about eighteen named calls |
| Commands that take a path | **None.** Where a file must be chosen, the native picker runs in Rust and only an opaque id crosses the boundary |
| Content Security Policy | Strict. No `unsafe-eval`, no inline script, no remote origins. `style-src` allows inline styles, which the drawing engine needs and which does not permit code execution |
| Navigation | The webview cannot navigate away. A hyperlink inside a drawing is handed to the *system* browser, restricted to `http` and `https` |
| Asset protocol | Disabled |
| Drag-and-drop of files onto the window | **Enabled, handled in Rust.** Tauri delivers a drop as a *window* event, so the paths reach the host and never the webview. The renderer is told only that drawings arrived |
| Devtools in release builds | Absent |

Permissions are declared per capability file under
[`apps/desktop/src-tauri/capabilities/`](apps/desktop/src-tauri/capabilities/) and are readable in
about a minute. That is the point of them.

Payloads from the webview are schema-validated and bounded on arrival: a markup id that is not a
UUID is refused before it reaches the store, and a geometry payload has a size ceiling because a
row with no ceiling is a memory-exhaustion primitive that arrives looking like a drawing.

### 3. The project package

A `.sfproj` folder from somebody else is untrusted in its entirety — the manifest, the entry names,
the PDFs and the database alike.

- Every path built from a value inside it goes through `contained_path`, which refuses `..` at any
  depth, absolute paths, drive letters, UNC prefixes, null bytes, and anything that resolves
  outside the package once symbolic links are followed.
- Filenames are checked against the rules of *every* supported platform, not just the running one,
  so a package written on macOS opens on Windows.
- Drawings are content-addressed. A package whose drawings have been altered on disk fails
  `verify()` rather than opening with different drawings than the markups were made against.

---

## What the audit trail promises

Each entry carries the digest of the one before it, and its own digest covers both. Altering one
entry, removing one or reordering two breaks every digest downstream, and verification names the
first entry that fails. The `audit_events` table additionally carries `BEFORE UPDATE` and
`BEFORE DELETE` triggers, so the immutability is a property of the file rather than a habit of the
code.

**It is tamper-evident, not tamper-proof.** Someone with write access to the folder can drop the
triggers and recompute the whole chain from the point of their edit forward. Making that impossible
needs a key they do not hold — a server-side notary or an HSM countersignature — which is a
deployment decision, not something a local application can assert on its own. The chain hash is
exactly the value such a notary would sign, so the upgrade path is open.

Truncating the tail of the log is the one edit a bare chain cannot detect; the sequence number is
what makes it visible against an external high-water mark.

---

## What is logged

Never: document text, OCR output, markup body text, filesystem paths, tokens, credentials, or
customer PII.

Error messages that cross the IPC boundary, reach a log line or land in a diagnostic bundle are
built to be safe to show and safe to keep — and there are tests asserting exactly that, because
this is the kind of guarantee that decays silently. Messages from the OS or from a dependency,
which can name a path, are passed through a redaction pass first.

---

## Updates

Update payloads are signed, and the signature is verified against a public key compiled into the
application before anything is applied. An unsigned or mis-signed payload is discarded.

**Not yet done, and it matters:** release binaries are not signed with an organisation code-signing
certificate, so Windows SmartScreen and macOS Gatekeeper will warn on install. Until that is in
place, verify the checksums published with each release. Tracked in
[docs/runbooks/release.md](docs/runbooks/release.md).

---

## Hardening for a managed deployment

| Concern | Where it is handled | What you must still do |
|---|---|---|
| Who may do what | `Role` / `Capability` in `sf-security`; checked before every act, refusals audited | Substitute your directory's answer. The built-in roles assume one person owns their own files |
| Resource ceilings | `ResourceLimits`, one struct, serialisable | Tighten via policy if your estate needs it |
| Data at rest | The package is a folder | Use full-disk encryption. SheetForge does not encrypt the package itself — see below |
| Audit retention | `audit.ndjson` exports the trail portably | Ship it to your own pipeline |
| Update control | Signed payloads, endpoint in config | Point the endpoint at your own mirror if you defer or pin versions |

**No at-rest encryption in this version.** Adding it without a documented key lifecycle, a recovery
policy and an enterprise key-management path would produce a project that cannot be opened after a
laptop is replaced — which is worse than the problem it solves. Full-disk encryption is the honest
answer today. Tracked on the [roadmap](docs/roadmap.md).

---

## Known limits

Stated because a security document that lists only strengths is not a security document.

1. **A local check binds an honest user, not an attacker with the machine.** On a single-user
   install the user *is* the trust boundary; the capability model stops mistakes and malformed
   files. It becomes load-bearing when a package arrives from somebody else, which is the normal
   case on a construction job.
2. **The PDF renderer is pdf.js, running in the webview.** It is well-tested and widely deployed,
   and it is still a large parser processing hostile input. The limits above bound the damage; they
   do not eliminate the surface.
3. **No third-party security audit has been done.** No penetration test, no formal review.
4. **No fuzzing corpus yet.** Hostile-input handling is covered by unit tests and bounds checks,
   not by a fuzzer. This is the largest single gap and is first on the security roadmap.
5. **Binaries are unsigned.** See above.
6. **Dependency supply chain.** `cargo deny` and an npm licence check run in CI; there is no
   reproducible-build guarantee and no SBOM signing yet.

[docs/status.md](docs/status.md) tracks all of these against what has actually been verified.
