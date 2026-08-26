**Title:** Feature request — a resolver hook for attachment URLs, so host-stored attachments can show a thumbnail

**Found against:** `36794b3c54fcfd62e3a0d2d5984cfc45cac83340`
**Area:** `attachmentsPlugin`

---

### The situation

`attachmentsPlugin` takes an `upload` hook that returns *"a durable URL"*, which is exactly the
right shape for an application that stores attachment bytes itself. We return
`sf-attachment:<sha256>` — a reference into our own content-addressed store, resolved on demand by
the host process.

Storage works. Opening works, through the `open` hook. **Thumbnails never appear**, and the reason
is that the render path sends the URL through an allowlist that accepts relative, `http`, `https`,
`blob` and `data`, and returns `null` for anything else — at which point the `<img>` is simply not
created.

To be clear: **the allowlist is right.** Refusing an arbitrary scheme in a URL that can arrive from
an imported markup record is what stops a `javascript:` URL getting into the DOM. We are not asking
for it to be loosened.

### Why the obvious workarounds do not work

- **Hand back a `blob:` URL from `upload`.** It is accepted, and it is dead as soon as the window
  reloads — so a stored attachment shows a thumbnail in the session it was added and a broken one
  ever after.
- **Hand back a `data:` URL.** Accepted and durable, but it puts the whole photograph inside the
  markup record, where it then travels through every export and interchange format that carries
  markups. A field review with fifty site photos would be unusable.
- **Serve the bytes over a custom protocol from the host.** Ours is a Tauri application, and Tauri
  serves custom protocols as `http://scheme.localhost/…` on Windows but keeps the custom scheme on
  macOS and Linux. That would pass the allowlist on one platform and fail on the other two —
  thumbnails appearing on Windows only reads as a bug rather than a gap.
- **Resolve after the fact from outside.** The decision to create the image is made at render time,
  so a URL supplied afterwards arrives too late.

### What we would like

An optional resolver on `AttachmentOptions`, consulted before the allowlist for URLs the host owns:

```ts
export interface AttachmentOptions {
  upload?: (file: File, context: { annotId: string; viewer: Viewer }) => Promise<{ url: string; id?: string }>;
  open?: (attachment: AnnotAttachment) => void;
  /**
   * Turn a stored attachment reference into something displayable, for schemes the host owns.
   * Returning null falls through to the existing allowlist unchanged.
   */
  resolve?: (attachment: AnnotAttachment) => Promise<string | null>;
}
```

The host then answers with a short-lived `blob:` URL it also revokes, and the allowlist keeps doing
its job for every URL the host has *not* claimed. Called only for attachments about to be rendered
— which in practice is the selected markup's — it costs one fetch per visible attachment rather
than one per document.

If a hook is unwelcome, a narrower alternative would serve us: let `upload` declare a scheme the
integrator owns, and treat URLs with that scheme as trusted for rendering. We would prefer the
resolver, because it keeps the trust decision explicit at each render rather than global.

### Happy to send a PR

If the shape above looks reasonable we will implement it, with tests, rather than leaving it as a
request. Say which direction you would prefer and we will follow it.
