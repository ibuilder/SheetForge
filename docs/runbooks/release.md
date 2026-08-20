# Runbook: cutting a release

## Before you start

- [ ] `cargo test --workspace` and `npm run check` pass from a clean checkout.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` is clean.
- [ ] `cargo deny check` and the npm licence check pass.
- [ ] `CHANGELOG.md` has an entry, including a **Known limitations** section that is honest.
- [ ] `docs/status.md` reflects what is actually verified in this build.
- [ ] Version bumped in `Cargo.toml` (workspace), `package.json`, and
      `apps/desktop/src-tauri/tauri.conf.json`. All three, or the updater and the about box
      disagree.

## Signing material

The updater signing key exists in exactly two places: the CI secret store, and an offline backup
held by whoever administers the project. **Not on a developer machine, not in the repository, and
not passed to any third-party action that could log it.**

| Secret | What it is |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The updater private key, as a string |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password, if it has one |

To generate a fresh keypair — which invalidates every installed client's ability to accept updates,
so do it only once or on compromise:

```bash
npm run tauri signer generate -- -w ./sheetforge.key
```

Put the **public** half in `tauri.conf.json` under `plugins.updater.pubkey`. Put the private half in
the secret store and the backup, then delete your local copy.

> If the private key is lost, no existing installation can be updated again. They have to reinstall
> by hand. Treat the backup accordingly.

## Cutting it

```bash
git switch -c release/vX.Y.Z
# bump the three version numbers, update CHANGELOG.md and docs/status.md
git commit -am "Release vX.Y.Z"
git push -u origin release/vX.Y.Z
# open a PR, get it reviewed and merged
git switch main && git pull
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The tag triggers `.github/workflows/release.yml`, which builds on Windows, macOS (Apple silicon and
Intel) and Linux, signs the update payloads, and opens a **draft** release.

## Before publishing the draft

- [ ] Every expected artefact is present: `.msi`, `.exe`, `.dmg` (both architectures),
      `.AppImage`, `.deb`, `.rpm`.
- [ ] `latest.json` lists every platform and each entry carries a signature.
- [ ] Install on a **clean** VM per platform. Not your development machine, which has the runtimes
      already.
- [ ] Open a project, import a drawing, draw a cloud, calibrate a page, measure something, close,
      reopen, and confirm it is all still there.
- [ ] Run **Check integrity** and confirm it verifies.
- [ ] Install the *previous* release, then update to this one, and confirm the project still opens
      afterwards.
- [ ] Release notes name the known limitations.

Then publish.

## Rolling back

**Do not delete or rewrite a published release.** Anyone mid-download gets a signature mismatch and
a broken install.

Publish a higher version containing the older code:

```bash
git revert <the bad commit>
# bump to X.Y.Z+1, note the revert in CHANGELOG.md
git tag -a vX.Y.Z+1 -m "vX.Y.Z+1 — reverts vX.Y.Z"
```

If the bad release corrupts data, say so at the top of the release notes and in a pinned issue,
with instructions. People's drawings matter more than the project's appearance.

## Still outstanding

- **Code signing** with an organisation certificate (Windows) and an Apple Developer identity
  (macOS). Until then, installers warn and the release notes must say so.
- **A clean-VM smoke test as an automated gate**, rather than the manual checklist above.
- **Reproducible builds** and a signed SBOM.
