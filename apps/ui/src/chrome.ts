/**
 * The project chrome: the frame around the drawing engine.
 *
 * The engine brings its own toolbar, panels and markup list. What it does not have — because it is
 * a library and has no opinion about where documents come from — is a project. This module is that
 * shell: which project is open, which drawings are in it, which one is on screen, and one status
 * line that says what just happened.
 *
 * Built with plain DOM rather than a framework. The interface has one screen and perhaps twenty
 * interactive elements; a framework here would add a dependency, a build step and a render model
 * to a surface that is smaller than the engine's own toolbar.
 *
 * Keyboard access is not decoration: a reviewer works a set with one hand on the keyboard. Every
 * control is a real `<button>`, the drawing list is a single tab stop with arrow-key navigation,
 * and the status line is a live region so a change is announced rather than merely displayed.
 */

import type { AppInfo, ProjectSummary, RevisionSummary } from "./bridge";

/** What `main` needs from the chrome once it is mounted. */
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
  /** Show whether work is saved, being saved, or failed to save. */
  setSaveState(state: "saved" | "saving" | "error", detail?: string): void;
  askForProjectName(): string | undefined;
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
  onCreateProject: () => void;
  onOpenProject: () => void;
  onImport: () => void;
  onSelectRevision: (revision: RevisionSummary) => void;
  onVerify: () => void;
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

/** Build the chrome into `root` and return the handle to drive it. */
export function mountChrome(root: HTMLElement, handlers: ChromeHandlers): Chrome {
  root.replaceChildren();
  root.classList.add("sf-root");

  const header = element("header", { class: "sf-header" });
  const title = element("h1", { class: "sf-title" }, "SheetForge");
  const projectName = element("span", { class: "sf-project", "data-project": "" }, "No project open");

  const actions = element("div", { class: "sf-actions", role: "toolbar", "aria-label": "Project" });
  // Opening a drawing is what someone launched this to do, so it is first, it is emphasised, and
  // it needs nothing set up beforehand. Project management sits behind it for the people who want
  // it, rather than in front of everyone who does not.
  actions.append(
    button("Open PDF…", handlers.onOpenPdf, "Open a drawing. A project is created for it automatically", true),
    button("Add drawings", handlers.onImport, "Add more PDFs to the project that is open"),
    button("Open project", handlers.onOpenProject, "Open a project folder you saved earlier"),
    button("New project", handlers.onCreateProject, "Create an empty project in a location you choose"),
    button("Check integrity", handlers.onVerify, "Re-hash every drawing and verify the audit trail"),
  );
  header.append(title, projectName, actions);

  const sidebar = element("nav", { class: "sf-sidebar", "aria-label": "Drawings" });
  const sheetsHeading = element("h2", { class: "sf-sidebar-heading", id: "sf-sheets-heading" }, "Drawings");
  // One tab stop for the whole list, arrow keys within it — the pattern a long sheet index needs,
  // and the one the engine's own lists use, so the two behave alike.
  const list = element("ul", {
    class: "sf-sheets",
    role: "listbox",
    tabindex: "0",
    "aria-labelledby": "sf-sheets-heading",
  });
  sidebar.append(sheetsHeading, list);

  const stage = element("main", { class: "sf-stage", "aria-label": "Drawing" });

  const empty = element("div", { class: "sf-empty" });
  empty.append(
    element("p", { class: "sf-empty-title" }, "No drawing open"),
    element(
      "p",
      { class: "sf-empty-hint" },
      "Open a PDF to start reviewing. SheetForge keeps your markups, scales and measurements in a project folder it creates alongside it.",
    ),
  );
  const emptyAction = element(
    "button",
    { type: "button", class: "sf-action sf-action--primary" },
    "Open PDF…",
  );
  emptyAction.addEventListener("click", handlers.onOpenPdf);
  empty.append(emptyAction);
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
    if (revisions.length === 0) {
      list.append(
        element("li", { class: "sf-sheets-empty", role: "presentation" }, "No drawings yet."),
      );
      return;
    }
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

    clearEmptyState() {
      empty.remove();
    },

    setActiveRevision(revision) {
      activeId = revision.id;
      const index = revisions.findIndex((candidate) => candidate.id === revision.id);
      if (index >= 0) focusIndex = index;
      renderList();
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
  };
}
