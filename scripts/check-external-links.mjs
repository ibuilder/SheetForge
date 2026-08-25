/**
 * Do the links that leave this site still go anywhere?
 *
 * `check-site-links.mjs` verifies everything *inside* the built site and deliberately skips
 * anything starting `http`, because those are somebody else's problem and go wrong for reasons
 * unrelated to a change here. That skip hid a real one: the changelog pointed at
 * `/releases/tag/v0.1.0`, which returns 404 until a release is actually published, and it sat on
 * the live documentation site being wrong.
 *
 * ## Why this is not in CI
 *
 * A build that fails because somebody else's blog was down for a minute trains everybody to
 * ignore a red build, which costs more than the broken link it was meant to catch. Rate limits
 * make it worse: forty requests to one host in five seconds gets throttled, and a throttle is
 * indistinguishable from a 404 at this level.
 *
 * So it is run deliberately — before a release, and whenever the documentation gains links —
 * rather than on every push. `docs/runbooks/release.md` lists it.
 *
 * ## What a failure means
 *
 * Read the output before believing it. `000` means the request did not complete at all, which is
 * usually this machine's network rather than the destination; a `404` from a host whose other
 * links returned `200` is the real thing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "_site");

/** Every rendered page. */
function pages(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...pages(full));
    else if (entry.name.endsWith(".html")) found.push(full);
  }
  return found;
}

/** url -> the pages that link to it, so a failure names somewhere to go and fix it. */
const links = new Map();
for (const page of pages(OUT)) {
  const html = readFileSync(page, "utf8");
  for (const match of html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)) {
    const url = match[1];
    if (!links.has(url)) links.set(url, []);
    links.get(url).push(page);
  }
}

const urls = [...links.keys()].sort();
console.log(`Checking ${urls.length} external links.\n`);

const broken = [];
const unreachable = [];

for (const url of urls) {
  let status = 0;
  try {
    // HEAD first: it is what a link check needs and what a host is happiest serving. Some reject
    // it, so a non-2xx HEAD is retried as a GET before being believed.
    let response = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!response.ok) {
      response = await fetch(url, { method: "GET", redirect: "follow" });
    }
    status = response.status;
  } catch {
    status = 0;
  }

  if (status >= 200 && status < 400) continue;
  const entry = { url, status, from: links.get(url) };
  if (status === 0) unreachable.push(entry);
  else broken.push(entry);

  // Gentle: forty requests to one host in five seconds is throttled, and a throttle reads exactly
  // like a broken link from here.
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const report = (entries, heading) => {
  if (entries.length === 0) return;
  console.error(`\n${heading}`);
  for (const { url, status, from } of entries) {
    console.error(`  ${status || "---"}  ${url}`);
    console.error(`        linked from ${from.length} page(s)`);
  }
};

report(broken, "Links that answered, and said no:");
report(
  unreachable,
  "Links that could not be reached at all — usually this machine's network, not the destination:",
);

if (broken.length > 0) {
  console.error(`\n${broken.length} broken.`);
  process.exit(1);
}

console.log(
  unreachable.length === 0
    ? "Every external link resolves."
    : `\nNo broken links. ${unreachable.length} could not be reached from here; check them by hand.`,
);
