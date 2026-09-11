/**
 * Updating without surprising anybody.
 *
 * The failures worth testing are the quiet ones: a check sent after the reviewer switched it off,
 * an install that went ahead over markups that never saved, a message claiming "nothing changed"
 * when an installer had half-run. Each of those looks fine from the outside.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  automaticChecksEnabled,
  runUpdateCheck,
  setAutomaticChecks,
  type AvailableUpdate,
  type UpdateDeps,
} from "../src/updates";

/** An update, recording what was done to it and in which order. */
function fakeUpdate(calls: string[], over: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    version: "0.1.2",
    currentVersion: "0.1.1",
    download: vi.fn(async (onEvent) => {
      calls.push("download");
      onEvent?.({ event: "Started", data: { contentLength: 200 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Finished" });
    }),
    install: vi.fn(async () => {
      calls.push("install");
    }),
    close: vi.fn(async () => {
      calls.push("close");
    }),
    ...over,
  };
}

function deps(calls: string[], over: Partial<UpdateDeps> = {}): UpdateDeps & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    check: vi.fn(async () => null),
    confirm: vi.fn(() => true),
    status: (message: string) => said.push(message),
    available: vi.fn(),
    saveAll: vi.fn(async () => {
      calls.push("save");
    }),
    relaunch: vi.fn(async () => {
      calls.push("relaunch");
    }),
    ...over,
  };
}

beforeEach(() => localStorage.clear());

describe("the off switch", () => {
  it("is on by default, as ADR-0007 sets it", () => {
    expect(automaticChecksEnabled()).toBe(true);
  });

  it("stays off once turned off", () => {
    expect(setAutomaticChecks(false)).toBe(true);
    expect(automaticChecksEnabled()).toBe(false);
    expect(setAutomaticChecks(true)).toBe(true);
    expect(automaticChecksEnabled()).toBe(true);
  });

  it("sends nothing when off — the request must not leave the machine", async () => {
    setAutomaticChecks(false);
    const d = deps([]);
    expect(await runUpdateCheck(d, { manual: false })).toBe("disabled");
    // Not "checked and ignored the answer": never asked.
    expect(d.check).not.toHaveBeenCalled();
  });

  it("does not stop a check the reviewer explicitly asked for", async () => {
    setAutomaticChecks(false);
    const d = deps([]);
    await runUpdateCheck(d, { manual: true });
    expect(d.check).toHaveBeenCalled();
  });

  it("treats storage it cannot read as 'off', not as permission", () => {
    const spy = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    try {
      expect(automaticChecksEnabled()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports when the choice could not be kept, rather than pretending it was", () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage full");
    });
    try {
      expect(setAutomaticChecks(false)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("when there is nothing to do", () => {
  it("says nothing on an automatic check that finds nothing newer", async () => {
    const d = deps([]);
    expect(await runUpdateCheck(d, { manual: false })).toBe("current");
    expect(d.said).toEqual([]);
  });

  it("says nothing on an automatic check with no network — offline is normal here", async () => {
    const d = deps([], { check: vi.fn(async () => Promise.reject(new Error("offline"))) });
    expect(await runUpdateCheck(d, { manual: false })).toBe("unreachable");
    expect(d.said).toEqual([]);
  });

  it("always answers a check somebody asked for", async () => {
    const current = deps([]);
    await runUpdateCheck(current, { manual: true });
    expect(current.said.join(" ")).toContain("latest");

    const offline = deps([], { check: vi.fn(async () => Promise.reject(new Error("offline"))) });
    await runUpdateCheck(offline, { manual: true });
    expect(offline.said.join(" ")).toContain("Could not check for updates");
    // No invented cause: the same failure is what an online machine sees before any release
    // carrying an update manifest exists.
    expect(offline.said.join(" ")).not.toContain("reach");
  });

  it("does not echo the updater's error, which can carry a URL", async () => {
    const d = deps([], {
      check: vi.fn(async () =>
        Promise.reject(new Error("GET https://example.invalid/secret-path failed")),
      ),
    });
    await runUpdateCheck(d, { manual: true });
    expect(d.said.join(" ")).not.toContain("https://");
  });
});

describe("a check nobody asked for", () => {
  it("announces an update and never asks — a dialog under somebody's typing is not consent", async () => {
    const calls: string[] = [];
    const update = fakeUpdate(calls);
    const d = deps(calls, { check: vi.fn(async () => update) });

    expect(await runUpdateCheck(d, { manual: false })).toBe("available");
    expect(d.confirm).not.toHaveBeenCalled();
    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(d.said.join(" ")).toContain("0.1.2 is available");
  });

  it("records the version, so the menu can keep offering it after the status line moves on", async () => {
    const calls: string[] = [];
    const d = deps(calls, { check: vi.fn(async () => fakeUpdate(calls)) });
    await runUpdateCheck(d, { manual: false });
    expect(d.available).toHaveBeenCalledWith("0.1.2");
  });
});

describe("installing", () => {
  it("installs nothing without a yes", async () => {
    const calls: string[] = [];
    const update = fakeUpdate(calls);
    const d = deps(calls, { check: vi.fn(async () => update), confirm: vi.fn(() => false) });

    expect(await runUpdateCheck(d, { manual: true })).toBe("declined");
    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
  });

  it("names both versions when asking", async () => {
    const calls: string[] = [];
    const d = deps(calls, { check: vi.fn(async () => fakeUpdate(calls)), confirm: vi.fn(() => false) });
    await runUpdateCheck(d, { manual: true });
    const asked = (d.confirm as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(asked).toContain("0.1.2");
    expect(asked).toContain("0.1.1");
  });

  it("downloads, then saves, then installs, then restarts — in that order", async () => {
    // On Windows the installer ends the process the moment install() runs, so the save has to
    // have already happened. Any other order loses work on exactly one platform.
    const calls: string[] = [];
    const d = deps(calls, { check: vi.fn(async () => fakeUpdate(calls)) });

    expect(await runUpdateCheck(d, { manual: true })).toBe("installed");
    expect(calls).toEqual(["download", "save", "install", "relaunch", "close"]);
  });

  it("reports download progress", async () => {
    const calls: string[] = [];
    const d = deps(calls, { check: vi.fn(async () => fakeUpdate(calls)) });
    await runUpdateCheck(d, { manual: true });
    expect(d.said).toContain("Downloading SheetForge 0.1.2… 50%");
    expect(d.said).toContain("Downloading SheetForge 0.1.2… 100%");
  });

  it("does not install over markups that did not save", async () => {
    // The engine's save resolves even when it fails. saveAll exists to turn that into a throw,
    // and this is what the throw has to prevent.
    const calls: string[] = [];
    const update = fakeUpdate(calls);
    const d = deps(calls, {
      check: vi.fn(async () => update),
      saveAll: vi.fn(async () => Promise.reject(new Error("disk full"))),
    });

    expect(await runUpdateCheck(d, { manual: true })).toBe("not-saved");
    expect(update.install).not.toHaveBeenCalled();
    expect(d.relaunch).not.toHaveBeenCalled();
    expect(d.said.join(" ")).toContain("could not be saved");
  });

  it("changes nothing when the download fails or does not verify", async () => {
    const calls: string[] = [];
    const update = fakeUpdate(calls, {
      download: vi.fn(async () => Promise.reject(new Error("signature mismatch"))),
    });
    const d = deps(calls, { check: vi.fn(async () => update) });

    expect(await runUpdateCheck(d, { manual: true })).toBe("failed");
    expect(d.saveAll).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(d.said.join(" ")).toContain("Nothing was installed");
  });

  it("does not claim 'nothing changed' after an installer failed part-way", async () => {
    const calls: string[] = [];
    const update = fakeUpdate(calls, {
      install: vi.fn(async () => Promise.reject(new Error("installer exited 1"))),
    });
    const d = deps(calls, { check: vi.fn(async () => update) });

    expect(await runUpdateCheck(d, { manual: true })).toBe("failed");
    const said = d.said.join(" ");
    expect(said).not.toContain("Nothing was");
    expect(said).toContain("projects are not affected");
    expect(d.relaunch).not.toHaveBeenCalled();
  });

  it("says the update is in place when only the restart failed", async () => {
    const calls: string[] = [];
    const d = deps(calls, {
      check: vi.fn(async () => fakeUpdate(calls)),
      relaunch: vi.fn(async () => Promise.reject(new Error("no"))),
    });
    expect(await runUpdateCheck(d, { manual: true })).toBe("installed");
    expect(d.said.join(" ")).toContain("is installed. Restart SheetForge");
  });

  it("releases the host's handle on the update whatever happened", async () => {
    const calls: string[] = [];
    const update = fakeUpdate(calls);
    const d = deps(calls, { check: vi.fn(async () => update), confirm: vi.fn(() => false) });
    await runUpdateCheck(d, { manual: true });
    expect(update.close).toHaveBeenCalled();
  });
});
