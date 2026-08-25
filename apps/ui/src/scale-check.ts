/**
 * Checking a page's scale against something the drawing already tells you.
 *
 * Calibration is the one place a takeoff goes quietly wrong. Every quantity on a page is the raw
 * page measurement times the scale — and every *area* times its square — so a scale out by a
 * factor of two makes every length half right and every area a quarter right, with nothing on
 * screen looking unusual. The numbers stay plausible and internally consistent, and they are all
 * wrong together.
 *
 * The tutorial sheet has taught this since it shipped: calibrate against the printed `144'-0"`,
 * then measure the other side and see whether it says `96'-0"`. What was missing was a tool for
 * doing it, so the lesson ended at "and now check it by hand".
 *
 * This is that tool. Drag along a dimension whose length is printed on the sheet, type what it
 * says, and the answer is graded rather than left as a percentage nobody converts into a decision.
 *
 * The grading and the arithmetic live in `sf-domain`, not here. Where the bands sit is a domain
 * judgement with tests behind it, and putting it in a click handler is how a rule ends up
 * different in the importer.
 */
import { definePlugin, measure } from "@massingcloud/pdf-viewer";

import { host } from "./bridge";

/** What the host concluded, and what to do about it. */
export interface CheckOutcome {
  verdict: "agrees" | "close" | "wrong";
  /** Signed, as a proportion. Negative means the measurement came out short. */
  error: number;
  measured: number;
  expected: number;
  likelyCause: string | null;
}

/**
 * The tool, as a plugin.
 *
 * @param askForLength Ask what the dimension says. Returns null if the user changes their mind.
 * @param report Say what came of it.
 */
export function scaleCheckPlugin(
  askForLength: (measured: string) => string | null,
  report: (outcome: CheckOutcome, unit: string) => void,
) {
  return definePlugin({
    id: "sheetforge-scale-check",
    setup(context) {
      context.registerTool({
        id: "check-scale",
        label: "Check a dimension",
        icon: "⇔",
        group: "measure",
        input: "drag",
        // `distance` is the kind the gesture produces. Nothing is ever committed — the
        // create hook returns null — but the kernel needs to know what it would have been.
        kind: "distance",
        cursor: "crosshair",
        // The page has to be calibrated for this to mean anything: without a scale there is no
        // measurement to compare, only a length in points. The kernel refuses the commit and says
        // so, which is a better message than anything written here.
        needsCalibration: true,
        create: async (commit) => {
          const viewer = context.viewer;
          const calibration = viewer.store.calibration(commit.page);
          const quantity = measure("distance", commit.points, calibration);
          if (!quantity) return null;

          const answer = askForLength(formatMagnitude(quantity.value));
          if (answer === null) return null;

          const expected = parseLength(answer);
          if (expected === null) {
            report(
              {
                verdict: "wrong",
                error: 0,
                measured: quantity.value,
                expected: 0,
                likelyCause: `"${answer}" is not a length. Write something like 144, 144'-0" or 43.9m.`,
              },
              quantity.unit,
            );
            return null;
          }

          const outcome = await host.scaleCheck(expected, quantity.value);
          report(outcome, quantity.unit);

          // Nothing is drawn. A check is a question about the page, not a markup on it — leaving a
          // line behind would put a measurement in the register that nobody asked to record and
          // that would be exported alongside real ones.
          return null;
        },
      });
    },
  });
}

/** Enough decimals to be useful, few enough to read. */
function formatMagnitude(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}

/**
 * Read a length the way somebody writes one on a drawing.
 *
 * `144`, `144.5`, `144'`, `144'-0"`, `144' 6"`, `43.9m`, `12mm`. Feet-and-inches is the form that
 * matters: it is what a dimension string on an imperial sheet actually says, and asking somebody
 * to convert it to a decimal before typing it is asking them to make an arithmetic mistake in the
 * middle of a check for arithmetic mistakes.
 *
 * Returns the magnitude in whatever unit was written, which is the page's unit by assumption — the
 * comparison is between two numbers in the same unit, and mixing them is a bug this must not hide.
 * Anything unreadable returns null rather than a guess.
 */
export function parseLength(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  // Feet and inches: 144'-0", 144' 6", 144'6", 144'.
  const imperial = /^(\d+(?:\.\d+)?)\s*'\s*(?:-\s*)?(?:(\d+(?:\.\d+)?)\s*"?)?$/.exec(text);
  if (imperial) {
    const feet = Number(imperial[1]);
    const inches = imperial[2] === undefined ? 0 : Number(imperial[2]);
    if (inches >= 12) return null; // 144'-13" is a typo, not a dimension.
    return feet + inches / 12;
  }

  // Inches alone: 18".
  const inchesOnly = /^(\d+(?:\.\d+)?)\s*"$/.exec(text);
  if (inchesOnly) return Number(inchesOnly[1]) / 12;

  // A plain number, with or without a unit suffix the page already knows about.
  const plain = /^(\d+(?:\.\d+)?)\s*(mm|cm|m|ft|in)?$/.exec(text);
  if (plain) {
    const value = Number(plain[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  return null;
}

/** How an outcome should be said out loud. */
export function describe(outcome: CheckOutcome, unit: string): string {
  const percent = Math.abs(outcome.error * 100);
  const drift = percent < 0.05 ? "exactly" : `${percent.toFixed(1)}% ${outcome.error < 0 ? "short" : "long"}`;
  const measured = `${formatMagnitude(outcome.measured)} ${unit}`;

  switch (outcome.verdict) {
    case "agrees":
      return `The scale checks out — measured ${measured}, ${drift === "exactly" ? "exactly as printed" : `${drift}`}.`;
    case "close":
      return (
        `Measured ${measured}, ${drift}. That is more than drawing error on a long dimension. ` +
        "Draw it again along the dimension line, and re-calibrate if it stays out."
      );
    case "wrong":
      return (
        `Measured ${measured}, ${drift}. The scale on this page is wrong.` +
        (outcome.likelyCause ? ` ${capitalise(outcome.likelyCause)}.` : "")
      );
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
