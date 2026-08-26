# Upstream reports

Drafts for defects and requests that belong to
[`@massingcloud/pdf-viewer`](https://github.com/MassingCloud/massing-pdf) rather than here.

Kept as files rather than filed straight away so the wording can be reviewed, and so the reasoning
survives if the issue is closed or the tracker moves. Each names the commit it was found against:
`36794b3c54fcfd62e3a0d2d5984cfc45cac83340`.

| Draft | Kind | Severity here |
|---|---|---|
| [empty-listbox-roles.md](empty-listbox-roles.md) | Accessibility defect | axe **critical** |
| [scroller-not-focusable.md](scroller-not-focusable.md) | Accessibility defect | axe **serious** |
| [attachment-url-resolver.md](attachment-url-resolver.md) | Feature request | Blocks a feature |

The two accessibility defects are listed in `apps/ui/e2e/accessibility.spec.ts` under
`KNOWN_UPSTREAM` rather than excluded from the scan, so a *new* defect still fails our build — and
so does a fix landing upstream, which is deliberate: the test tells us when to delete the entry.
