/**
 * Asking whether a newer SheetForge exists, and installing it only when the reviewer says so.
 *
 * ## Why this is the one network request
 *
 * ADR-0007 rules out telemetry entirely and makes a single exception: "the one outbound connection
 * is the update check, which sends what an HTTPS request sends and can be turned off." So the check
 * is allowed, and the off switch is not optional — it is the condition the exception was granted
 * on. The preference is read *before* anything is sent: a check the reviewer switched off must not
 * leave the machine at all, which is a different promise from "the result is ignored".
 *
 * ## Why the order is download, save, install
 *
 * On Windows the installer takes over as soon as `install()` runs and the application exits under
 * it — there is no "after" in which to save. So everything that can fail harmlessly happens first:
 * the download, which is also where the signature is verified, changes nothing if it fails. Then
 * the reviewer's markups are saved. Only then is anything installed.
 *
 * ## Why saving is checked rather than awaited
 *
 * The drawing engine's save does not reject when a save fails. It re-queues the markups, schedules
 * a retry, emits a `sync:state` of `error`, and resolves as though nothing happened. Awaiting it and
 * carrying on would install over unsaved work and, on Windows, end the process that was holding
 * it. So `saveAll` is expected to throw when the engine's own state says the save did not land, and
 * a throw there stops the install.
 *
 * ## Why an automatic check never asks
 *
 * A check on start runs a few seconds after launch, which is exactly when somebody is typing a
 * markup. A confirm dialog appearing under their fingers turns a stray Enter into "download, install
 * and restart" — consent nobody gave. So an automatic check only *announces*: it says a version is
 * available and the Project menu offers to install it. Asking happens when the reviewer chooses
 * that, and never at a moment they did not pick.
 *
 * ## What the reviewer is and is not told
 *
 * An automatic check that finds nothing, or cannot reach the server, says nothing at all. This
 * application is meant to be used with the network off, and a complaint on every offline launch
 * would teach people to ignore the status line. A check somebody *asked* for always answers.
 *
 * Failures are reported in fixed wording rather than by echoing the updater's error, which can
 * carry URLs and would be the only place in the interface that showed one.
 */

import type { DownloadEvent } from "@tauri-apps/plugin-updater";

/** Where the off switch lives. Alongside the tutorial flag, and cleared by the same uninstall. */
const PREFERENCE = "sheetforge.update-check";

/**
 * Whether to check on start.
 *
 * On unless the reviewer turned it off — the default ADR-0007 sets. But if the preference cannot be
 * *read*, the answer is no: not knowing whether somebody refused the request is not permission to
 * send it.
 */
export function automaticChecksEnabled(): boolean {
  try {
    return localStorage.getItem(PREFERENCE) !== "off";
  } catch {
    return false;
  }
}

/**
 * Turn checking on start on or off.
 *
 * Returns whether the choice was actually kept, so the caller can say so when it was not. An off
 * switch that silently fails to stay off is worse than none: the reviewer believes it worked.
 */
export function setAutomaticChecks(on: boolean): boolean {
  try {
    if (on) localStorage.removeItem(PREFERENCE);
    else localStorage.setItem(PREFERENCE, "off");
    return automaticChecksEnabled() === on;
  } catch {
    return false;
  }
}

/**
 * The parts of the updater's `Update` this module uses.
 *
 * Narrower than the plugin's class so the logic can be tested without one; the plugin's class
 * satisfies it structurally.
 */
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  download(onEvent?: (event: DownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}

/** Everything the check needs from outside, passed in so each branch can be exercised. */
export interface UpdateDeps {
  /** Ask the server. Rejects when it cannot be reached; resolves null when nothing is newer. */
  check(): Promise<AvailableUpdate | null>;
  /** Ask the reviewer. */
  confirm(message: string): boolean;
  /** Tell the reviewer. */
  status(message: string): void;
  /**
   * Record that a newer version exists, so the menu can offer it after the status line has moved
   * on. A notice that vanishes with the next status message is one most people never see.
   */
  available(version: string): void;
  /** Save every pending markup, and throw if that did not happen. */
  saveAll(): Promise<void>;
  /** Start the new version. Not reached on Windows, where the installer ends the process. */
  relaunch(): Promise<void>;
}

/** How a check ended. Returned for the tests; the reviewer is told through `status`. */
export type UpdateOutcome =
  | "disabled"
  | "current"
  | "unreachable"
  | "available"
  | "declined"
  | "not-saved"
  | "failed"
  | "installed";

/**
 * Check for an update and, with permission, install it.
 *
 * @param manual True when the reviewer asked. A manual check always answers and ignores the
 *   preference — asking *is* the consent.
 */
export async function runUpdateCheck(
  deps: UpdateDeps,
  { manual }: { manual: boolean },
): Promise<UpdateOutcome> {
  if (!manual && !automaticChecksEnabled()) return "disabled";

  let update: AvailableUpdate | null;
  try {
    update = await deps.check();
  } catch {
    if (manual) {
      // Deliberately no cause. This is also what an online machine sees when no release carrying an
      // update manifest has been published yet — the server answered, with nothing — and "could
      // not reach the server" would be a false diagnosis sending somebody to check their network.
      deps.status("Could not check for updates just now. SheetForge works without it; try again later.");
    }
    return "unreachable";
  }

  if (!update) {
    if (manual) deps.status("You have the latest SheetForge.");
    return "current";
  }

  const { version, currentVersion } = update;
  try {
    deps.available(version);
    if (!manual) {
      deps.status(`SheetForge ${version} is available. Install it from the Project menu when it suits you.`);
      return "available";
    }

    const accepted = deps.confirm(
      `SheetForge ${version} is available — you have ${currentVersion}.\n\n` +
        "Download and install it now? Your markups are saved first, then SheetForge restarts.",
    );
    if (!accepted) {
      deps.status(`SheetForge ${version} is available. Install it from the Project menu when you are ready.`);
      return "declined";
    }

    // The download is where the signature is verified, so a failure here — a network drop, or a
    // payload that is not what it claims to be — has changed nothing on this machine.
    deps.status(`Downloading SheetForge ${version}…`);
    let total: number | undefined;
    let received = 0;
    try {
      await update.download((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total) {
            deps.status(`Downloading SheetForge ${version}… ${Math.floor((received / total) * 100)}%`);
          }
        }
      });
    } catch {
      deps.status(
        `SheetForge ${version} could not be downloaded, or did not verify as coming from us. ` +
          "Nothing was installed.",
      );
      return "failed";
    }

    deps.status("Saving your markups before installing…");
    try {
      await deps.saveAll();
    } catch {
      deps.status(
        "Your latest markups could not be saved, so the update was not installed. " +
          "Nothing was changed — try again once the save indicator says everything is saved.",
      );
      return "not-saved";
    }

    deps.status(`Installing SheetForge ${version}…`);
    try {
      await update.install();
    } catch {
      // Not "nothing was changed": an installer that failed part-way cannot promise that. What can
      // be promised is that projects are untouched, because they live outside the application.
      deps.status(
        `SheetForge ${version} could not be installed. Your projects are not affected — ` +
          "they are kept outside the application.",
      );
      return "failed";
    }

    try {
      await deps.relaunch();
    } catch {
      deps.status(`SheetForge ${version} is installed. Restart SheetForge to start using it.`);
    }
    return "installed";
  } finally {
    // The update is a resource held by the host. Released whatever happened, and a failure to
    // release it is not worth a message: there is nothing the reviewer could do about it.
    await update.close().catch(() => {});
  }
}
