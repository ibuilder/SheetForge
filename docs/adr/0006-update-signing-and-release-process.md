# 0006 — Signed update payloads; code signing outstanding

**Status:** Accepted, partly unimplemented · 2026-08-20

## Context

An auto-updater is a remote code execution channel that the vendor points at their own users. It is
the highest-value target in a desktop application, and it has to be right before it is convenient.

## Decision

**Update payloads are signed and verified before they are applied.** The public key is compiled
into the binary at build time; the private half exists only in the release infrastructure's secret
store. An unsigned or mis-signed payload is discarded rather than applied.

Supporting rules:

- The signing key is generated once, never committed, never on a developer machine, and never
  passed to a third-party action that could log it.
- Manifests and artefacts are served over TLS with published checksums.
- The user is asked before an update is applied. A construction review at 4pm on a Friday is not
  the moment to restart under a new build without asking.
- Rolling back means publishing a higher version containing the older code — not rewriting a
  release, which would break signature expectations for anyone mid-download.

## What is not done yet, and it matters

**Binaries are not code-signed with an organisation certificate.** The updater's own signature
protects the *channel*; a code-signing certificate is what stops Windows SmartScreen and macOS
Gatekeeper from warning on install, and what proves the publisher's identity to the OS.

That needs an organisational identity, a purchased certificate (or an Apple Developer account) and
an HSM or cloud signing service to hold the key. Until it exists:

- Installers warn on first run.
- Users should check the published checksums.
- This is stated plainly in the README and in SECURITY.md rather than glossed.

Also outstanding: reproducible builds, SBOM signing, and an installer smoke test in a clean VM as a
release gate.

## What it costs

Releases are slower and cannot be cut from a laptop. That is the point.

## What would reverse it

Nothing. The unimplemented parts get implemented; the decision does not change.
