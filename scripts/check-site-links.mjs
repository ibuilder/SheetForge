/**
 * Fails if the built site contains an internal link that goes nowhere.
 *
 * Cross-references between the guides, the decision records and the security documents are most of
 * what makes the documentation navigable, and they break silently: a renamed file or a moved
 * section produces a 404 that nobody notices until a reader hits it. This runs in CI so a rename
 * fails the build instead.
 *
 * Only internal links are checked. External ones are somebody else's uptime and checking them here
 * would make the build fail for reasons unrelated to the change that triggered it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "_site");

if (!existsSync(OUT)) {
  console.error("_site/ does not exist. Run `npm run site:build` first.");
  process.exit(1);
}

function pages(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...pages(full));
    else if (entry.name.endsWith(".html")) found.push(full);
  }
  return found;
}

const broken = [];
let checked = 0;

for (const page of pages(OUT)) {
  const html = readFileSync(page, "utf8");
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1];
    if (/^(https?:|mailto:|data:|#)/i.test(href)) continue;

    checked += 1;
    const [path] = href.split("#");
    if (!path) continue;
    if (!existsSync(resolve(dirname(page), path))) {
      broken.push(`${relative(OUT, page).split("\\").join("/")}  ->  ${href}`);
    }
  }
}

console.log(`Checked ${checked} internal links across ${pages(OUT).length} pages.`);

if (broken.length > 0) {
  console.error(`\n${broken.length} broken link(s):`);
  for (const entry of broken) console.error(`  ${entry}`);
  process.exit(1);
}

console.log("No broken internal links.");
