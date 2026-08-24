/**
 * Handing bytes to a `Blob` without lying to the typechecker or copying them.
 *
 * `Uint8Array.buffer` is typed `ArrayBufferLike`, which admits `SharedArrayBuffer` — and a `Blob`
 * will not take one, because a shared buffer can be written by another thread while the blob is
 * being read. So `new Blob([someUint8Array])` does not typecheck, and the tempting fix is
 * `as BlobPart`, which silences the checker and keeps the hazard.
 *
 * This narrows instead of asserting. Everything the application produces is backed by a plain
 * `ArrayBuffer` — the zip writer allocates one, `canvas.toBlob` gives a blob already — so the
 * check passes and nothing is copied. If a shared buffer ever does arrive, it is copied into an
 * unshared one rather than being smuggled past the type system.
 *
 * A whole module for one function is a fair complaint. It exists because the alternative was the
 * same three lines of reasoning written twice, or a bare cast, and a bare cast is how a real
 * problem gets filed under "TypeScript being awkward".
 */
export function asBlobPart(bytes: Uint8Array): BlobPart {
  // `instanceof ArrayBuffer` is the narrowing the type system wants and the runtime check that
  // makes it true. `SharedArrayBuffer` is absent in some environments, so this asks what the
  // buffer *is* rather than what it is not.
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  // Shared. Copy into memory nothing else can write to while the blob is read.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
