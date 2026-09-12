#!/usr/bin/env node
/**
 * Check a release the way somebody downloading it would, before it is published.
 *
 * ## Why this exists
 *
 * A release can look complete and still be unusable. The updater signature is the case that
 * matters: 0.1.0 and 0.1.1 shipped a public key whose private half nobody held, so every update
 * would have been rejected on a signature that could never be produced — and nothing in the build
 * would have said so, because the bundler is happy to sign with any key and the installers run
 * fine. The only check that catches it is the one the application itself performs: verify each
 * artifact's signature against the public key compiled into it.
 *
 * So this verifies, for a given tag:
 *
 * 1. every file listed in `SHA256SUMS.txt` hashes to what the file says;
 * 2. every `.sig` verifies against `plugins.updater.pubkey` in `tauri.conf.json`, and carries the
 *    same key id — a signature by *some* valid key is not the same as one by *our* key;
 * 3. `latest.json` names this version, and each platform's signature is the artifact's own;
 * 4. each installer carries build provenance from this repository.
 *
 * ## What it cannot tell you
 *
 * That the download URLs work for somebody who is not signed in. While the release is a draft its
 * assets are private, and `tauri-action` writes `api.github.com/…/releases/assets/<id>` URLs for a
 * draft rather than the public `releases/download/<tag>/<file>` form. The updater sends
 * `Accept: application/octet-stream`, which is what those URLs need, but that only resolves for
 * everybody once the release is published. Run with `--published` after publishing to check it.
 *
 * Usage:  node scripts/verify-release.mjs v0.1.2 [--published]
 */

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "ibuilder/SheetForge";
const CONFIG = "apps/desktop/src-tauri/tauri.conf.json";

const tag = process.argv[2];
const checkPublished = process.argv.includes("--published");
if (!tag) {
  console.error("usage: node scripts/verify-release.mjs <tag> [--published]");
  process.exit(2);
}

const failures = [];
const notes = [];
function check(ok, what, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(what);
}

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28, ...options });
}

/** A minisign public key or signature: 2 bytes of algorithm, 8 of key id, then the key or signature. */
function decodeMinisign(base64File) {
  const text = Buffer.from(base64File.trim(), "base64").toString("utf8");
  const payload = text.split("\n")[1];
  if (!payload) throw new Error("not a minisign file");
  const bytes = Buffer.from(payload.trim(), "base64");
  return {
    algorithm: bytes.subarray(0, 2).toString("ascii"),
    keyId: bytes.subarray(2, 10).toString("hex"),
    body: bytes.subarray(10),
  };
}

/** Verify one artifact against the public key the application ships. */
function signatureMatches(pub, artifact, signatureFileText) {
  const sig = decodeMinisign(signatureFileText);
  if (sig.keyId !== pub.keyId) {
    return { ok: false, why: `signed by key ${sig.keyId}, application trusts ${pub.keyId}` };
  }
  // "ED" prehashes with blake2b-512; the legacy "Ed" signs the file itself.
  const message = sig.algorithm === "ED" ? createHash("blake2b512").update(artifact).digest() : artifact;
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.body]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return { ok: verifySignature(null, message, key, sig.body), why: "signature does not verify" };
}

const config = JSON.parse(readFileSync(CONFIG, "utf8"));
const pub = decodeMinisign(config.plugins.updater.pubkey);
console.log(`\n${REPO} ${tag} — application trusts updater key ${pub.keyId}, version ${config.version}\n`);

const dir = mkdtempSync(join(tmpdir(), "sf-verify-"));
try {
  gh(["release", "download", tag, "-R", REPO, "-D", dir], { stdio: ["ignore", "ignore", "inherit"] });
  const files = readdirSync(dir);

  // 1. Checksums.
  const sums = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8").trim().split(/\r?\n/);
  let mismatched = 0;
  for (const line of sums) {
    const expected = line.slice(0, 64);
    const name = line.slice(66).replace(/^[*]/, "");
    const actual = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
    if (actual !== expected) mismatched++;
  }
  check(
    mismatched === 0,
    `SHA256SUMS.txt covers ${sums.length} files`,
    mismatched ? `${mismatched} do not match` : "all match",
  );
  const unlisted = files.filter((f) => f !== "SHA256SUMS.txt" && !sums.some((l) => l.endsWith(f)));
  check(unlisted.length === 0, "every published file is listed", unlisted.join(", "));

  // 2. Updater signatures, against the key the application actually trusts.
  const signed = files.filter((f) => f.endsWith(".sig"));
  check(signed.length > 0, "the release carries updater signatures", `${signed.length} found`);
  for (const sigFile of signed) {
    const artifact = sigFile.replace(/\.sig$/, "");
    const signature = readFileSync(join(dir, sigFile), "utf8");
    const result = signatureMatches(pub, readFileSync(join(dir, artifact)), signature);
    check(result.ok, `${artifact} is signed by the key the application trusts`, result.ok ? "" : result.why);
  }

  // 3. latest.json — what an installed copy will actually read.
  const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  check(latest.version === config.version, "latest.json names this version", `${latest.version} vs ${config.version}`);
  for (const [platform, entry] of Object.entries(latest.platforms)) {
    // A draft's URLs end in an asset id rather than a filename, so fall back to matching the
    // signature the manifest carries against the .sig files on the release.
    const named = decodeURIComponent(entry.url.split("/").pop());
    const artifact = files.includes(named)
      ? named
      : signed
          .map((s) => s.replace(/\.sig$/, ""))
          .find((a) => readFileSync(join(dir, `${a}.sig`), "utf8").trim() === entry.signature.trim());
    check(!!artifact, `latest.json ${platform} points at a file in this release`, artifact ?? entry.url);
    if (artifact) {
      const result = signatureMatches(pub, readFileSync(join(dir, artifact)), entry.signature);
      check(result.ok, `latest.json ${platform} signature verifies`, result.ok ? "" : result.why);
    }
    if (checkPublished) {
      // Anonymous, the way an installed copy fetches it. No token: that is the point.
      const response = await fetch(entry.url, { headers: { accept: "application/octet-stream" } });
      check(response.ok, `latest.json ${platform} downloads without signing in`, `HTTP ${response.status}`);
      await response.body?.cancel();
    }
  }
  if (!checkPublished) notes.push("download URLs not checked: pass --published once the release is public");

  // 4. Provenance.
  for (const installer of files.filter((f) => /\.(exe|msi|dmg|deb|rpm|AppImage)$/.test(f))) {
    let ok = true;
    try {
      gh(["attestation", "verify", join(dir, installer), "--repo", REPO], { stdio: "ignore" });
    } catch {
      ok = false;
    }
    check(ok, `${installer} carries provenance from ${REPO}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

for (const note of notes) console.log(`  note  ${note}`);
console.log(failures.length ? `\n${failures.length} check(s) failed\n` : "\nall checks passed\n");
process.exit(failures.length ? 1 : 0);
