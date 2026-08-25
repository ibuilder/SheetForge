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
- [ ] `npm run site && npm run site:check:external`. The internal checker runs in CI; the external
      one does not, because a build that fails when somebody else's site is down for a minute
      trains everybody to ignore a red build. Run it deliberately here. Read the output before
      believing it: `000` is usually this machine's network, a `404` from a host whose other links
      answered is the real thing.
- [ ] **Run the bundle dry run and let it finish.**
      `gh workflow run bundle.yml` builds installers on all three platforms without needing the
      signing key. It exists because the packaging had once been run on Windows only, and finding
      out that macOS does not package *after* a tag is pushed is the worst moment to find out.
      Tagging before this is green is tagging on hope.

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

- [ ] **Export a file from the installed application.** Any export — a PNG of a sheet will do.
      Bytes cross to the host as a raw IPC body, and the browser suite exercises that against a
      stub written by the same person who wrote the code it is checking. This is the one seam
      nothing automated reaches, and a failure here means every export is broken.
- [ ] Every expected artefact is present: `.msi`, `.exe`, `.dmg` (both architectures),
      `.AppImage`, `.deb`, `.rpm`.
- [ ] `latest.json` lists every platform and each entry carries a signature.
- [ ] Install on a **clean** VM per platform. Not your development machine, which has the runtimes
      already.
- [ ] Open a project, import a drawing, draw a cloud, calibrate a page, measure something, close,
      reopen, and confirm it is all still there.
- [ ] Run **Check integrity** and confirm it verifies.
- [ ] Install the *previous* release, then update to this one, and confirm the project still opens
      afterwards. **Not applicable to the first release**, which is the one case where this cannot
      be done and therefore the one case where the updater path ships unexercised end to end.
- [ ] Open a project made by the *previous* release and confirm it still opens. The schema is at
      version 2 and the migration is tested in `crates/sf-store/tests/migration.rs`, but a test
      that builds its own version-1 database is not the same as a project somebody actually used.
- [ ] Release notes name the known limitations.
- [ ] Confirm the changelog's version link resolves. `/releases/tag/vX.Y.Z` serves a tag page even
      before a release exists, so it is not broken while a release is pending — but the API reports
      no release for that tag, which is a different question and an easy one to confuse.

Then publish.

## If a tag was pushed too early

A tag that points at the wrong commit is not a release — nothing was built from it and nobody has
downloaded it — so moving it is safe *until a draft exists*. After that, do not: publish a higher
version instead, as below.

```bash
git tag -f vX.Y.Z && git push --force origin vX.Y.Z
```

Check what it currently points at first (`git log --oneline -1 vX.Y.Z`), because a tag pushed weeks
ago may predate a schema change — in which case building from it produces something that cannot
open the projects the current build writes.

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
