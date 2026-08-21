/**
 * Frees the port the browser suite serves on.
 *
 * Playwright starts its own server and refuses to run when the port is taken, which is the right
 * default — reusing whatever is already listening is how a suite ends up testing a stale bundle.
 * The consequence is that interrupting a run (Ctrl-C, a killed terminal, a crashed test) strands a
 * preview server and every later run fails with "port already in use" until somebody hunts it down.
 *
 * That is a bad first five minutes for a contributor, so this runs before the suite and clears it.
 *
 * It only kills a process **listening on that exact port**, never a process matched by name, so it
 * cannot take out an unrelated editor or dev server someone had open.
 *
 * Usage: `node scripts/free-port.mjs 4173`
 */
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";

const port = Number(process.argv[2] ?? 4173);

/** Whether anything accepts a connection on the port. */
function inUse() {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(700);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** PIDs listening on the port, by platform. */
function listeners() {
  try {
    if (process.platform === "win32") {
      // PowerShell rather than parsing `netstat -ano`. Its columns shift with locale and with the
      // address family, and a parser that quietly matches nothing looks exactly like a free port —
      // which is how this script reported "owner could not be identified" while a server sat on
      // the port in plain sight.
      const command =
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue |` +
        " Select-Object -ExpandProperty OwningProcess -Unique";
      // `powershell` is not always on PATH — a Git Bash shell inherits a POSIX-shaped PATH that
      // omits System32 — so fall back to the absolute location before giving up.
      const candidates = [
        "powershell",
        `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ];
      for (const shell of candidates) {
        try {
          const out = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", command], {
            encoding: "utf8",
          });
          return out.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
        } catch {
          // Try the next candidate.
        }
      }
      return [];
    }
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    return out.split(/\s+/).map(Number).filter(Boolean);
  } catch {
    // `netstat`/`lsof` missing or nothing matched. Not a reason to fail the test run.
    return [];
  }
}

if (!(await inUse())) {
  console.log(`Port ${port} is free.`);
  process.exit(0);
}

const pids = listeners();
if (pids.length === 0) {
  console.warn(
    `Port ${port} is in use but the owning process could not be identified. ` +
      "The test run will report the conflict itself.",
  );
  process.exit(0);
}

for (const pid of pids) {
  // Never our own process tree's parent — killing that takes the test runner with it.
  if (pid === process.pid) continue;
  try {
    // Node's own kill works on every platform this runs on — on Windows it calls
    // `TerminateProcess` — which avoids depending on `taskkill` being on PATH. It is not, in a Git
    // Bash shell, which is where this script is most likely to be run.
    process.kill(pid, "SIGKILL");
    console.log(`Freed port ${port}: stopped stranded process ${pid}.`);
  } catch (error) {
    console.warn(`Could not stop process ${pid} on port ${port}: ${error.message}`);
  }
}
