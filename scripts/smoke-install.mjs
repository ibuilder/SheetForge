#!/usr/bin/env node
/**
 * Install what the bundler produced, start it, confirm it came up, and remove it again.
 *
 * `bundle.yml` proves an installer can be *built*. Until this, nothing proved one could be
 * *installed* and *run* anywhere but on the machine that built it — and that machine already had
 * every runtime, every library and every setting the installer is supposed to provide. A GitHub
 * runner is not a clean desktop, but it is not the build machine either: this runs on a fresh
 * runner that has never had SheetForge on it, installs the way a user would, and checks three
 * things a user would notice first.
 *
 * 1. **It installs.** Silently, through the platform's own installer: NSIS on Windows, the `.dmg`
 *    on macOS, `apt` on Linux, which also proves the package declares the libraries it needs.
 * 2. **It starts.** The Rust side writes one line to its log at startup, naming its version. A
 *    process that is merely still alive could be a window stuck before that line; a log line
 *    naming the version that was installed cannot.
 * 3. **It uninstalls.** The installed program is gone afterwards.
 *
 * What it cannot judge: what the operating system *says* about an unsigned binary on a real
 * desktop, whether the window looks right, and whether anything works past startup. Those stay on
 * the release runbook's human checklist.
 *
 * Usage: node scripts/smoke-install.mjs <directory holding the bundle artifacts>
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const bundleDir = resolve(process.argv[2] ?? "bundle");
const config = JSON.parse(readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
const { version, identifier, productName } = config;
const marker = `SheetForge ${version} started`;

/** How long the application gets to write its startup line. Generous: a first launch is slow. */
const STARTUP_BUDGET_MS = 120_000;

const step = (message) => console.log(`\n== ${message}`);
function fail(message) {
  console.error(`\nSMOKE TEST FAILED: ${message}`);
  process.exit(1);
}

function find(dir, test) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...find(path, test));
    else if (test(entry.name)) found.push(path);
  }
  return found;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });
}

/** Where tauri-plugin-log writes, per platform: the app log directory for this identifier. */
function logDirectory() {
  switch (platform()) {
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), identifier, "logs");
    case "darwin":
      return join(homedir(), "Library", "Logs", identifier);
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), identifier, "logs");
  }
}

function startupLogged() {
  return find(logDirectory(), (name) => name.endsWith(".log")).some((file) =>
    readFileSync(file, "utf8").includes(marker),
  );
}

/** Start the installed program, wait for its startup line, confirm it is still running, stop it. */
async function launchAndConfirm(command, args = []) {
  step(`Launch ${command}`);
  const child = spawn(command, args, { detached: platform() !== "win32", stdio: "ignore" });
  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + STARTUP_BUDGET_MS;
  while (Date.now() < deadline && !startupLogged() && exited === null) await sleep(2_000);

  if (exited !== null) fail(`the application exited during startup (${JSON.stringify(exited)})`);
  if (!startupLogged()) {
    fail(`no "${marker}" line in ${logDirectory()} after ${STARTUP_BUDGET_MS / 1000} s`);
  }
  console.log(`found "${marker}" in ${logDirectory()}`);

  // Still up a few seconds after announcing itself: a crash straight after setup is a failure too.
  await sleep(5_000);
  if (exited !== null) fail(`the application exited just after startup (${JSON.stringify(exited)})`);

  step("Stop it");
  if (platform() === "win32") {
    try {
      run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    } catch {
      // Already gone is fine here; what mattered was that it was running.
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // As above.
    }
  }
  await sleep(3_000);
}

async function windows() {
  const [installer] = find(bundleDir, (name) => name.endsWith("-setup.exe"));
  if (!installer) fail(`no NSIS installer under ${bundleDir}`);

  step("Install silently, per user");
  run(installer, ["/S"]);

  const local = process.env.LOCALAPPDATA;
  const candidates = [join(local, "Programs", productName), join(local, productName)];
  const installDir = candidates.find((dir) => existsSync(dir));
  if (!installDir) fail(`nothing installed at ${candidates.join(" or ")}`);
  const [program] = find(installDir, (name) => name.endsWith(".exe") && !/uninstall/i.test(name));
  if (!program) fail(`no program in ${installDir}`);
  console.log(`installed ${program}`);

  await launchAndConfirm(program);

  step("Uninstall silently");
  const [uninstaller] = find(installDir, (name) => /uninstall.*\.exe$/i.test(name));
  if (!uninstaller) fail(`no uninstaller in ${installDir}`);
  run(uninstaller, ["/S"]);
  // The NSIS uninstaller copies itself elsewhere and returns before it has finished.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && existsSync(program)) await sleep(2_000);
  if (existsSync(program)) fail(`${program} is still there after uninstalling`);
  console.log("removed");
}

async function macos() {
  const [image] = find(bundleDir, (name) => name.endsWith(".dmg"));
  if (!image) fail(`no .dmg under ${bundleDir}`);

  step("Mount the disk image and copy the application out, as a user would");
  const mount = "/tmp/sheetforge-smoke";
  run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, image]);
  const applications = join(homedir(), "Applications");
  run("mkdir", ["-p", applications]);
  const app = join(applications, `${productName}.app`);
  run("ditto", [join(mount, `${productName}.app`), app]);
  run("hdiutil", ["detach", mount]);

  const executable = run("plutil", ["-extract", "CFBundleExecutable", "raw", join(app, "Contents", "Info.plist")]).trim();
  await launchAndConfirm(join(app, "Contents", "MacOS", executable));

  step("Remove it");
  run("rm", ["-rf", app]);
  if (existsSync(app)) fail(`${app} is still there`);
  console.log("removed");
}

async function linux() {
  const [pkg] = find(bundleDir, (name) => name.endsWith(".deb"));
  if (!pkg) fail(`no .deb under ${bundleDir}`);
  const name = run("dpkg-deb", ["-f", pkg, "Package"]).trim();

  step("Install with apt, which also installs whatever the package declares it needs");
  run("sudo", ["apt-get", "install", "-y", pkg]);
  const program = run("dpkg", ["-L", name])
    .split("\n")
    .find((path) => path.startsWith("/usr/bin/") && existsSync(path) && statSync(path).isFile());
  if (!program) fail(`package ${name} installed no program under /usr/bin`);
  console.log(`installed ${program}`);

  // No display on a runner. xvfb-run provides one, and exits with the program.
  await launchAndConfirm("xvfb-run", ["-a", program]);

  step("Remove it");
  run("sudo", ["apt-get", "remove", "-y", name]);
  if (existsSync(program)) fail(`${program} is still there after removing ${name}`);
  console.log("removed");
}

const byPlatform = { win32: windows, darwin: macos, linux };
const test = byPlatform[platform()];
if (!test) fail(`no smoke test for ${platform()}`);
console.log(`Smoke-testing ${productName} ${version} from ${bundleDir}`);
await test();
console.log(`\n${productName} ${version} installed, started, said so, and was removed.`);
