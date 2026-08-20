# Privacy

## The short version

SheetForge does not send your drawings anywhere. There is no account, no cloud service, no
analytics and no telemetry. The application works with the network cable out, and that is not a
degraded mode — it is the design.

## What is collected

**Nothing.** No usage data, no crash reports, no analytics, no licence check, no phone-home.

The one network request the application can make is an update check against the endpoint in its
configuration, which sends what an HTTPS request sends: your IP address, and the version you are
running. It can be turned off, and it is the only outbound connection in the product.

There is no telemetry to opt out of because there is none to opt into. If that ever changes it
will be opt-**in**, it will be announced in the changelog, and document content will never be part
of it.

## What is stored, and where

Everything lives in the project folder you chose:

```
Your Project.sfproj/
  manifest.json       what this project is
  database.sqlite     markups, scales, the audit trail
  sources/            your drawings, byte-identical to what you imported
  attachments/        photos and files you pinned to markups
  cache/              thumbnails and rendered tiles — delete freely
  audit.ndjson        the audit trail, if you exported it
```

Plus two things outside it:

- **A log file** in the OS log directory. It records that the application started, that a document
  was opened, and that an operation failed — never document content, markup text, paths, or
  credentials.
- **A WebView profile** in the OS application-data directory, created by the system webview.

Delete the project folder and the project is gone. There is no other copy.

## What the audit trail contains

Who did what, when, and to which record: an actor label, an action name, a markup or revision id, a
page number, and a timestamp. Deliberately **not** the content that was acted on — it records that
a markup was created, not what it said.

The actor label is whatever identity the application was configured with; on a plain install it is
`local`. SheetForge does not read your name, your email or your directory account unless you
configure one.

## When you share a project

A `.sfproj` folder contains your drawings, your markups, your markup text and your audit trail. If
you hand it to somebody, you have handed them all of that. Exports carry less — a CSV carries the
register and the quantities, an XFDF the markups, a flattened PDF the drawing with the markups
burned in — but check what you are sending before you send it.

## If you turn on OCR

OCR is off by default and you choose the recogniser.

- **An on-device recogniser** keeps the page on your machine.
- **A cloud service** sends the rasterised page to that provider, under their terms and their
  privacy policy, not this one.

SheetForge tells you which you have configured. That choice is yours because whether drawings may
leave the building is not something this application can know.

## Children

Not directed at children and it collects nothing from anyone.

## Changes

Material changes to this document appear in [CHANGELOG.md](CHANGELOG.md). This document describes
the software's behaviour; it is not a contract, and it is not legal advice. An organisation
deploying SheetForge under a regulatory obligation should have counsel confirm that this
description meets it.
