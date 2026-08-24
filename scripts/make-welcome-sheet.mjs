/**
 * Generates the tutorial drawing that ships with SheetForge.
 *
 * A new user opens the application and is asked to find a PDF. That is a bad first minute: they
 * have to go and get a drawing before they can find out whether the tool is any good, and if the
 * first thing they open is a scanned dyeline from 1974 they will judge the product by it.
 *
 * So the application carries a sheet of its own. Not a blank page — a **real drawing**, laid out
 * like one: an ARCH D sheet with a border, a title block, a column grid, a graphic scale, and the
 * tutorial printed on it as keyed notes.
 *
 * ## The dimension is the point
 *
 * The sheet is drawn at `1/8" = 1'-0"` and carries a dimension string printed as `144'-0"` whose
 * geometry is *exactly* 1296 PDF points — 144 feet at one eighth of an inch per foot, at 72 points
 * per inch. So when the tutorial says "calibrate against this dimension, then measure the building
 * width", the answer the reader gets is checkable against the number printed on the sheet.
 *
 * A tutorial that cannot be checked teaches somebody to trust a number. On a takeoff tool that is
 * precisely the wrong lesson, and this is the one place we can teach the opposite for free.
 *
 * ## Why hand-written PDF
 *
 * No dependency, and the file is small and inspectable. The base-14 fonts need no embedding, and
 * everything here is lines, rectangles and text. It is generated rather than committed so it can be
 * reviewed as code and regenerated when the tutorial text changes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps", "desktop", "src-tauri", "assets");

// ARCH D, in PDF points. The standard sheet a plan set is plotted on.
const W = 36 * 72;
const H = 24 * 72;

/** 1/8" = 1'-0": one foot of building is 9 points of paper. */
const POINTS_PER_FOOT = 72 / 8;
/** The dimension the tutorial asks the reader to calibrate against. */
const DIMENSION_FEET = 144;
const DIMENSION_POINTS = DIMENSION_FEET * POINTS_PER_FOOT; // exactly 1296

const INK = "0.05 0.09 0.14";
const GREY = "0.45 0.50 0.56";
const LIGHT = "0.80 0.84 0.88";
const AMBER = "0.94 0.62 0.23";

/**
 * Escape a string for a PDF literal.
 *
 * The base-14 fonts are single-byte encoded, so anything outside Latin-1 would be written as a
 * mangled byte rather than the character intended. Rather than let that happen silently — a
 * tutorial sheet with a black diamond on it is a bad advertisement — the few typographic
 * characters that turn up in prose are folded to their ASCII equivalents, and anything else still
 * outside the range is refused loudly at generation time.
 */
const lit = (text) => {
  const folded = text
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
  const stray = [...folded].find((character) => character.codePointAt(0) > 0xff);
  if (stray) {
    throw new Error(
      `"${text}" contains ${JSON.stringify(stray)}, which the base-14 fonts cannot encode. ` +
        "Use an ASCII equivalent or embed a font.",
    );
  }
  return `(${folded.replace(/([\\()])/g, "\\$1")})`;
};

/** Text at a position. */
const text = (x, y, size, string, { font = "F1", colour = INK } = {}) =>
  `${colour} rg BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm ${lit(string)} Tj ET\n`;

const line = (x1, y1, x2, y2, { width = 1, colour = INK } = {}) =>
  `${colour} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S\n`;

const rect = (x, y, w, h, { width = 1, colour = INK } = {}) =>
  `${colour} RG ${width} w ${x} ${y} ${w} ${h} re S\n`;

const fill = (x, y, w, h, colour) => `${colour} rg ${x} ${y} ${w} ${h} re f\n`;

/** The mark, drawn rather than embedded: two sheets and a dimension, the same as the app icon. */
function logo(x, y, scale) {
  const s = (n) => n * scale;
  let out = fill(x, y, s(60), s(60), INK);
  out += fill(x + s(14), y + s(12), s(30), s(34), GREY);
  out += fill(x + s(8), y + s(6), s(30), s(34), "0.97 0.98 0.99");
  out += line(x + s(12), y + s(22), x + s(34), y + s(22), { width: s(2.5), colour: AMBER });
  return out;
}

/** A graphic scale bar — the thing that survives a sheet being re-plotted at another size. */
function scaleBar(x, y) {
  let out = text(x, y + 34, 9, "GRAPHIC SCALE", { colour: GREY });
  const foot = POINTS_PER_FOOT;
  for (let i = 0; i < 4; i += 1) {
    const segment = 20 * foot; // 20 feet per segment
    out += i % 2 === 0
      ? fill(x + i * segment, y, segment, 8, INK)
      : rect(x + i * segment, y, segment, 8, { width: 0.7 });
    out += text(x + i * segment - 6, y - 14, 8, `${i * 20}`, { colour: GREY });
  }
  out += text(x + 4 * 20 * foot - 8, y - 14, 8, "80", { colour: GREY });
  out += text(x + 4 * 20 * foot + 14, y - 2, 9, "FEET", { colour: GREY });
  return out;
}

/** Text centred on `x`. Helvetica averages a shade over half its point size per character. */
const centred = (x, y, size, string, options = {}) =>
  text(x - (string.length * size * 0.27), y, size, string, options);

/** Border, title block and sheet furniture, shared by both pages. */
function furniture(sheetNumber, sheetTitle) {
  const m = 36;
  const tb = 440; // Roughly six inches, which is what a real ARCH D title block occupies.
  let out = rect(m, m, W - 2 * m, H - 2 * m, { width: 2 });
  out += rect(m + 6, m + 6, W - 2 * m - 12, H - 2 * m - 12, { width: 0.7, colour: GREY });

  // Title block, right-hand edge, the way a real sheet carries it.
  const tx = W - m - tb - 6;
  const right = W - m - 30;
  out += line(tx, m + 6, tx, H - m - 6, { width: 1.2 });
  out += logo(tx + 30, H - m - 130, 1.4);
  out += text(tx + 140, H - m - 88, 30, "SheetForge", { font: "F2" });
  out += text(tx + 140, H - m - 114, 12, "Construction drawing review", { colour: GREY });
  out += line(tx + 30, H - m - 160, right, H - m - 160, { width: 1, colour: GREY });

  // Tight enough to read as one block. An earlier version spread these over the whole height and
  // the result looked like a sheet somebody had failed to fill in.
  const fields = [
    ["PROJECT", "Tutorial - Riverside Tower"],
    ["DRAWN BY", "SheetForge"],
    ["SCALE", '1/8" = 1\'-0"'],
    ["DATE", "Issued with this build"],
    ["STATUS", "Not for construction"],
  ];
  let fy = H - m - 220;
  for (const [label, value] of fields) {
    out += text(tx + 30, fy, 11, label, { colour: GREY });
    out += text(tx + 30, fy - 26, 17, value);
    out += line(tx + 30, fy - 40, right, fy - 40, { width: 0.5, colour: LIGHT });
    fy -= 84;
  }

  // A revision history, which is what occupies the middle of a real title block and what makes
  // the empty space below the fields look deliberate rather than unfinished.
  out += text(tx + 30, fy - 30, 11, "REVISIONS", { colour: GREY });
  const columns = [tx + 30, tx + 96, tx + 200];
  out += line(tx + 30, fy - 48, right, fy - 48, { width: 0.8, colour: GREY });
  ["REV", "DATE", "DESCRIPTION"].forEach((heading, index) => {
    out += text(columns[index], fy - 66, 9, heading, { colour: GREY });
  });
  out += line(tx + 30, fy - 76, right, fy - 76, { width: 0.5, colour: LIGHT });
  [
    ["A", "-", "Issued with the application"],
    ["", "", ""],
    ["", "", ""],
  ].forEach((row, index) => {
    const ry = fy - 100 - index * 30;
    row.forEach((cell, column) => {
      if (cell) out += text(columns[column], ry, 12, cell);
    });
    out += line(tx + 30, ry - 12, right, ry - 12, { width: 0.5, colour: LIGHT });
  });

  out += fill(tx + 30, m + 70, right - (tx + 30), 70, "0.96 0.97 0.98");
  out += text(tx + 46, m + 106, 40, sheetNumber, { font: "F2" });
  out += text(tx + 46, m + 86, 12, sheetTitle, { colour: GREY });
  return out;
}

/**
 * The legend, in the bottom-left corner where a drawing carries one.
 *
 * It does double duty: it fills the corner of the sheet the way real sheet furniture does, and it
 * tells a reader what the marks they are about to make will mean to whoever reads the set next.
 */
function legend(x, y) {
  const w = 900;
  const h = 300;
  let out = rect(x, y, w, h, { width: 1.2 });
  out += fill(x + 1, y + h - 40, w - 2, 39, "0.96 0.97 0.98");
  out += text(x + 18, y + h - 28, 14, "MARKUP LEGEND", { font: "F2", colour: GREY });
  out += line(x, y + h - 40, x + w, y + h - 40, { width: 0.8, colour: LIGHT });

  const row = (index, draw, label, note) => {
    const ry = y + h - 90 - index * 62;
    out += draw(x + 24, ry);
    out += text(x + 150, ry + 4, 15, label, { font: "F2" });
    out += text(x + 150, ry - 16, 12, note, { colour: GREY });
  };

  row(0,
    (sx, sy) => `${AMBER} RG 1.8 w [7 5] 0 d ${sx} ${sy - 14} 100 36 re S [] 0 d\n`,
    "Revision cloud",
    "An RFI, a clash, anything that needs an answer from somebody else.");
  row(1,
    (sx, sy) =>
      line(sx, sy + 4, sx + 100, sy + 4, { width: 1.6, colour: AMBER }) +
      line(sx, sy - 4, sx, sy + 12, { width: 1.2, colour: AMBER }) +
      line(sx + 100, sy - 4, sx + 100, sy + 12, { width: 1.2, colour: AMBER }),
    "Measurement",
    "Carries its scale, its calibration and the raw page length with it, so it can be checked later.");
  row(2,
    (sx, sy) => rect(sx, sy - 14, 100, 36, { width: 1.2, colour: GREY }),
    "Text and callouts",
    "Notes that belong to the review rather than to the drawing.");

  out += line(x, y + 42, x + w, y + 42, { width: 0.5, colour: LIGHT });
  out += text(x + 24, y + 18, 12,
    "Every markup is a record with an author, a timestamp and a status - never ink burnt into the PDF.",
    { colour: GREY });
  return out;
}

/**
 * A wireframe of the workspace, drawn on the sheet.
 *
 * Page one is a title sheet, and a title sheet with one column of text on it and four feet of
 * white space beside it looks unfinished. This fills the drawing area with something that also
 * earns its place: a reader who has never seen the application can match the words in the keyed
 * notes to the part of the screen they refer to.
 */
function workspaceDiagram(x, y, w, h) {
  let out = rect(x, y, w, h, { width: 1.6 });

  // Header strip.
  const headerHeight = 54;
  out += fill(x + 1, y + h - headerHeight, w - 2, headerHeight - 1, "0.96 0.97 0.98");
  out += line(x, y + h - headerHeight, x + w, y + h - headerHeight, { width: 0.8, colour: LIGHT });
  out += text(x + 20, y + h - 34, 16, "SheetForge", { font: "F2" });
  out += fill(x + w - 260, y + h - 40, 96, 26, AMBER);
  out += text(x + w - 246, y + h - 32, 11, "Open PDF", { colour: "1 1 1" });
  out += rect(x + w - 154, y + h - 40, 60, 26, { width: 0.8, colour: LIGHT });
  out += text(x + w - 144, y + h - 32, 11, "Export", { colour: GREY });

  // Sidebar: the sheet index.
  const sidebar = 150;
  out += line(x + sidebar, y, x + sidebar, y + h - headerHeight, { width: 0.8, colour: LIGHT });
  out += text(x + 18, y + h - headerHeight - 26, 11, "DRAWINGS", { colour: GREY });
  for (let i = 0; i < 4; i += 1) {
    const sy = y + h - headerHeight - 56 - i * 30;
    if (i === 0) out += fill(x + 10, sy - 8, sidebar - 20, 24, "0.93 0.95 0.97");
    out += text(x + 20, sy, 11, ["A-201", "A-202", "M-401", "S-101"][i], { colour: i === 0 ? INK : GREY });
  }

  // Stage: a scrap of plan with a cloud on it and a measurement across it.
  const sx = x + sidebar + 40;
  const sy = y + 90;
  const sw = w - sidebar - 300;
  const sh = h - headerHeight - 150;
  out += rect(sx, sy, sw, sh, { width: 1, colour: LIGHT });
  out += line(sx + sw * 0.32, sy, sx + sw * 0.32, sy + sh, { width: 0.6, colour: LIGHT });
  out += line(sx, sy + sh * 0.55, sx + sw, sy + sh * 0.55, { width: 0.6, colour: LIGHT });

  // The markup: dashed, because a cloud drawn as a plain box would not read as an annotation.
  out += `${AMBER} RG 2 w [7 5] 0 d ${sx + 40} ${sy + sh * 0.62} ${sw * 0.26} ${sh * 0.3} re S [] 0 d\n`;
  out += text(sx + 46, sy + sh * 0.62 - 20, 11, "RFI 014 - clash", { colour: AMBER });

  // The measurement, with its quantity called out the way the application shows it.
  const my = sy + sh * 0.22;
  out += line(sx + 40, my, sx + sw - 60, my, { width: 1.6, colour: AMBER });
  out += fill(sx + sw * 0.38, my - 10, 120, 22, "1 1 1");
  out += text(sx + sw * 0.38 + 10, my - 4, 12, "148'-6\"", { colour: AMBER });

  // Properties panel.
  const px = sx + sw + 24;
  const pw = x + w - px - 20;
  out += rect(px, sy, pw, sh, { width: 0.8, colour: LIGHT });
  out += text(px + 14, sy + sh - 26, 11, "MARKUP", { colour: GREY });
  const rows = ["Subject", "Discipline", "Cost code", "Status", "Quantity"];
  rows.forEach((label, index) => {
    const ry = sy + sh - 56 - index * 34;
    out += text(px + 14, ry, 10, label, { colour: GREY });
    out += fill(px + 14, ry - 20, pw - 28, 14, "0.94 0.96 0.97");
  });

  return out;
}

/** Page 1: what this is, and the five things worth trying. */
function pageOne() {
  let out = furniture("T-101", "GETTING STARTED");
  const x = 110;

  out += text(x, H - 190, 62, "Welcome - this is a real drawing.", { font: "F2" });
  out += text(x, H - 232, 20,
    "Mark it up. Measure it. Nothing here is a mock-up, and nothing you do to it can hurt anything.",
    { colour: GREY });
  out += line(x, H - 268, x + 1000, H - 268, { width: 1, colour: LIGHT });

  let y = H - 350;
  const note = (n, title, body) => {
    // A keyed note, the way a drawing carries one: a numbered box and a line of text.
    out += fill(x, y - 10, 40, 40, AMBER);
    out += text(x + 13, y + 2, 22, `${n}`, { colour: "1 1 1", font: "F2" });
    out += text(x + 60, y + 4, 28, title, { font: "F2" });
    out += text(x + 60, y - 26, 16, body, { colour: GREY });
    y -= 150;
  };

  note("1", "Draw a revision cloud",
    "Pick the cloud tool and drag a box around something. Give it a subject and a discipline in the panel on the right.");
  note("2", "Calibrate the scale",
    'Turn to page 2 and calibrate against the dimension printed there - it reads 144\'-0". Then measure the building width.');
  note("3", "Check the answer",
    "The width is printed on the sheet. If your measurement agrees, the scale is right. That is the habit worth forming.");
  note("4", "Filter the markup list",
    "Add a few markups with different disciplines, then filter. The drawing dims everything you filtered out.");
  note("5", "Export the summary",
    "Export, then Summary (XLSX). Three sheets: the register, the takeoff with its provenance, and a roll-up by cost code.");

  y -= 20;
  out += line(x, y + 40, x + 1000, y + 40, { width: 1, colour: LIGHT });
  out += text(x, y, 16,
    "Your markups are saved as you draw. There is no Save button; the status bar tells you the state.",
    { colour: GREY });
  out += text(x, y - 30, 16,
    "This sheet lives in Documents/SheetForge. Delete that folder and it is gone - nothing is kept anywhere else.",
    { colour: GREY });
  out += text(x, y - 60, 16,
    "No account, no cloud, no telemetry. The application makes no network request unless you ask it to check for an update.",
    { colour: GREY });

  // The wireframe, filling the right half of the drawing area.
  const dx = 1230;
  out += text(dx, 1360, 26, "What you are looking at", { font: "F2" });
  out += text(dx, 1330, 15,
    "The keyed notes on the left refer to these parts of the workspace.",
    { colour: GREY });
  out += workspaceDiagram(dx, 430, 850, 870);

  out += legend(x, 200);
  out += scaleBar(dx, 250);
  return out;
}

/** Page 2: the practice sheet, with a dimension whose true length is knowable. */
function pageTwo() {
  let out = furniture("A-201", "SECOND FLOOR PLAN");

  const w = DIMENSION_FEET * POINTS_PER_FOOT;
  const d = 96 * POINTS_PER_FOOT;
  // Centred in the drawing area rather than parked in a corner, which is where a plan sits on a
  // sheet somebody actually issued.
  const left = 420;
  const bottom = 430;

  out += rect(left, bottom, w, d, { width: 2.5 });

  // A column grid on 24-foot bays, lettered and numbered as a real plan is. Bubbles, because a
  // bare letter floating above a line is not how a grid is called out.
  const bay = 24 * POINTS_PER_FOOT;
  const bubble = (cx, cy, label) => {
    // An octagon stands in for the circle: eight lines are cheaper than four Bezier curves and at
    // this size the difference is invisible.
    const r = 13;
    const k = r * 0.4142;
    const points = [
      [cx - k, cy + r], [cx + k, cy + r], [cx + r, cy + k], [cx + r, cy - k],
      [cx + k, cy - r], [cx - k, cy - r], [cx - r, cy - k], [cx - r, cy + k],
    ];
    let shape = `1 1 1 rg ${GREY} RG 0.8 w ${points[0][0]} ${points[0][1]} m `;
    for (const [px, py] of points.slice(1)) shape += `${px} ${py} l `;
    shape += "h B\n";
    return shape + centred(cx, cy - 4, 11, label, { colour: GREY });
  };

  for (let i = 0; i * bay <= w; i += 1) {
    const gx = left + i * bay;
    if (i > 0 && i * bay < w) {
      out += line(gx, bottom, gx, bottom + d, { width: 0.6, colour: LIGHT });
    }
    out += line(gx, bottom + d, gx, bottom + d + 40, { width: 0.6, colour: LIGHT });
    out += bubble(gx, bottom + d + 54, String.fromCharCode(65 + i));
  }
  for (let i = 0; i * bay <= d; i += 1) {
    const gy = bottom + i * bay;
    if (i > 0 && i * bay < d) {
      out += line(left, gy, left + w, gy, { width: 0.6, colour: LIGHT });
    }
    out += line(left - 40, gy, left, gy, { width: 0.6, colour: LIGHT });
    out += bubble(left - 54, gy, `${i + 1}`);
  }

  // Rooms, so there is something to measure the area of.
  out += rect(left + bay, bottom + bay, bay * 2, bay * 2, { width: 1.4, colour: GREY });
  out += text(left + bay + 16, bottom + bay * 2 + 10, 17, "OPEN OFFICE", { font: "F2", colour: GREY });
  out += text(left + bay + 16, bottom + bay * 2 - 14, 13, "48'-0\" x 48'-0\" = 2,304 SF", { colour: GREY });

  out += rect(left + bay * 4, bottom + bay, bay * 1.5, bay, { width: 1.4, colour: GREY });
  out += text(left + bay * 4 + 16, bottom + bay * 1.5 + 4, 14, "PLANT", { colour: GREY });

  // The dimension string. Its geometry is exactly 144 feet at this scale, and it says so.
  const dy = bottom - 90;
  out += line(left, dy, left + DIMENSION_POINTS, dy, { width: 1.5, colour: AMBER });
  for (const wx of [left, left + DIMENSION_POINTS]) {
    out += line(wx, dy - 16, wx, bottom - 8, { width: 1, colour: AMBER });
    out += line(wx - 8, dy - 8, wx + 8, dy + 8, { width: 1.5, colour: AMBER });
  }
  out += fill(left + DIMENSION_POINTS / 2 - 60, dy - 12, 120, 26, "1 1 1");
  out += centred(left + DIMENSION_POINTS / 2, dy - 6, 22, "144'-0\"", { colour: AMBER, font: "F2" });

  // The depth, so an area check has two knowable sides.
  const vx = left - 140;
  out += line(vx, bottom, vx, bottom + d, { width: 1.5, colour: AMBER });
  for (const wy of [bottom, bottom + d]) {
    out += line(vx - 8, wy - 8, vx + 8, wy + 8, { width: 1.5, colour: AMBER });
  }
  out += fill(vx - 55, bottom + d / 2 - 13, 110, 26, "1 1 1");
  out += centred(vx, bottom + d / 2 - 7, 22, "96'-0\"", { colour: AMBER, font: "F2" });

  out += text(left - 140, H - 200, 40, "Practice sheet", { font: "F2" });
  out += text(left - 140, H - 240, 17,
    'Calibrate against the 144\'-0" dimension below the plan, then measure the far side. It should read 96\'-0".',
    { colour: GREY });
  out += text(left - 140, H - 268, 17,
    "Measure the OPEN OFFICE as an area and you should get 2,304 SF - the number printed inside it.",
    { colour: GREY });
  out += text(left - 140, H - 296, 17,
    "If either answer disagrees, the calibration is wrong rather than the sheet. Set it again and check.",
    { colour: GREY });

  out += scaleBar(left, 200);
  return out;
}

// ---------------------------------------------------------------------------
// Assemble the file
// ---------------------------------------------------------------------------

const streams = [pageOne(), pageTwo()];

// Object numbers are positional and referenced by hand throughout, so they are named once here
// rather than counted at each use. Getting one wrong produces a file that opens and is subtly
// wrong, which is the worst kind of PDF bug to chase.
const INFO = 9;
const OUTLINES = 10;
const OUTLINE_GETTING_STARTED = 11;
const OUTLINE_PRACTICE = 12;

const objects = [
  // The outline is what a construction set carries and what makes a 200-sheet PDF navigable. Two
  // entries is not much of a table of contents, but a tutorial that demonstrates the feature is
  // worth more than one that describes it — and it gives the interface's own outline panel
  // something real to be tested against.
  `<< /Type /Catalog /Pages 2 0 R /Outlines ${OUTLINES} 0 R /PageMode /UseOutlines >>`,
  `<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>`,
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 4 0 R >>`,
  { stream: streams[0] },
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 6 0 R >>`,
  { stream: streams[1] },
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  `<< /Title ${lit("SheetForge - tutorial sheet")} /Author (SheetForge) ` +
    `/Subject ${lit("A drawing to practise on")} /Creator (SheetForge) >>`,

  // The outline tree: a root, then one entry per sheet. `/Fit` rather than an explicit position,
  // because the reader should land on the whole sheet rather than at some point on it.
  `<< /Type /Outlines /First ${OUTLINE_GETTING_STARTED} 0 R /Last ${OUTLINE_PRACTICE} 0 R ` +
    `/Count 2 >>`,
  `<< /Title ${lit("T-101 Getting started")} /Parent ${OUTLINES} 0 R ` +
    `/Next ${OUTLINE_PRACTICE} 0 R /Dest [3 0 R /Fit] >>`,
  `<< /Title ${lit("A-201 Practice sheet")} /Parent ${OUTLINES} 0 R ` +
    `/Prev ${OUTLINE_GETTING_STARTED} 0 R /Dest [5 0 R /Fit] >>`,
];

const chunks = [];
let length = 0;
const push = (text) => {
  const bytes = Buffer.from(text, "latin1");
  chunks.push(bytes);
  length += bytes.length;
};

push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
const offsets = [];
objects.forEach((object, index) => {
  offsets.push(length);
  const body =
    typeof object === "string"
      ? object
      : `<< /Length ${Buffer.byteLength(object.stream, "latin1")} >>\nstream\n${object.stream}endstream`;
  push(`${index + 1} 0 obj\n${body}\nendobj\n`);
});

const xref = length;
push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
for (const offset of offsets) push(`${String(offset).padStart(10, "0")} 00000 n \n`);
push(
  `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${INFO} 0 R >>\n` +
    `startxref\n${xref}\n%%EOF\n`,
);

mkdirSync(OUT, { recursive: true });
const file = join(OUT, "welcome.pdf");
writeFileSync(file, Buffer.concat(chunks));

console.log(`Wrote ${file} (${(length / 1024).toFixed(1)} KB, 2 pages, ARCH D).`);

// A guard against the hazard of hand-numbered objects: the Info dictionary is referenced by
// number in the trailer, and a reference to the wrong object produces a file that opens fine and
// reports somebody else's data as its metadata.
if (objects[INFO - 1] === undefined || !String(objects[INFO - 1]).includes("/Creator")) {
  throw new Error(`object ${INFO} is not the Info dictionary - the object numbering has drifted`);
}
console.log(
  `The dimension is ${DIMENSION_POINTS} points = ${DIMENSION_FEET} ft at 1/8" = 1'-0", so the ` +
    `tutorial's answer is checkable rather than asserted.`,
);
