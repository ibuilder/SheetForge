/**
 * Print `plan.html` to PDF through Chromium.
 *
 * Chromium rather than a hand-written PDF writer on purpose: the question this spike answers is
 * whether symbol counting survives *somebody else's* serialisation, and a file this repository
 * emitted itself cannot answer that. Chromium is not a CAD exporter either — see the ADR — but it
 * is an independent producer, which is the part that matters here.
 */
import { chromium } from "playwright";

const [, , source, destination] = process.argv;
if (!source || !destination) {
  console.error("usage: node print-plan.mjs <plan.html> <out.pdf>");
  process.exit(2);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(new URL(source, `file://${process.cwd()}/`).href);
  await page.pdf({ path: destination, width: "36in", height: "24in", printBackground: true });
} finally {
  await browser.close();
}
console.log(`printed ${destination}`);
