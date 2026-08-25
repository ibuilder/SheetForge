/**
 * Spike, fourth question: can the paths that make up one symbol be grouped, so a door counts as
 * six doors rather than as three groups of six?
 *
 * Grouped by the transform they share. A vector producer emits one save/transform/…/restore per
 * placed instance, so the paths of a single symbol are exactly the paths drawn under one matrix.
 * Orientation is reported against the page's base matrix, because PDF space is y-up and a y-down
 * source would otherwise make every instance look mirrored.
 */
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ARITY = { 0: 2, 1: 2, 2: 6, 3: 4, 4: 0 };
const mul = (a, b) => [
  a[0]*b[0] + a[2]*b[1], a[1]*b[0] + a[3]*b[1],
  a[0]*b[2] + a[2]*b[3], a[1]*b[2] + a[3]*b[3],
  a[0]*b[4] + a[2]*b[5] + a[4], a[1]*b[4] + a[3]*b[5] + a[5],
];

function localSig(args) {
  const [, subpaths] = args;
  if (!Array.isArray(subpaths)) return null;
  const parts = [];
  for (const sub of subpaths) {
    const d = Array.from(sub);
    let i = 0;
    while (i < d.length) {
      const cmd = d[i], arity = ARITY[d[i]];
      if (arity === undefined) return null;
      parts.push(`c${cmd}`);
      for (let a = 0; a < arity; a += 1) parts.push(String(Math.round(d[i + 1 + a] * 100) / 100));
      i += 1 + arity;
    }
    parts.push("|");
  }
  return parts.join(" ");
}

const bytes = new Uint8Array(readFileSync(process.argv[2]));
const doc = await getDocument({ data: bytes, isEvalSupported: false }).promise;
const list = await (await doc.getPage(1)).getOperatorList();

let ctm = [1, 0, 0, 1, 0, 0];
const stack = [];
let base = null;               // the page's own matrix, taken from the first path drawn
const groups = [];             // one entry per run of paths sharing a matrix
let current = null;

const matrixKey = (m) => m.map((v) => Math.round(v * 1000) / 1000).join(",");

for (let i = 0; i < list.fnArray.length; i += 1) {
  const fn = list.fnArray[i];
  const args = list.argsArray[i];
  if (fn === OPS.save) { stack.push(ctm.slice()); continue; }
  if (fn === OPS.restore) { ctm = stack.pop() ?? [1,0,0,1,0,0]; continue; }
  if (fn === OPS.transform) { ctm = mul(ctm, args); continue; }
  if (fn !== OPS.constructPath) continue;

  const sig = localSig(args);
  if (!sig) continue;
  base ??= ctm.slice();

  const key = matrixKey(ctm);
  if (!current || current.key !== key) {
    current = { key, matrix: ctm.slice(), sigs: [] };
    groups.push(current);
  }
  current.sigs.push(sig);
}

// Orientation relative to the page, so the y-flip is not read as a mirror.
const relative = (m) => {
  const d = base[0]*base[3] - base[1]*base[2];
  const inv = [base[3]/d, -base[1]/d, -base[2]/d, base[0]/d,
               (base[2]*base[5] - base[3]*base[4])/d, (base[1]*base[4] - base[0]*base[5])/d];
  return mul(inv, m);
};
const describe = (m) => {
  const r = relative(m);
  const deg = ((Math.round((Math.atan2(r[1], r[0]) * 180) / Math.PI) % 360) + 360) % 360;
  const mirrored = r[0]*r[3] - r[1]*r[2] < 0;
  return `${deg}deg${mirrored ? " mirrored" : ""}`;
};

const symbols = new Map();
for (const g of groups) {
  const key = createHash("sha256").update(g.sigs.join(" ;; ")).digest("hex").slice(0, 8);
  const seen = symbols.get(key) ?? { paths: g.sigs.length, at: [] };
  seen.at.push(`(${Math.round(g.matrix[4])},${Math.round(g.matrix[5])}) ${describe(g.matrix)}`);
  symbols.set(key, seen);
}

console.log(`${groups.length} placed groups -> ${symbols.size} distinct symbols\n`);
for (const [key, v] of [...symbols.entries()].sort((a,b)=>b[1].at.length-a[1].at.length)) {
  const label = v.at.length > 1 ? `x${v.at.length}` : "once";
  console.log(`${key}  ${label}  (${v.paths} path${v.paths === 1 ? "" : "s"} each)`);
  for (const a of v.at.slice(0, 6)) console.log(`      ${a}`);
  if (v.at.length > 6) console.log(`      … ${v.at.length - 6} more`);
}
