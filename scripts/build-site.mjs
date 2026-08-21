/**
 * Builds the documentation site into `_site/`.
 *
 * The landing page is hand-written HTML; everything else is the Markdown that already lives in the
 * repository, rendered through one shared shell. That constraint is the point: the docs a
 * contributor reads in the repository and the docs a user reads on the web are the same files, so
 * they cannot drift.
 *
 * ## Links
 *
 * The hard part, and the reason this is a script rather than a `cp`. A Markdown link is written to
 * be correct *in the repository*, where `SECURITY.md` sits at the root and `docs/guides/` is two
 * levels down. On the site the layout is different — root documents are rendered into `docs/` —
 * so a naive `.md` → `.html` substitution produces `docs/docs/status.html` and similar.
 *
 * So every link is resolved to the repository path it points at, then looked up:
 *
 * - **A file this site renders** becomes a relative link to its output page, computed from where
 *   the current page ended up.
 * - **Anything else in the repository** — a source file, the licence, a capability file — becomes
 *   an absolute link to GitHub, because those are genuinely useful to follow and pretending to
 *   host them would mean shipping the whole repository.
 *
 * A link checker runs over the output afterwards; see `npm run site:check`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import path from "node:path/posix";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(ROOT, "_site");
const REPO = "https://github.com/ibuilder/SheetForge";
const BLOB = `${REPO}/blob/main`;

/** Root-level documents that belong on the site, and where they land. */
const ROOT_DOCS = [
  ["README.md", "docs/readme.html"],
  ["SECURITY.md", "docs/SECURITY.html"],
  ["PRIVACY.md", "docs/PRIVACY.html"],
  ["CONTRIBUTING.md", "docs/CONTRIBUTING.html"],
  ["CHANGELOG.md", "docs/CHANGELOG.html"],
  ["CODE_OF_CONDUCT.md", "docs/CODE_OF_CONDUCT.html"],
  ["THIRD_PARTY_NOTICES.md", "docs/THIRD_PARTY_NOTICES.html"],
];

/** Every `.md` under a directory, recursively, as repo-relative POSIX paths. */
function markdownUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownUnder(full));
    else if (entry.name.endsWith(".md")) found.push(relative(ROOT, full).split("\\").join("/"));
  }
  return found;
}

/** repo path → output path, for everything this site renders. */
const routes = new Map();
for (const source of markdownUnder(join(ROOT, "docs"))) {
  routes.set(source, source.replace(/\.md$/, ".html"));
}
for (const [source, out] of ROOT_DOCS) {
  if (existsSync(join(ROOT, source))) routes.set(source, out);
}

/**
 * Repository images the documentation points at, collected while rewriting and copied afterwards.
 *
 * Falling back to `raw.githubusercontent.com` produces a page that renders, which is why this went
 * unnoticed for a while: the documentation site of an application whose selling point is that it
 * does not phone anywhere was fetching pictures of itself from a third-party host on every view.
 * It also fails outright for any image whose commit has not reached `main` yet, which is every
 * image on the day it is added.
 *
 * The output mirrors the repository path, so a link is just the relative path between the two.
 * `scripts/check-site-links.mjs` fails the build if any image escapes this.
 */
const images = new Set();

/**
 * Rewrite one link, given the repository path of the page it appears on and the output path that
 * page was written to.
 */
function rewriteLink(href, sourceRepoPath, outPath, isImage) {
  if (/^(https?:|mailto:|data:|#)/i.test(href)) return href;

  const [rawPath, hash = ""] = href.split("#");
  const suffix = hash ? `#${hash}` : "";
  if (!rawPath) return href;

  // A bare directory link means that directory's index, when it has one.
  const wanted = rawPath.endsWith("/") ? `${rawPath}README.md` : rawPath;

  // Resolve against the *repository* location of the current page, which is what the link author
  // was thinking in. `path.resolve` needs a leading slash to work in absolute terms; strip it back
  // off afterwards to get a repo-relative path.
  const repoPath = path
    .resolve(`/${path.dirname(sourceRepoPath)}`, wanted)
    .replace(/^\//, "");

  const target = routes.get(repoPath);
  if (target) {
    const from = path.dirname(outPath);
    const rel = path.relative(from, target);
    return `${rel || path.basename(target)}${suffix}`;
  }

  // A directory with no index of its own — a source folder somebody is being pointed at — goes
  // to GitHub's tree view rather than to a page that does not exist.
  if (rawPath.endsWith("/")) {
    const dir = repoPath.replace(/\/README\.md$/, "");
    if (existsSync(join(ROOT, dir))) return `${REPO}/tree/main/${dir}`;
  }

  // Not a page this site renders. An image gets copied into the output and linked relatively;
  // anything else — a source file, a capability, the licence — goes to GitHub's blob view, where
  // it is genuinely more useful than a copy would be.
  if (existsSync(join(ROOT, repoPath))) {
    if (isImage) {
      images.add(repoPath);
      return path.relative(path.dirname(outPath), repoPath) || path.basename(repoPath);
    }
    return `${BLOB}/${repoPath}${suffix}`;
  }
  return href;
}

/** The shell every rendered page sits in. */
function page(title, bodyHtml, depth) {
  const up = "../".repeat(depth);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — SheetForge</title>
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${up}assets/icon.png" type="image/png">
<style>
:root {
  --bg:#fff; --panel:#f6f8fa; --ink:#0d1725; --muted:#55636f;
  --line:#d8dee4; --accent:#b4531a; --focus:#1d6fd0;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#0d1117; --panel:#161b22; --ink:#e6edf3; --muted:#9aa7b4;
    --line:#2b3440; --accent:#e08a4a; --focus:#6aa9f0;
  }
}
*,*::before,*::after { box-sizing:border-box; }
body {
  background:var(--bg); color:var(--ink); margin:0;
  font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-text-size-adjust:100%;
}
a { color:var(--accent); text-underline-offset:.15em; }
a:focus-visible { outline:2px solid var(--focus); outline-offset:3px; border-radius:3px; }
nav.top {
  border-bottom:1px solid var(--line); background:var(--panel);
  padding:.7rem 1.25rem; font-size:.9rem;
  display:flex; gap:1.1rem; align-items:center; flex-wrap:wrap;
}
nav.top a { color:var(--muted); text-decoration:none; }
nav.top a:hover { color:var(--ink); }
nav.top a.home { color:var(--ink); font-weight:650; }
main { margin:0 auto; max-width:52rem; padding:2.5rem 1.25rem 5rem; }
h1,h2,h3,h4 { line-height:1.25; letter-spacing:-.015em; margin:2.2rem 0 .8rem; }
h1 { font-size:2rem; margin-top:0; }
h2 { border-bottom:1px solid var(--line); font-size:1.45rem; padding-bottom:.35rem; }
h3 { font-size:1.12rem; }
p,li { max-width:70ch; }
blockquote {
  border-left:4px solid var(--accent); background:var(--panel);
  margin:1.4rem 0; padding:.7rem 1.1rem; border-radius:0 6px 6px 0;
}
blockquote > :first-child { margin-top:0; }
blockquote > :last-child { margin-bottom:0; }
code {
  background:var(--panel); border-radius:4px; padding:.12em .35em;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.88em;
}
pre {
  background:var(--panel); border:1px solid var(--line); border-radius:8px;
  overflow-x:auto; padding:1rem 1.1rem;
}
pre code { background:none; padding:0; font-size:.85rem; line-height:1.55; }
/* Wide tables scroll inside their own box rather than making the page scroll sideways. */
.table-scroll { overflow-x:auto; margin:1.4rem 0; }
table { border-collapse:collapse; font-size:.92rem; width:100%; }
th,td { border-bottom:1px solid var(--line); padding:.55rem .7rem; text-align:left; vertical-align:top; }
thead th { border-bottom-width:2px; font-size:.8rem; letter-spacing:.04em; text-transform:uppercase; }
hr { border:0; border-top:1px solid var(--line); margin:2.5rem 0; }
img { max-width:100%; height:auto; }
input[type=checkbox] { margin-right:.4rem; }
footer.doc {
  border-top:1px solid var(--line); color:var(--muted);
  font-size:.85rem; margin:0 auto; max-width:52rem; padding:1.5rem 1.25rem 3rem;
}
@media (prefers-reduced-motion: reduce) {
  *,*::before,*::after { animation-duration:.01ms !important; transition-duration:.01ms !important; }
}
</style>
</head>
<body>
<nav class="top">
  <a class="home" href="${up}index.html">SheetForge</a>
  <a href="${up}docs/guides/editing-pdfs.html">Markup</a>
  <a href="${up}docs/guides/takeoffs.html">Takeoffs</a>
  <a href="${up}docs/architecture.html">Architecture</a>
  <a href="${up}docs/SECURITY.html">Security</a>
  <a href="${up}docs/status.html">Status</a>
  <a href="${up}docs/roadmap.html">Roadmap</a>
  <a href="${REPO}">GitHub</a>
</nav>
<main>
${bodyHtml}
</main>
<footer class="doc">
  Apache-2.0 · <a href="${REPO}">Source</a> ·
  “SheetForge” has not had trademark clearance.
</footer>
</body>
</html>
`;
}

/** Render one Markdown file into the output tree. */
function render(sourcePath, outPath) {
  const raw = readFileSync(join(ROOT, sourcePath), "utf8");

  const renderer = new marked.Renderer();
  const baseLink = renderer.link.bind(renderer);
  renderer.link = (token) =>
    baseLink({ ...token, href: rewriteLink(token.href, sourcePath, outPath, false) });
  const baseImage = renderer.image.bind(renderer);
  renderer.image = (token) =>
    baseImage({ ...token, href: rewriteLink(token.href, sourcePath, outPath, true) });
  // Every table gets its own horizontal scroll container, so a wide comparison table never makes
  // the whole page scroll sideways on a phone.
  const baseTable = renderer.table.bind(renderer);
  renderer.table = (token) => `<div class="table-scroll">${baseTable(token)}</div>`;

  let html = marked.parse(raw, { renderer, gfm: true, breaks: false });

  // Raw HTML in the Markdown — the centred masthead in the README, for instance — passes through
  // marked untouched, so its `src` and `href` attributes never reach the renderer hooks above.
  // This second pass catches them. Links already rewritten resolve to nothing in the repository
  // and are left alone, so running over them twice is harmless.
  html = html.replace(
    /(<(?:img|a)[^>]*?(?:src|href)=")([^"]+)(")/gi,
    (whole, before, target, after) => {
      const rewritten = rewriteLink(target, sourcePath, outPath, /<img/i.test(before));
      return `${before}${rewritten}${after}`;
    },
  );

  // The first heading is the page title; falling back to the filename keeps the tab meaningful
  // for a document that opens with a banner instead.
  const heading = /^#\s+(.+)$/m.exec(raw);
  const title = heading
    ? heading[1].replace(/[`*_[\]]/g, "").replace(/\(.*?\)/g, "").trim()
    : sourcePath.replace(/\.md$/, "");

  const depth = outPath.split("/").length - 1;
  const target = join(OUT, outPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, page(title, html, depth), "utf8");
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, "site"), OUT, { recursive: true });

// `docs/assets` is copied unconditionally rather than only when something links to it, because
// the hand-written landing page points into it and is copied verbatim — nothing rewrites its
// markup, so nothing would discover the reference.
const docAssets = join(ROOT, "docs", "assets");
if (existsSync(docAssets)) cpSync(docAssets, join(OUT, "docs", "assets"), { recursive: true });

for (const [source, out] of routes) render(source, out);

// After rendering, because rendering is what discovers them.
for (const image of images) {
  const target = join(OUT, image);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(ROOT, image), target);
}

// Pages runs Jekyll by default, which ignores files beginning with an underscore and tries to
// parse braces in the output as Liquid tags.
writeFileSync(join(OUT, ".nojekyll"), "", "utf8");

// The landing page links to `.md` paths so those links also work when the file is read in the
// repository; on the site they have to point at the rendered pages.
const landing = join(OUT, "index.html");
writeFileSync(
  landing,
  readFileSync(landing, "utf8")
    .replace(/href="(docs\/[^"]+?)\.md"/g, (_, p) => `href="${p}.html"`)
    .replace(/href="docs\/adr\/"/g, 'href="docs/adr/README.html"'),
  "utf8",
);

console.log(`Built ${routes.size + 1} pages into _site/.`);
