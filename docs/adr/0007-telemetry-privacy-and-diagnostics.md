# 0007 — No telemetry at all

**Status:** Accepted · 2026-08-20

## Context

Telemetry makes software better. It also means an application that opens confidential construction
drawings is making outbound connections about what the user is doing, and the industry SheetForge
serves is one where a client can and will ask whether their drawings touched a third party.

The usual compromise — anonymous, aggregated, opt-out — was considered and rejected.

## Decision

**None. No usage data, no crash reports, no analytics, no licence check, no phone-home.**

Reasons, in the order they actually weighed:

1. **The promise is worth more than the data.** "Your drawings never leave your machine" is a
   sentence a subcontractor can take to their client. "Anonymous aggregated telemetry, opt-out" is
   a sentence that starts a procurement conversation. For this market that trade is not close.
2. **Anonymous is hard to mean.** A project name, a sheet count and a file size are jointly
   identifying on a job everybody in the region knows about.
3. **Opt-out is not consent** in several of the jurisdictions this will be used in.
4. **It removes a whole class of bug.** There is no redaction pipeline to get wrong, no consent
   state to mishandle, no endpoint to leak to.

The one outbound connection is the update check, which sends what an HTTPS request sends and can be
turned off.

### Instead: a diagnostic bundle the user assembles and reads

When something goes wrong, the user exports a bundle containing the application version and build
provenance, OS and graphics adapter facts, sanitised logs, and the feature-flag and configuration
summary. Never documents, never markup text, never paths.

They can read it before they send it, and they choose whether to send it at all. That is slower for
us and correct for them.

## What it costs

- **We do not know what is slow, or what crashes, until somebody tells us.** This is a genuine
  product cost and it will hurt.
- Adoption and retention are unmeasurable.
- Performance work relies on benchmarks against fixtures rather than on field data.

## What would reverse it

Nothing short of a different product for a different market. If a future component ever needs
telemetry it will be opt-**in**, announced in the changelog, and document content will never be
part of it.
