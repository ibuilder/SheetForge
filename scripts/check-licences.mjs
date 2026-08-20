/**
 * Fails the build if a copyleft licence appears anywhere in the installed npm tree.
 *
 * `cargo deny` does this for Rust. This is the same rule for the JavaScript side, and it walks the
 * installed tree rather than the manifests — a transitive dependency four levels down is exactly
 * where an unwanted licence arrives, and it is invisible in `package.json`.
 *
 * See docs/adr/0008-open-source-license-and-sbom-policy.md for why the rule is a refusal rather
 * than a review.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Refused outright. Matched case-insensitively against the declared licence string. */
const FORBIDDEN = [
  "GPL-2.0", "GPL-3.0", "AGPL", "LGPL", "SSPL", "CC-BY-NC", "BUSL", "Elastic-2.0", "CPAL",
];

/**
 * Allowed despite matching a forbidden substring.
 *
 * `LGPL` is a substring of nothing useful, but `GPL-3.0` matches inside `GPL-3.0-or-later` and
 * also inside `Apache-2.0 WITH GPL-3.0-linking-exception`, which is permissive in the direction
 * that matters. Listed explicitly so the exception is visible rather than encoded in a regex.
 */
const ALLOWED_EXCEPTIONS = ["GPL-3.0-linking-exception", "GPL-2.0-with-classpath-exception"];

const ROOT = new URL("../node_modules", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Every installed package directory, including scoped and nested `node_modules`. */
function* packages(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === ".bin" || entry.name === ".cache") continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith("@")) {
      yield* packages(full);
      continue;
    }
    try {
      statSync(join(full, "package.json"));
      yield full;
    } catch {
      // Not a package; keep walking in case it holds one.
    }
    yield* packages(join(full, "node_modules"));
  }
}

/** The declared licence, however this package chose to spell it. */
function licenceOf(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses.map((l) => l.type ?? l).join(" OR ");
  }
  return undefined;
}

const violations = [];
const unknown = [];
let checked = 0;

for (const dir of packages(ROOT)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  if (!manifest.name) continue;
  checked += 1;

  const licence = licenceOf(manifest);
  const id = `${manifest.name}@${manifest.version ?? "?"}`;

  if (!licence) {
    unknown.push(id);
    continue;
  }
  let text = licence;
  for (const exception of ALLOWED_EXCEPTIONS) text = text.replaceAll(exception, "");
  const hit = FORBIDDEN.find((f) => text.toUpperCase().includes(f.toUpperCase()));
  if (hit) violations.push(`${id} — ${licence}`);
}

console.log(`Checked ${checked} installed packages.`);

if (unknown.length > 0) {
  // Unknown is a failure, not a warning: an undeclared licence is not permission.
  console.error(`\n${unknown.length} package(s) declare no licence:`);
  for (const id of unknown) console.error(`  ${id}`);
}

if (violations.length > 0) {
  console.error(`\n${violations.length} package(s) carry a licence this project cannot ship:`);
  for (const v of violations) console.error(`  ${v}`);
}

if (violations.length > 0 || unknown.length > 0) {
  console.error(
    "\nSee docs/adr/0008-open-source-license-and-sbom-policy.md. " +
      "Copyleft is refused rather than reviewed; replace the dependency.",
  );
  process.exit(1);
}

console.log("No copyleft or undeclared licences in the installed tree.");
