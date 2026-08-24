/**
 * The project chrome: the frame around the drawing engine.
 *
 * The engine brings its own toolbar, panels and markup list. What it does not have — because it is
 * a library and has no opinion about where documents come from — is a project. This module is that
 * shell: which project is open, which drawings are in it, which one is on screen, whether the work
 * is saved, and one status line that says what just happened.
 *
 * ## Why so few buttons
 *
 * An earlier version put five equal-weight buttons up here, four of which were project bookkeeping.
 * That is backwards. Opening a drawing and getting the result back out are what somebody came to
 * do; the rest is housekeeping they need occasionally. So the header is three controls — **Open
 * PDF**, **Export**, **Project** — and the last two are menus with words in them.
 *
 * The export menu is built from the engine's own action registry rather than a hand-written list,
 * so an exporter added to the engine appears here without anyone remembering to add it. The engine
 * also offers these as icons in its toolbar, but a glyph among fifty others is discoverable by
 * nobody, which is why they are named here.
 *
 * Built with plain DOM rather than a framework. One screen, perhaps thirty interactive elements; a
 * framework would add a dependency, a build step and a render model to a surface smaller than the
 * engine's own toolbar.
 *
 * Keyboard access is not decoration — a reviewer works a set with one hand on the keyboard. Every
 * control is a real `<button>`, menus follow the usual arrow/Escape/Home/End conventions, the
 * drawing list is a single tab stop with arrow-key navigation, and the status line is a live region.
 */

import type { AppInfo, ProjectSummary, RevisionSummary } from "./bridge";

/** One entry in a menu. */
export interface MenuItem {
  id: string;
  label: string;
  /** Greyed out with a reason, rather than hidden — a menu that changes shape is hard to learn. */
  enabled: boolean;
  /** Why it is unavailable, shown on hover. */
  reason?: string;
  /** Starts a visual group above this item. */
  separatorBefore?: boolean;
}

/** What `main` needs from the chrome once it is mounted. */
/**
 * One entry in a drawing's own table of contents.
 *
 * A construction set exported from Revit or Bluebeam usually carries an outline: disciplines at
 * the top, sheets under them. The engine parses it and, until now, this application threw it away
 * — leaving a reviewer to scroll a flat list of two hundred sheets looking for the mechanical
 * drawings, on a set that already knew where they were.
 */
export interface OutlineEntry {
  title: string;
  /** Nesting level, 0 for a top-level entry. */
  depth: number;
  /** Where it points, when the PDF resolved the destination. Entries without one are headings. */
  page?: number;
}

export interface Chrome {
  /** Where the drawing engine mounts. */
  readonly stage: HTMLElement;
  /** Who markups are attributed to. */
  readonly actor: string;
  setProject(project: ProjectSummary): void;
  setRevisions(revisions: RevisionSummary[]): void;
  setActiveRevision(revision: RevisionSummary): void;
  /** Remove the "no drawing open" placeholder before the viewer mounts. */
  clearEmptyState(): void;
  setStatus(message: string): void;
  /**
   * The open drawing's own table of contents, or an empty list to hide it.
   *
   * Called on every document change, including with `[]`, because a set that has one and a set
   * that does not must not leave each other's contents on screen.
   */
  setOutline(entries: readonly OutlineEntry[]): void;
  /** Show whether work is saved, being saved, or failed to save. */
  setSaveState(state: "saved" | "saving" | "error", detail?: string): void;
  askForProjectName(): string | undefined;
  /**
   * Ask for the status a drawing is being issued under.
   *
   * Offered rather than assumed, and with the common answer already filled in: a reviewer
   * exporting a marked-up sheet is overwhelmingly not issuing it for construction, and the one
   * time they are, they should have to type it.
   */
  askForIssueStatus(): string | undefined;
}

/**
 * What the chrome needs from `main`.
 *
 * Declared as properties holding functions rather than as methods, because the chrome detaches
 * them and hands them to `addEventListener`. A method shorthand would carry an implicit `this`
 * that is wrong the moment it is separated from the object.
 */
export interface ChromeHandlers {
  info: AppInfo | undefined;
  onOpenPdf: () => void;
  /** Open the tutorial drawing that ships with the application. */
  onTutorial: () => void;
  onCreateProject: () => void;
  onOpenProject: () => void;
  onImport: () => void;
  onSelectRevision: (revision: RevisionSummary) => void;
  /** Jump to a page named by the drawing's own outline. */
  onSelectOutline: (page: number) => void;
  onVerify: () => void;
  onDiagnostics: () => void;
  /**
   * The export and import actions the engine currently offers, read when the menu opens so that
   * "enabled" reflects the document actually on screen rather than the one that was there when the
   * chrome was built.
   */
  exportItems: () => MenuItem[];
  onExport: (id: string) => void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(
  label: string,
  onClick: () => void,
  hint: string,
  primary = false,
): HTMLButtonElement {
  const node = element(
    "button",
    { type: "button", class: primary ? "sf-action sf-action--primary" : "sf-action", title: hint },
    label,
  );
  node.addEventListener("click", onClick);
  return node;
}

/**
 * A dropdown menu.
 *
 * Hand-rolled rather than a `<select>` or a library: a `<select>` cannot carry disabled items with
 * explanations or separators, and this is about sixty lines. `items()` is called on open rather
 * than at build time, because whether "Export marked-up PDF" is available depends on whether there
 * is anything to export *now*.
 */
function menu(
  label: string,
  hint: string,
  items: () => MenuItem[],
  onChoose: (id: string) => void,
): HTMLElement {
  const wrap = element("div", { class: "sf-menu" });
  const trigger = element(
    "button",
    {
      type: "button",
      class: "sf-action sf-menu-trigger",
      title: hint,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    },
    label,
  );
  const list = element("div", { class: "sf-menu-list", role: "menu", hidden: "" });
  wrap.append(trigger, list);

  let entries: HTMLButtonElement[] = [];

  const close = (returnFocus = false): void => {
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger.focus();
  };

  const open = (): void => {
    list.replaceChildren();
    entries = [];
    const current = items();
    if (current.length === 0) {
      list.append(element("p", { class: "sf-menu-empty" }, "Open a drawing first."));
    }
    for (const item of current) {
      if (item.separatorBefore) list.append(element("hr", { class: "sf-menu-sep" }));
      const entry = element(
        "button",
        {
          type: "button",
          class: "sf-menu-item",
          role: "menuitem",
          ...(item.enabled ? {} : { disabled: "", title: item.reason ?? "Not available yet" }),
        },
        item.label,
      );
      if (item.enabled) {
        entry.addEventListener("click", () => {
          close();
          onChoose(item.id);
        });
        entries.push(entry);
      }
      list.append(entry);
    }
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    entries[0]?.focus();
  };

  trigger.addEventListener("click", () => (list.hidden ? open() : close()));

  wrap.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !list.hidden) {
      event.preventDefault();
      close(true);
      return;
    }
    if (list.hidden) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        open();
      }
      return;
    }
    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    const move: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: entries.length - 1,
    };
    const next = move[event.key];
    if (next !== undefined && entries.length > 0) {
      event.preventDefault();
      entries[Math.min(Math.max(next, 0), entries.length - 1)]?.focus();
    }
  });

  // Clicking elsewhere or tabbing out dismisses it — the behaviour every menu has, and whose
  // absence is immediately noticeable.
  document.addEventListener("click", (event) => {
    if (!list.hidden && !wrap.contains(event.target as Node)) close();
  });
  wrap.addEventListener("focusout", (event) => {
    if (!wrap.contains(event.relatedTarget as Node)) close();
  });

  return wrap;
}

/** Build the chrome into `root` and return the handle to drive it. */
export function mountChrome(root: HTMLElement, handlers: ChromeHandlers): Chrome {
  root.replaceChildren();
  root.classList.add("sf-root");

  const header = element("header", { class: "sf-header" });
  const title = element("h1", { class: "sf-title" }, "SheetForge");
  const projectName = element("span", { class: "sf-project", "data-project": "" }, "No project open");

  const actions = element("div", { class: "sf-actions", role: "toolbar", "aria-label": "Project" });
  actions.append(
    button(
      "Open PDF…",
      handlers.onOpenPdf,
      "Open a drawing. A project is created for it automatically",
      true,
    ),
    menu(
      "Export ▾",
      "Get the markups, the takeoff or the marked-up drawing back out",
      handlers.exportItems,
      handlers.onExport,
    ),
    menu(
      "Project ▾",
      "Add drawings, switch project, or check this one",
      () => [
        { id: "import", label: "Add drawings…", enabled: true },
        { id: "open", label: "Open project…", enabled: true, separatorBefore: true },
        { id: "new", label: "New project…", enabled: true },
        { id: "verify", label: "Check integrity", enabled: true, separatorBefore: true },
        { id: "diagnostics", label: "Save diagnostic report…", enabled: true },
        // Findable again after the first run. Somebody who wants to try a tool without risking a
        // live drawing should not have to reinstall to get the practice sheet back.
        { id: "tutorial", label: "Open the tutorial sheet", enabled: true, separatorBefore: true },
      ],
      (id) => {
        if (id === "import") handlers.onImport();
        else if (id === "open") handlers.onOpenProject();
        else if (id === "new") handlers.onCreateProject();
        else if (id === "verify") handlers.onVerify();
        else if (id === "tutorial") handlers.onTutorial();
        else handlers.onDiagnostics();
      },
    ),
  );
  header.append(title, projectName, actions);

  const sidebar = element("nav", { class: "sf-sidebar", "aria-label": "Drawings" });
  const sheetsHeading = element("h2", { class: "sf-sidebar-heading", id: "sf-sheets-heading" }, "Drawings");
  // One tab stop for the whole list, arrow keys within it — the pattern a long sheet index needs,
  // and the one the engine's own lists use, so the two behave alike.
  const list = element("ul", { class: "sf-sheets", "aria-labelledby": "sf-sheets-heading" });
  // The empty message lives outside the list, not inside it. A `listbox` whose only child is a
  // presentational element is an accessibility error — `aria-required-children` — and a screen
  // reader announces a list of options containing nothing selectable. Found by the axe suite.
  const sheetsEmpty = element("p", { class: "sf-sheets-empty" }, "No drawings yet.");
  sidebar.append(sheetsHeading, list, sheetsEmpty);

  // The drawing's own contents, below the drawings. Hidden entirely when the open document has no
  // outline, which is most single-sheet PDFs: an empty heading is furniture that says nothing.
  const outlineSection = element("section", { class: "sf-outline", hidden: "" });
  const outlineHeading = element(
    "h2",
    { class: "sf-sidebar-heading", id: "sf-outline-heading" },
    "In this drawing",
  );
  const outlineList = element("ul", {
    class: "sf-outline-list",
    "aria-labelledby": "sf-outline-heading",
  });
  outlineSection.append(outlineHeading, outlineList);
  sidebar.append(outlineSection);

  const stage = element("main", { class: "sf-stage", "aria-label": "Drawing" });

  const empty = element("div", { class: "sf-empty" });
  empty.append(
    element("p", { class: "sf-empty-title" }, "No drawing open"),
    element(
      "p",
      { class: "sf-empty-hint" },
      "Open a PDF — or drop one on this window — to start reviewing. SheetForge keeps your markups, scales and measurements in a project folder it creates alongside it.",
    ),
  );
  const emptyAction = element(
    "button",
    { type: "button", class: "sf-action sf-action--primary" },
    "Open PDF…",
  );
  emptyAction.addEventListener("click", handlers.onOpenPdf);

  // The second way out of an empty screen, for the reviewer who has not got a drawing to hand.
  // Offering only "Open PDF…" makes trying the tool conditional on already having something to
  // try it on, which is a poor bargain for somebody deciding whether to bother.
  const tutorialAction = element(
    "button",
    { type: "button", class: "sf-action sf-action--quiet" },
    "Try the tutorial sheet",
  );
  tutorialAction.addEventListener("click", handlers.onTutorial);

  const emptyActions = element("div", { class: "sf-empty-actions" });
  emptyActions.append(emptyAction, tutorialAction);
  empty.append(emptyActions);
  stage.append(empty);

  const status = element("p", {
    class: "sf-status",
    "data-status": "",
    role: "status",
    "aria-live": "polite",
  });

  // Saved state gets its own element rather than being folded into the status line, because the
  // status line is transient — it says what just happened — and this has to be true continuously.
  // It is text, not a coloured dot: "Saved" is legible to somebody who cannot tell green from
  // amber, and it is what an anxious user is actually looking for.
  const saveState = element("span", { class: "sf-save", "aria-live": "polite" }, "");

  const statusBar = element("div", { class: "sf-statusbar" });
  statusBar.append(status, saveState);

  const body = element("div", { class: "sf-body" });
  body.append(sidebar, stage);
  root.append(header, body, statusBar);

  let revisions: RevisionSummary[] = [];
  let activeId: string | undefined;
  let focusIndex = 0;

  function renderList(): void {
    list.replaceChildren();

    // An empty list is not a listbox: there is nothing to choose and nothing to arrow through, so
    // taking a tab stop for it would strand a keyboard user on an empty control.
    if (revisions.length === 0) {
      list.removeAttribute("role");
      list.removeAttribute("tabindex");
      list.removeAttribute("aria-activedescendant");
      sheetsEmpty.hidden = false;
      return;
    }
    list.setAttribute("role", "listbox");
    list.setAttribute("tabindex", "0");
    sheetsEmpty.hidden = true;
    revisions.forEach((revision, index) => {
      const selected = revision.id === activeId;
      const item = element("li", {
        class: selected ? "sf-sheet sf-sheet--active" : "sf-sheet",
        role: "option",
        id: `sf-sheet-${revision.id}`,
        "aria-selected": selected ? "true" : "false",
      });
      const label = revision.revisionLabel ? `${revision.name} · rev ${revision.revisionLabel}` : revision.name;
      item.append(element("span", { class: "sf-sheet-name" }, label));
      item.append(
        element(
          "span",
          { class: "sf-sheet-meta" },
          `${revision.pageCount} page${revision.pageCount === 1 ? "" : "s"} · ${revision.shortHash}`,
        ),
      );
      item.addEventListener("click", () => {
        focusIndex = index;
        handlers.onSelectRevision(revision);
      });
      list.append(item);
    });
    const focused = revisions[focusIndex];
    if (focused) list.setAttribute("aria-activedescendant", `sf-sheet-${focused.id}`);
  }

  list.addEventListener("keydown", (event) => {
    if (revisions.length === 0) return;
    const keys: Record<string, number> = {
      ArrowDown: focusIndex + 1,
      ArrowUp: focusIndex - 1,
      Home: 0,
      End: revisions.length - 1,
    };
    const next = keys[event.key];
    if (next !== undefined) {
      event.preventDefault();
      focusIndex = Math.min(Math.max(next, 0), revisions.length - 1);
      renderList();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const revision = revisions[focusIndex];
      if (revision) handlers.onSelectRevision(revision);
    }
  });

  renderList();

  return {
    stage,
    actor: handlers.info?.actor ?? "Local user",

    setProject(project) {
      projectName.textContent = project.jobNumber
        ? `${project.name} · ${project.jobNumber}`
        : project.name;
      // The document title is what the OS window list and the taskbar show; a reviewer with four
      // jobs open needs to tell them apart from the taskbar.
      document.title = `${project.name} — SheetForge`;
    },

    setRevisions(next) {
      revisions = next;
      focusIndex = 0;
      renderList();
    },

    setOutline(entries) {
      outlineList.replaceChildren();
      outlineSection.hidden = entries.length === 0;
      if (entries.length === 0) return;

      for (const entry of entries) {
        const item = element("li");
        // Indentation is a style, so the nesting is also stated to assistive technology rather
        // than implied by a margin nobody can hear.
        item.style.setProperty("--depth", String(Math.min(entry.depth, 5)));

        if (entry.page === undefined) {
          // A heading with no destination. Not a button: pressing it could do nothing, and a
          // control that does nothing is worse than text that never claimed it would.
          item.append(element("span", { class: "sf-outline-heading" }, entry.title));
        } else {
          const page = entry.page;
          const button = element(
            "button",
            { type: "button", class: "sf-outline-link" },
            entry.title,
          );
          // The page number is announced as part of the name rather than shown beside it, so a
          // screen-reader user gets the same information a sighted one reads from the layout.
          button.setAttribute("aria-label", `${entry.title}, page ${page}`);
          button.addEventListener("click", () => handlers.onSelectOutline(page));
          item.append(button);
        }
        outlineList.append(item);
      }
    },

    setActiveRevision(revision) {
      activeId = revision.id;
      const index = revisions.findIndex((candidate) => candidate.id === revision.id);
      if (index >= 0) focusIndex = index;
      renderList();
    },

    clearEmptyState() {
      empty.remove();
    },

    setStatus(message) {
      status.textContent = message;
    },

    setSaveState(state, detail) {
      const label = {
        saved: "All changes saved",
        saving: "Saving…",
        error: "Not saved",
      }[state];
      saveState.textContent = detail ? `${label} — ${detail}` : label;
      saveState.dataset["state"] = state;
      // A failure to save is the one thing here that must interrupt rather than sit quietly in a
      // corner, because the user is about to close the window believing their work is kept.
      saveState.setAttribute("role", state === "error" ? "alert" : "status");
    },

    askForProjectName() {
      // A native prompt, deliberately. A custom modal here would need its own focus trap, its own
      // escape handling and its own screen-reader semantics to be as good as the one the platform
      // already ships, and it is asking for exactly one string.
      const name = window.prompt("Project name", "New project");
      return name?.trim() ? name.trim() : undefined;
    },

    askForIssueStatus() {
      const status = window.prompt(
        "Stamp this export with an issue status:",
        "NOT FOR CONSTRUCTION",
      );
      return status?.trim() ? status.trim() : undefined;
    },
  };
}
