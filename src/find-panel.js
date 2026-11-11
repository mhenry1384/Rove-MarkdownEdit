// A find/replace widget in the style of Visual Studio Code: it floats at the
// top right of the editor and is sized to its contents. The replace row is
// hidden until the chevron on the left is clicked or Ctrl+R is pressed.
// "replace" and "replace all" are disabled (and Enter in the replace field does
// nothing) while the replace field is empty.

import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import {
  search,
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  openSearchPanel,
  closeSearchPanel,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  selectMatches,
} from "@codemirror/search";

const MAX_COUNT = 9999; // stop counting matches past this

const ICONS = {
  chevronRight: '<path d="M6 4l4 4-4 4"/>',
  up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  caseSensitive:
    '<text x="8" y="11.5" text-anchor="middle" font-size="9.5" font-weight="600" fill="currentColor" stroke="none">Aa</text>',
  wholeWord:
    '<text x="8" y="9.5" text-anchor="middle" font-size="8.5" font-weight="600" fill="currentColor" stroke="none">ab</text>' +
    '<path d="M2.5 10.5v2.5h11v-2.5"/>',
  regexp:
    '<circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none"/>' +
    '<path d="M11 2.5v7M8 4.25l6 3.5M14 4.25l-6 3.5"/>',
  replace:
    '<rect x="1.5" y="1.5" width="6" height="5" rx="0.5"/>' +
    '<rect x="8.5" y="9.5" width="6" height="5" rx="0.5" fill="currentColor"/>' +
    '<path d="M4.5 8.5v2.5a1.5 1.5 0 0 0 1.5 1.5h1M5.5 11l1.5 1.5L5.5 14"/>',
  replaceAll:
    '<rect x="1.5" y="1.5" width="5" height="4" rx="0.5"/>' +
    '<rect x="1.5" y="7" width="5" height="4" rx="0.5"/>' +
    '<rect x="9.5" y="10.5" width="5" height="4" rx="0.5" fill="currentColor"/>' +
    '<path d="M8.5 3.5h2.5a1.5 1.5 0 0 1 1.5 1.5v4M11 7.5l1.5 1.5L14 7.5"/>',
};

function icon(name) {
  return (
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    ICONS[name] +
    "</svg>"
  );
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function iconButton(name, iconName, title, onclick) {
  return el("button", {
    type: "button",
    class: "cm-find-button",
    name,
    title,
    "aria-label": title,
    html: icon(iconName),
    // Keep focus in the text field when a button is clicked.
    onmousedown: (e) => e.preventDefault(),
    onclick,
  });
}

const panels = new WeakMap(); // view -> open FindPanel

class FindPanel {
  constructor(view) {
    this.view = view;
    this.query = getSearchQuery(view.state);
    this.expanded = false;
    const commit = () => this.commit();

    this.searchField = el("input", {
      class: "cm-textfield",
      name: "search",
      placeholder: "Find",
      "aria-label": "Find",
      "main-field": "true", // openSearchPanel focuses the field with this attribute
      spellcheck: "false",
      autocomplete: "off",
      oninput: commit,
      onchange: commit,
    });
    this.replaceField = el("input", {
      class: "cm-textfield",
      name: "replace",
      placeholder: "Replace",
      "aria-label": "Replace",
      spellcheck: "false",
      autocomplete: "off",
      oninput: () => {
        commit();
        this.syncReplaceButtons();
      },
      onchange: commit,
    });

    const option = (name, iconName, title) => {
      const button = iconButton(name, iconName, title, () => {
        button.setAttribute("aria-checked", String(button.getAttribute("aria-checked") !== "true"));
        commit();
      });
      button.classList.add("cm-find-option");
      button.setAttribute("role", "checkbox");
      return button;
    };
    this.caseOption = option("case", "caseSensitive", "Match Case");
    this.wordOption = option("word", "wholeWord", "Match Whole Word");
    this.reOption = option("re", "regexp", "Use Regular Expression");

    this.count = el("div", { class: "cm-find-count", "aria-live": "polite" });
    this.toggle = iconButton("toggle", "chevronRight", "Toggle Replace (Ctrl+R)", () =>
      this.setExpanded(!this.expanded, true),
    );
    this.replaceButton = iconButton("replace", "replace", "Replace (Enter)", () => replaceNext(view));
    this.replaceAllButton = iconButton("replaceAll", "replaceAll", "Replace All (Ctrl+Alt+Enter)", () =>
      replaceAll(view),
    );

    // The row slides open: the wrapper's grid row animates between 0fr and 1fr.
    this.replaceRow = el("div", { class: "cm-find-replace" }, [
      el("div", { class: "cm-find-replace-clip" }, [
        el("div", { class: "cm-find-row" }, [
          el("div", { class: "cm-find-input" }, [this.replaceField]),
          this.replaceButton,
          this.replaceAllButton,
        ]),
      ]),
    ]);

    // Not "cm-search": CodeMirror's base theme for that class pins the close
    // button to the corner and adds margins to every button.
    this.dom = el("div", { class: "cm-find", onkeydown: (e) => this.keydown(e) }, [
      ...(view.state.readOnly ? [] : [this.toggle]),
      el("div", { class: "cm-find-rows" }, [
        el("div", { class: "cm-find-row" }, [
          el("div", { class: "cm-find-input" }, [this.searchField, this.caseOption, this.wordOption, this.reOption]),
          this.count,
          iconButton("prev", "up", "Previous Match (Shift+Enter)", () => findPrevious(view)),
          iconButton("next", "down", "Next Match (Enter)", () => findNext(view)),
          iconButton("close", "close", "Close (Escape)", () => closeSearchPanel(view)),
        ]),
        this.replaceRow,
      ]),
    ]);

    this.setQuery(this.query);
    this.setExpanded(false);
    panels.set(view, this);
  }

  commit() {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseOption.getAttribute("aria-checked") === "true",
      regexp: this.reOption.getAttribute("aria-checked") === "true",
      wholeWord: this.wordOption.getAttribute("aria-checked") === "true",
      replace: this.replaceField.value,
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }

  setQuery(query) {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseOption.setAttribute("aria-checked", String(query.caseSensitive));
    this.reOption.setAttribute("aria-checked", String(query.regexp));
    this.wordOption.setAttribute("aria-checked", String(query.wholeWord));
    this.syncReplaceButtons();
    this.updateCount();
  }

  setExpanded(expanded, focus = false) {
    if (this.view.state.readOnly) expanded = false;
    this.expanded = expanded;
    this.dom.classList.toggle("cm-find-expanded", expanded);
    this.replaceRow.inert = !expanded; // keep Tab out of the hidden row
    this.toggle.setAttribute("aria-expanded", String(expanded));
    if (!focus) return;
    const field = expanded && this.searchField.value !== "" ? this.replaceField : this.searchField;
    field.focus();
    field.select();
  }

  syncReplaceButtons() {
    const empty = this.replaceField.value === "";
    this.replaceButton.disabled = empty;
    this.replaceAllButton.disabled = empty;
  }

  updateCount() {
    const { state } = this.view;
    const query = this.query;
    this.searchField.classList.toggle("cm-find-invalid", query.search !== "" && !query.valid);
    this.dom.classList.toggle("cm-find-none", false);
    if (!query.search) {
      this.count.textContent = "No results";
      return;
    }
    if (!query.valid) {
      this.count.textContent = "Invalid";
      return;
    }
    const sel = state.selection.main;
    let total = 0;
    let current = 0;
    const cursor = query.getCursor(state);
    for (let match = cursor.next(); !match.done; match = cursor.next()) {
      total++;
      if (match.value.from === sel.from && match.value.to === sel.to) current = total;
      if (total > MAX_COUNT) break;
    }
    if (total === 0) this.count.textContent = "No results";
    else if (total > MAX_COUNT) this.count.textContent = current ? `${current} of ${MAX_COUNT}+` : `${MAX_COUNT}+`;
    else this.count.textContent = current ? `${current} of ${total}` : `${total} found`;
    this.dom.classList.toggle("cm-find-none", total === 0);
  }

  keydown(e) {
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
    } else if (e.key === "Enter" && e.target === this.searchField) {
      e.preventDefault();
      if (e.altKey) selectMatches(this.view);
      else (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === "Enter" && e.target === this.replaceField) {
      e.preventDefault();
      if (this.replaceField.value === "") return;
      if ((e.ctrlKey || e.metaKey) && e.altKey) replaceAll(this.view);
      else replaceNext(this.view);
    }
  }

  update(update) {
    let queryChanged = false;
    for (const tr of update.transactions)
      for (const effect of tr.effects)
        if (effect.is(setSearchQuery)) {
          queryChanged = true;
          if (!effect.value.eq(this.query)) this.setQuery(effect.value);
        }
    if (queryChanged || update.docChanged || update.selectionSet) this.updateCount();
  }

  mount() {
    this.searchField.select();
  }

  destroy() {
    if (panels.get(this.view) === this) panels.delete(this.view);
  }

  get top() {
    return true;
  }
}

/** Opens the find widget with the replace row showing. */
export function openReplacePanel(view) {
  openSearchPanel(view);
  panels.get(view)?.setExpanded(true, true);
  return true;
}

const theme = EditorView.theme({
  // Float the panel at the top right instead of spanning the editor.
  "& .cm-panels.cm-panels-top": {
    position: "absolute",
    top: "0",
    left: "auto",
    right: "20px", // clear of the vertical scrollbar
    border: "none",
    backgroundColor: "transparent",
  },
  ".cm-panel.cm-find": {
    display: "flex",
    gap: "2px",
    padding: "4px 6px 4px 2px",
    fontFamily: "var(--ui)",
    fontSize: "13px",
    color: "var(--fg)",
    backgroundColor: "var(--sidebar-bg)",
    border: "1px solid var(--border)",
    borderTop: "none",
    borderRadius: "0 0 4px 4px",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.24)",
  },
  ".cm-find-rows": { display: "flex", flexDirection: "column" },
  ".cm-find-row": { display: "flex", alignItems: "center", gap: "2px" },
  ".cm-find-replace": {
    display: "grid",
    gridTemplateRows: "0fr",
    transition: "grid-template-rows 120ms ease-out",
  },
  ".cm-find-expanded .cm-find-replace": { gridTemplateRows: "1fr" },
  ".cm-find-replace-clip": { overflow: "hidden", minHeight: "0" },
  ".cm-find-replace-clip > .cm-find-row": { paddingTop: "4px" },
  ".cm-find-button[name=toggle] svg": { transition: "transform 120ms ease-out" },
  ".cm-find-expanded .cm-find-button[name=toggle] svg": { transform: "rotate(90deg)" },
  "@media (prefers-reduced-motion: reduce)": {
    ".cm-find-replace, .cm-find-button[name=toggle] svg": { transition: "none" },
  },
  ".cm-find-input": {
    display: "flex",
    alignItems: "center",
    width: "260px",
    height: "26px",
    padding: "0 2px 0 0",
    marginRight: "4px",
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "2px",
  },
  ".cm-find-input:focus-within": { borderColor: "var(--accent)" },
  ".cm-find-input .cm-textfield": {
    flex: "1",
    minWidth: "0",
    height: "100%",
    margin: "0",
    padding: "0 6px",
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--fg)",
    fontFamily: "inherit",
    fontSize: "13px",
  },
  ".cm-find-input .cm-textfield.cm-find-invalid": { color: "var(--error)" },
  ".cm-find-button": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    width: "22px",
    height: "22px",
    padding: "0",
    margin: "0",
    border: "1px solid transparent",
    borderRadius: "3px",
    background: "transparent",
    color: "var(--fg)",
    cursor: "pointer",
  },
  ".cm-find-button svg": { display: "block", fontFamily: "var(--ui)" },
  ".cm-find-button:hover:not(:disabled)": { backgroundColor: "var(--hover)" },
  ".cm-find-button:disabled": { opacity: "0.4", cursor: "default" },
  ".cm-find-button:focus-visible": { outline: "1px solid var(--accent)", outlineOffset: "-1px" },
  ".cm-find-option": { width: "20px", height: "20px" },
  ".cm-find-option[aria-checked=true], .cm-find-option[aria-checked=true]:hover": {
    color: "var(--accent)",
    borderColor: "var(--accent)",
    backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
  },
  ".cm-find-button[name=toggle]": { alignSelf: "stretch", height: "auto", width: "18px" },
  ".cm-find-count": {
    minWidth: "72px",
    padding: "0 4px",
    color: "var(--muted)",
    fontSize: "12px",
    whiteSpace: "nowrap",
  },
  ".cm-find-none .cm-find-input:has(input[name=search])": { borderColor: "var(--error)" },
  ".cm-find-none .cm-find-count": { color: "var(--error)" },
});

export const findPanel = [
  search({ top: true, createPanel: (view) => new FindPanel(view) }),
  keymap.of([{ key: "Mod-r", run: openReplacePanel, scope: "editor search-panel", preventDefault: true }]),
  theme,
];
