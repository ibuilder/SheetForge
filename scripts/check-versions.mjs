#!/usr/bin/env node
/**
 * Every place this project declares its version must declare the same one.
 *
 * The version is written in six places — the Cargo workspace, the Tauri configuration, the root
 * package, the interface package and both of their lockfile entries — because each tool reads its
 * own file and none of them reads another's. Release 0.1.2 was cut with the interface package still
 * saying 0.1.1: nothing broke, and nothing noticed, which is exactly why this is a check and not a
 * step in a runbook. The updater compares the Tauri version; a support bundle reports the Cargo
 * one; a mismatch between them is a question nobody should have to answer from a bug report.
 *
 * Exits non-zero, naming every file that disagrees, not just the first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));

// `[workspace.package]` is the one table whose `version` is the application's. Matched as a table
// rather than the first `version =` in the file, which could as easily be a dependency's.
function cargoWorkspaceVersion() {
  const table = read("Cargo.toml").match(/^\[workspace\.package\]\s*$([\s\S]*?)(?=^\[)/m);
  const version = table?.[1].match(/^version\s*=\s*"([^"]+)"/m);
  if (!version) throw new Error("Cargo.toml has no [workspace.package] version");
  return version[1];
}

const lock = json("package-lock.json");
const declared = [
  ["Cargo.toml [workspace.package]", cargoWorkspaceVersion()],
  ["apps/desktop/src-tauri/tauri.conf.json", json("apps/desktop/src-tauri/tauri.conf.json").version],
  ["package.json", json("package.json").version],
  ["apps/ui/package.json", json("apps/ui/package.json").version],
  ["package-lock.json (root)", lock.version],
  ['package-lock.json packages[""]', lock.packages?.[""]?.version],
  ['package-lock.json packages["apps/ui"]', lock.packages?.["apps/ui"]?.version],
];

// The Cargo workspace is the reference: it is what the binary reports about itself.
const expected = declared[0][1];
const wrong = declared.filter(([, version]) => version !== expected);

if (wrong.length > 0) {
  console.error(`Versions disagree. ${declared[0][0]} says ${expected}, but:`);
  for (const [where, version] of wrong) console.error(`  ${where} says ${version ?? "nothing"}`);
  process.exit(1);
}
console.log(`All ${declared.length} declared versions are ${expected}.`);
