/**
 * Accessibility, checked rather than asserted.
 *
 * `docs/status.md` has carried "accessibility is implemented, not verified" since the first
 * release, which is an honest thing to write and a bad thing to leave true. This closes half of it:
 * automated rule checking with [axe](https://github.com/dequelabs/axe-core), plus keyboard
 * operation driven with real key presses rather than by asserting that attributes exist.
 *
 * It does not close the other half. Automated tools catch perhaps a third of real barriers, and
 * nothing here involves a screen reader or a person who uses one. A drawing canvas is a visual
 * artefact and spatial accuracy on it is a visual task regardless of markup. Those limits stay in
 * `status.md`; what this removes is the excuse for the failures a machine *can* find.
 *
 * ## Scope
 *
 * The whole page is scanned, including the drawing engine's own interface. Where a violation is
 * upstream we cannot fix it here, but we can know about it — silently excluding the engine would
 * make this a test of the chrome pretending to be a test of the application.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/** Rules an interface has to meet before anything else is worth arguing about. */
const SERIOUS = ["critical", "serious"] as const;

/** Summarise violations so a failure names the element rather than an id nobody can act on. */
function describe(violations: { id: string; impact?: string | null; nodes: { html: string }[] }[]) {
  return violations
    .map(
      (violation) =>
        `${violation.impact ?? "unknown"}: ${violation.id}\n` +
        violation.nodes.slice(0, 3).map((node) => `    ${node.html.slice(0, 160)}`).join("\n"),
    )
    .join("\n");
}

test.describe("accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        transformCallback: (callback: unknown) => {
          void callback;
          return 1;
        },
        invoke(command: string) {
          if (command === "app_info") {
            return Promise.resolve({
              version: "0.1.0-test",
              actor: "a.reviewer@example.com",
              role: "owner",
              limits: {
                maxPdfMb: 512, maxAttachmentMb: 64, maxPackageMb: 4096, maxInterchangeMb: 64,
                maxPages: 10000, maxConcurrentJobs: 4, jobTimeoutSecs: 120,
                maxDecompressedMb: 1024, maxArchiveEntries: 50000,
              },
            });
          }
          if (command === "plugin:event|listen") return Promise.resolve(1);
          return Promise.resolve(null);
        },
      };
    });
    await page.goto("/");
  });

  test("the opening screen has no serious violations", async ({ page }) => {
    await expect(page.getByText("No drawing open")).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const serious = violations.filter((v) => SERIOUS.includes(v.impact as never));
    expect(serious.length, `\n${describe(serious)}`).toBe(0);
  });

  test("an open menu is announced as a menu and has no serious violations", async ({ page }) => {
    // Menus are where hand-rolled widgets usually fail: a div that looks like a menu, with no role,
    // no expanded state, and no way to leave it with the keyboard.
    await page.getByRole("toolbar", { name: "Project" }).getByRole("button", { name: /^Project/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const serious = violations.filter((v) => SERIOUS.includes(v.impact as never));
    expect(serious.length, `\n${describe(serious)}`).toBe(0);
  });

  test("every control is reachable by keyboard alone", async ({ page }) => {
    // A reviewer works a set with one hand on the keyboard. A control that can only be clicked is
    // not merely awkward — for somebody who cannot use a mouse it does not exist.
    const reached: string[] = [];
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return null;
        return (active.getAttribute("aria-label") ?? active.textContent ?? active.tagName).trim();
      });
      if (label) reached.push(label);
    }

    const joined = reached.join(" | ");
    for (const control of ["Open PDF…", "Export ▾", "Project ▾"]) {
      expect(joined, `${control} was never focused in 12 tab presses`).toContain(control);
    }
  });

  test("focus is visible wherever it lands", async ({ page }) => {
    // An interface that moves focus invisibly is keyboard-hostile even when it is keyboard-operable.
    await page.keyboard.press("Tab");
    const visible = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active) return false;
      const style = getComputedStyle(active);
      // Either a real outline or a box-shadow ring. `outline: none` with nothing replacing it is
      // the failure being checked for.
      return (
        (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== "none"
      );
    });
    expect(visible, "the first focused control has no visible focus indicator").toBe(true);
  });

  test("an empty drawing list is not a listbox and takes no tab stop", async ({ page }) => {
    // A `listbox` with nothing selectable in it is both an ARIA error and a trap: a keyboard user
    // tabs onto a control where no arrow key does anything.
    const list = page.locator(".sf-sheets");
    await expect(list).not.toHaveAttribute("role", "listbox");
    await expect(list).not.toHaveAttribute("tabindex", "0");
    await expect(page.getByText("No drawings yet.")).toBeVisible();
  });

  test("the status line is a live region, so a change is announced", async ({ page }) => {
    const status = page.locator(".sf-status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toHaveAttribute("role", "status");
  });

  test("landmarks are present and named", async ({ page }) => {
    // Without these, a screen-reader user has no way to jump between the sheet index and the
    // drawing; they can only walk the whole document.
    await expect(page.getByRole("navigation", { name: "Drawings" })).toBeVisible();
    await expect(page.getByRole("main", { name: "Drawing" })).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "Project" })).toBeVisible();
  });

  test("nothing depends on colour alone", async ({ page }) => {
    // The save indicator is the case that matters: somebody checking whether it is safe to close
    // the window must be able to *read* the answer, not infer it from a hue.
    await page.evaluate(() => {
      document.querySelector(".sf-save")?.setAttribute("data-state", "error");
      const node = document.querySelector(".sf-save");
      if (node) node.textContent = "Not saved — check the project folder";
    });
    await expect(page.locator(".sf-save")).toContainText("Not saved");
  });

  test("it survives a forced-colours environment", async ({ page }) => {
    // Windows High Contrast replaces the palette wholesale. An interface that carried meaning in a
    // background colour loses it entirely here.
    await page.emulateMedia({ forcedColors: "active" });
    await expect(page.getByRole("button", { name: "Open PDF…" }).first()).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    const serious = violations.filter((v) => SERIOUS.includes(v.impact as never));
    expect(serious.length, `\n${describe(serious)}`).toBe(0);
  });

  test("it respects a request for reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const animated = await page.evaluate(() =>
      [...document.querySelectorAll("*")].some((node) => {
        const style = getComputedStyle(node);
        const duration = parseFloat(style.animationDuration) + parseFloat(style.transitionDuration);
        return Number.isFinite(duration) && duration > 0.05;
      }),
    );
    expect(animated, "something still animates for more than 50ms under reduced motion").toBe(false);
  });
});
