/**
 * A real icon set for the drawing engine's toolbar.
 *
 * The engine ships Unicode glyphs — `⤓`, `⇥`, `⌂`, `Σ`, `🗂` — which is a sensible default for a
 * library with no opinion about its host's design, and looks like a mishmash in a product: the
 * glyphs come from different Unicode blocks, render in different fonts at different weights, and
 * one of them is a colour emoji. Fifty of them in two rows is unreadable.
 *
 * So this maps the engine's action and tool ids onto [Lucide](https://lucide.dev) icons — one
 * family, one stroke weight, drawn as a set. The engine is untouched: it renders its glyph, and
 * this replaces the button's contents afterwards, keyed on the `data-id` the toolbar already puts
 * on every button.
 *
 * ## Why replacement rather than configuration
 *
 * The engine's `ActionDef.icon` is a string assigned to `textContent`, so it cannot carry markup.
 * Extending the engine to accept SVG would be the tidier fix and belongs upstream; doing it here
 * keeps SheetForge on released versions of the engine rather than a fork.
 *
 * ## On `innerHTML`
 *
 * The SVG source is a build-time import from a pinned dependency — it is as much a constant as a
 * string literal in this file, and no user input reaches it. That is the only reason this is
 * acceptable in a codebase that otherwise treats markup construction as a hazard.
 */

import chevronLeft from "lucide-static/icons/chevron-left.svg?raw";
import chevronRight from "lucide-static/icons/chevron-right.svg?raw";
import zoomIn from "lucide-static/icons/zoom-in.svg?raw";
import zoomOut from "lucide-static/icons/zoom-out.svg?raw";
import moveHorizontal from "lucide-static/icons/move-horizontal.svg?raw";
import maximize from "lucide-static/icons/maximize.svg?raw";
import rotateCw from "lucide-static/icons/rotate-cw.svg?raw";
import pointer from "lucide-static/icons/mouse-pointer-2.svg?raw";
import undo from "lucide-static/icons/undo-2.svg?raw";
import redo from "lucide-static/icons/redo-2.svg?raw";
import trash from "lucide-static/icons/trash-2.svg?raw";

import square from "lucide-static/icons/square.svg?raw";
import circle from "lucide-static/icons/circle.svg?raw";
import pentagon from "lucide-static/icons/pentagon.svg?raw";
import spline from "lucide-static/icons/spline.svg?raw";
import minus from "lucide-static/icons/minus.svg?raw";
import arrowUpRight from "lucide-static/icons/arrow-up-right.svg?raw";
import cloud from "lucide-static/icons/cloud.svg?raw";
import penTool from "lucide-static/icons/pen-tool.svg?raw";
import type_ from "lucide-static/icons/type.svg?raw";
import messageSquareQuote from "lucide-static/icons/message-square-quote.svg?raw";
import highlighter from "lucide-static/icons/highlighter.svg?raw";
import strikethrough from "lucide-static/icons/strikethrough.svg?raw";
import underline from "lucide-static/icons/underline.svg?raw";
import stamp from "lucide-static/icons/stamp.svg?raw";
import mapPin from "lucide-static/icons/map-pin.svg?raw";
import shapes from "lucide-static/icons/shapes.svg?raw";

import ruler from "lucide-static/icons/ruler.svg?raw";
import frame from "lucide-static/icons/frame.svg?raw";
import hash from "lucide-static/icons/hash.svg?raw";
import triangle from "lucide-static/icons/triangle.svg?raw";
import circleDot from "lucide-static/icons/circle-dot.svg?raw";
import box from "lucide-static/icons/box.svg?raw";
import scaling from "lucide-static/icons/scaling.svg?raw";

import fileDown from "lucide-static/icons/file-down.svg?raw";
import table from "lucide-static/icons/table.svg?raw";
import sigma from "lucide-static/icons/sigma.svg?raw";
import fileOutput from "lucide-static/icons/file-output.svg?raw";
import building from "lucide-static/icons/building-2.svg?raw";
import fileArchive from "lucide-static/icons/file-archive.svg?raw";
import save from "lucide-static/icons/save.svg?raw";
import fileInput from "lucide-static/icons/file-input.svg?raw";
import folderOpen from "lucide-static/icons/folder-open.svg?raw";

import scanText from "lucide-static/icons/scan-text.svg?raw";
import scanSearch from "lucide-static/icons/scan-search.svg?raw";
import search from "lucide-static/icons/search.svg?raw";
import bookmark from "lucide-static/icons/bookmark.svg?raw";
import columns from "lucide-static/icons/columns-2.svg?raw";
import files from "lucide-static/icons/files.svg?raw";
import layers from "lucide-static/icons/layers.svg?raw";
import gitCompare from "lucide-static/icons/git-compare.svg?raw";
import eraser from "lucide-static/icons/eraser.svg?raw";
import gitBranch from "lucide-static/icons/git-branch.svg?raw";
import check from "lucide-static/icons/check.svg?raw";
import cross from "lucide-static/icons/x.svg?raw";
import refreshCw from "lucide-static/icons/refresh-cw.svg?raw";
import refreshCcw from "lucide-static/icons/refresh-ccw.svg?raw";
import flag from "lucide-static/icons/flag.svg?raw";
import circleCheck from "lucide-static/icons/circle-check.svg?raw";
import bookOpen from "lucide-static/icons/book-open.svg?raw";
import link from "lucide-static/icons/link.svg?raw";
import paperclip from "lucide-static/icons/paperclip.svg?raw";
import mic from "lucide-static/icons/mic.svg?raw";
import palette from "lucide-static/icons/palette.svg?raw";
import brush from "lucide-static/icons/brush.svg?raw";
import copy from "lucide-static/icons/copy.svg?raw";
import contrast from "lucide-static/icons/contrast.svg?raw";
import eye from "lucide-static/icons/eye.svg?raw";

/**
 * Engine id → icon.
 *
 * Choices worth explaining rather than defending as obvious:
 *
 * - **Measurement kinds get distinct icons**, not one ruler with variations, because on a takeoff
 *   the difference between a length and an area is the difference between a right number and a
 *   number wrong by the scale factor.
 * - **Import and export mirror each other** (`file-input` / `file-output`), so the direction reads
 *   from the shape rather than from the tooltip.
 * - **Destructive actions are the only ones that get a different treatment**, in CSS below.
 */
const ICONS: Record<string, string> = {
  // View and edit
  "view.prev": chevronLeft,
  "view.next": chevronRight,
  "view.zoomIn": zoomIn,
  "view.zoomOut": zoomOut,
  "view.fitWidth": moveHorizontal,
  "view.fitPage": maximize,
  "view.rotate": rotateCw,
  "view.select": pointer,
  "edit.undo": undo,
  "edit.redo": redo,
  "edit.delete": trash,

  // Markup tools
  rect: square,
  ellipse: circle,
  polygon: pentagon,
  polyline: spline,
  line: minus,
  arrow: arrowUpRight,
  cloud,
  ink: penTool,
  text: type_,
  callout: messageSquareQuote,
  highlight: highlighter,
  strikeout: strikethrough,
  underline,
  stamp,
  pin: mapPin,
  symbol: shapes,

  // Measurement
  distance: ruler,
  perimeter: frame,
  area: square,
  count: hash,
  angle: triangle,
  radius: circleDot,
  volume: box,
  calibrate: scaling,

  // Interchange
  "export.pdf": fileDown,
  "export.csv": table,
  "export.takeoff": sigma,
  "export.xfdf": fileOutput,
  "export.bcf": building,
  "export.bcfzip": fileArchive,
  "export.json": save,
  "import.xfdf": fileInput,
  "import.json": folderOpen,

  // Everything else
  "ocr.page": scanText,
  "ocr.document": scanSearch,
  "search.focus": search,
  "views.save": bookmark,
  "views.split": columns,
  "compare.load": files,
  "compare.overlay": layers,
  "compare.diff": gitCompare,
  "compare.cloud": cloud,
  "compare.clearClouds": eraser,
  "migration.analyse": gitBranch,
  "migration.apply": check,
  "migration.discard": cross,
  "persistence.save": save,
  "persistence.reload": refreshCw,
  "sheets.rescan": refreshCcw,
  "pins.promote": flag,
  "pins.status": circleCheck,
  "specs.parse": bookOpen,
  "specs.citeNearest": link,
  "stamps.pick": stamp,
  "attachments.add": paperclip,
  "attachments.voice": mic,
  "markup.discipline": palette,
  "markup.applyStyle": brush,
  "measure.preset": ruler,
  "measure.applyAllPages": copy,
  "historical.contrast": contrast,
  "historical.invert": eye,
  "historical.trace": layers,
  "historical.reset": refreshCcw,
  "historical.confidence": circleDot,
  "historical.transcribe": type_,
};

/** Parsed once. Cloning a node beats re-parsing markup on every toolbar render. */
const templates = new Map<string, SVGElement>();

function template(id: string): SVGElement | undefined {
  const cached = templates.get(id);
  if (cached) return cached;

  const source = ICONS[id];
  if (!source) return undefined;

  const holder = document.createElement("div");
  // Build-time constant from a pinned dependency — see the module docs.
  holder.innerHTML = source;
  const svg = holder.querySelector("svg");
  if (!svg) return undefined;

  svg.setAttribute("class", "sf-icon");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  // The button already carries the accessible name; the icon is decoration on top of it, and a
  // second name here would have a screen reader announce the label twice.
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  templates.set(id, svg);
  return svg;
}

/**
 * Replace glyphs with icons everywhere under `root`, and keep doing so as the toolbar changes.
 *
 * Returns a function that stops observing — the caller must call it before dropping the viewer, or
 * the observer outlives the DOM it was watching.
 */
export function applyIcons(root: HTMLElement): () => void {
  const paint = (): void => {
    for (const node of root.querySelectorAll<HTMLElement>("[data-id]")) {
      if (node.dataset["sfIcon"] === "done") continue;
      const svg = template(node.dataset["id"] ?? "");
      if (!svg) continue;
      node.replaceChildren(svg.cloneNode(true));
      node.dataset["sfIcon"] = "done";
    }
  };

  paint();

  // The engine rebuilds parts of its toolbar when plugins register late or a panel opens, which
  // would otherwise leave a handful of glyphs behind among the icons.
  const observer = new MutationObserver(paint);
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
