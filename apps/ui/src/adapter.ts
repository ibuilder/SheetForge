/**
 * The drawing engine's `StorageAdapter`, backed by the Rust project store.
 *
 * The engine batches its writes and hands them over as a list of mutations — one drag, one bulk
 * import, one round trip. This adapter turns each into the host command that matches, and does
 * three things the engine cannot do for itself:
 *
 * 1. **Quotes the concurrency token.** The host refuses a write made against a stale version. The
 *    adapter tracks the version the host last returned for each markup and sends it back, so a
 *    genuine concurrent edit surfaces as a `ConflictError` the engine's conflict dialog can show,
 *    rather than as one of two edits silently disappearing.
 * 2. **Walks the status workflow.** See {@link statusPath} — a move the host's state machine will
 *    not take in one step is taken in two, rather than refused.
 * 3. **Keeps going after one bad record.** A batch is not a transaction: if one markup in a
 *    hundred fails, the other ninety-nine are still saved and the failure is reported. Failing the
 *    whole batch would discard work the user has already done.
 */

import type { LoadResult, Mutation, StorageAdapter, StoreKey } from "@massingcloud/pdf-viewer";
import { ConflictError } from "@massingcloud/pdf-viewer";
import type { HostMarkup } from "./bridge";
import { host, isCommandError } from "./bridge";
import {
  fromHostCalibration,
  fromHostMarkup,
  statusPath,
  toHostCalibration,
  toHostMarkup,
  toHostMetadata,
  toHostQuantity,
  toHostStatus,
} from "./mapping";

/** What the adapter knows about a markup the host has confirmed. */
interface Known {
  version: number;
  status: HostMarkup["status"];
}

/**
 * Persists the engine's markups into the open SheetForge project.
 *
 * One instance per open document. `StoreKey.documentId` carries the host's revision id, which is
 * what the engine is told to use as its document key when a project is open.
 */
export class HostAdapter implements StorageAdapter {
  readonly id = "sheetforge-host";

  /**
   * Versions the host has confirmed, by markup id.
   *
   * Held here rather than read back before every write, because a read-then-write is both a second
   * round trip and a wider race than sending the version the caller actually edited against.
   */
  private readonly known = new Map<string, Known>();

  /** The document this adapter is currently bound to, so a conflict can be re-read against it. */
  private documentId: string | undefined;

  async load(key: StoreKey): Promise<LoadResult> {
    this.documentId = key.documentId;
    const markups = await host.markupList(key.documentId);
    this.known.clear();
    const annotations = markups.map((markup) => {
      this.known.set(markup.id, { version: markup.version, status: markup.status });
      return fromHostMarkup(markup);
    });

    // Calibrations are per page and the host has no "list them all" query, because the number of
    // pages is knowable and a per-page read is indexed. Pages with no scale come back null and are
    // dropped rather than defaulted — an absent scale is a state the engine shows.
    const pages = [...new Set(annotations.map((annotation) => annotation.page))];
    const calibrations = (await Promise.all(pages.map((page) => host.calibrationGet(key.documentId, page))))
      .filter((calibration) => calibration !== null)
      .map(fromHostCalibration);

    return { annotations, calibrations };
  }

  async save(key: StoreKey, mutations: Mutation[]): Promise<void> {
    this.documentId = key.documentId;
    const conflicts: { id: string; mine?: unknown; theirs?: unknown }[] = [];
    const failures: string[] = [];

    // Creates are batched. The engine hands over a whole import as one list of mutations, and
    // sending them one at a time costs an IPC round trip and a disk flush each — about fifty times
    // the cost of doing them together. Everything else stays sequential: an update depends on the
    // version the previous one produced.
    const remaining = await this.createInBulk(key, mutations);

    for (const mutation of remaining) {
      try {
        await this.applyOne(key, mutation);
      } catch (error) {
        if (isCommandError(error) && error.code === "version-conflict") {
          // The engine's dialog wants both sides. `theirs` is fetched rather than guessed so the
          // reviewer is comparing against what is actually stored.
          const id = mutationId(mutation);
          const theirs = id ? await this.currentOrUndefined(id) : undefined;
          conflicts.push({ id: id ?? "unknown", ...(theirs ? { theirs } : {}) });
          continue;
        }
        // Recorded and carried past, so one bad record does not discard the rest of the batch.
        failures.push(isCommandError(error) ? error.message : String(error));
      }
    }

    if (conflicts.length > 0) throw new ConflictError(conflicts as never);
    if (failures.length > 0) {
      throw new Error(
        failures.length === 1
          ? failures[0]
          : `${failures.length} markups could not be saved. The first said: ${failures[0]}`,
      );
    }
  }

  online(): boolean {
    // The host is a local process. It is reachable whenever the application is running, which is
    // the point of the product: a superintendent in a basement is not offline, they are local.
    return true;
  }

  /**
   * Send every mutation that is a *new* markup as one call, and return the rest untouched.
   *
   * "New" means one this adapter has no version for — the same test `applyOne` uses. An import
   * arrives as hundreds of those in a single batch, which is the case worth optimising; an
   * ordinary edit session produces one at a time and takes the same path it always did.
   *
   * A failure here falls back to sending them individually rather than losing the batch, because
   * one malformed record among five hundred should not discard the other four hundred and
   * ninety-nine.
   */
  private async createInBulk(key: StoreKey, mutations: Mutation[]): Promise<Mutation[]> {
    const creates = mutations.filter(
      (mutation): mutation is Extract<Mutation, { op: "upsert" }> =>
        mutation.op === "upsert" && !this.known.has(mutation.annot.id),
    );
    // Below this the round trip dominates and the added complexity buys nothing measurable.
    if (creates.length < 5) return mutations;

    try {
      const stored = await host.markupCreateMany(
        creates.map((mutation) => toHostMarkup(mutation.annot, key.documentId)),
      );
      creates.forEach((mutation, index) => {
        const created = stored[index];
        if (!created) return;
        const known = { version: created.version, status: created.status };
        this.known.set(created.id, known);
        // The engine's own id too, so a later edit of the same annotation finds its version.
        this.known.set(mutation.annot.id, known);
      });
      const sent = new Set<Mutation>(creates);
      return mutations.filter((mutation) => !sent.has(mutation));
    } catch {
      // The batch is all-or-nothing on the host side, so nothing was written. Fall through and let
      // each record succeed or fail on its own merits: one malformed markup among five hundred
      // should not discard the other four hundred and ninety-nine.
      //
      // Deliberately not recorded as a failure here. The individual attempts that follow report
      // their own, and reporting this too would tell the user about an error that was retried and
      // may well have succeeded.
      return mutations;
    }
  }

  private async applyOne(key: StoreKey, mutation: Mutation): Promise<void> {
    switch (mutation.op) {
      case "upsert": {
        const annotation = mutation.annot;
        const known = this.known.get(annotation.id);
        if (!known) {
          const created = await host.markupCreate(toHostMarkup(annotation, key.documentId));
          this.known.set(created.id, { version: created.version, status: created.status });
          // The host mints its own id. Recording the engine's id against it as well means a second
          // save of the same annotation updates rather than duplicating.
          if (created.id !== annotation.id) {
            this.known.set(annotation.id, { version: created.version, status: created.status });
          }
          return;
        }

        const target = toHostStatus(annotation.status);
        let version = known.version;

        // Status first and on its own: each step is a distinct act in the audit trail, and the
        // host bumps the version on every one of them.
        for (const step of statusPath(known.status, target)) {
          const moved = await host.markupUpdate(annotation.id, { status: step }, version);
          version = moved.version;
        }

        const quantity = toHostQuantity(annotation);
        const updated = await host.markupUpdate(
          annotation.id,
          {
            geometry: annotation as unknown as Record<string, unknown>,
            geometrySchema: 1,
            metadata: toHostMetadata(annotation),
            ...(quantity ? { quantity } : { clearQuantity: true }),
          },
          version,
        );
        this.known.set(annotation.id, { version: updated.version, status: updated.status });
        return;
      }

      case "remove": {
        const known = this.known.get(mutation.id);
        // Nothing recorded means the host never saw it — deleting it is already done.
        if (!known) return;
        await host.markupDelete(mutation.id, known.version);
        this.known.delete(mutation.id);
        return;
      }

      case "calibration": {
        // A null calibration is the engine clearing a page's scale. The host models a scale as
        // present or absent per page and has no "unset" command yet, so this is left alone rather
        // than approximated by writing a scale of 1, which would silently make every quantity on
        // the page wrong instead of underived.
        if (!mutation.calibration) return;
        await host.calibrationSet(toHostCalibration(mutation.calibration, key.documentId));
        return;
      }

      case "sheet":
        // Sheet metadata — title block, sheet number, issue date — is extracted by the engine and
        // is not yet part of the host's schema. It stays in the engine's own record rather than
        // being dropped: the annotation payload carries it, so nothing is lost, and the host gains
        // a sheets table when the register needs to be queried rather than merely displayed.
        return;
    }
  }

  /** What the host currently holds for a markup, for the conflict dialog to show alongside ours. */
  private async currentOrUndefined(id: string): Promise<unknown> {
    if (!this.documentId) return undefined;
    try {
      const all = await host.markupList(this.documentId);
      const found = all.find((markup) => markup.id === id);
      if (found) {
        // Re-reading also refreshes what we know, so the reviewer's resolution is written against
        // the version that actually caused the conflict rather than the stale one.
        this.known.set(id, { version: found.version, status: found.status });
        return fromHostMarkup(found);
      }
      return undefined;
    } catch {
      // The conflict is real whether or not the other side can be fetched; a failure to show it
      // must not turn into a second, more confusing error.
      return undefined;
    }
  }
}

function mutationId(mutation: Mutation): string | undefined {
  if (mutation.op === "upsert") return mutation.annot.id;
  if (mutation.op === "remove") return mutation.id;
  return undefined;
}
