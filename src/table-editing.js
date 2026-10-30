// ---------- Table editing ----------
// Commands for GFM tables (tables whose rows start with "|"), built on
// md-advanced-tables. Tab / Shift+Tab move between cells and Enter moves to the
// next row; each keeps the table's columns aligned. Right-clicking a table
// opens a menu for inserting, deleting, moving, aligning and sorting.

import { ChangeSet, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import {
  Alignment,
  Point,
  SortOrder,
  TableCell,
  TableEditor,
  TableRow,
  insertColumn,
  insertRow,
  optionsWithDefaults,
} from "@tgrosinger/md-advanced-tables";

const options = optionsWithDefaults({ smartCursor: true });

/**
 * md-advanced-tables' ITextEditor over a CodeMirror view. Edits made during one
 * command are applied to a working state and dispatched as a single
 * transaction, so each command is one undo step.
 */
class CodeMirrorTextEditor {
  begin(view) {
    this.view = view;
    this.state = view.state;
    this.changes = ChangeSet.empty(this.state.doc.length);
  }

  finish() {
    if (this.changes.empty && this.state.selection.eq(this.view.state.selection)) return;
    this.view.dispatch({
      changes: this.changes,
      selection: this.state.selection,
      scrollIntoView: true,
      userEvent: "input.table",
    });
  }

  apply(spec) {
    const tr = this.state.update(spec);
    this.changes = this.changes.compose(tr.changes);
    this.state = tr.state;
  }

  line(row) {
    return this.state.doc.line(row + 1);
  }

  pos(point) {
    const line = this.line(point.row);
    return line.from + Math.min(point.column, line.length);
  }

  getCursorPosition() {
    const head = this.state.selection.main.head;
    const line = this.state.doc.lineAt(head);
    return new Point(line.number - 1, head - line.from);
  }

  setCursorPosition(point) {
    this.apply({ selection: { anchor: this.pos(point) } });
  }

  setSelectionRange(range) {
    this.apply({ selection: { anchor: this.pos(range.start), head: this.pos(range.end) } });
  }

  getLastRow() {
    return this.state.doc.lines - 1;
  }

  acceptsTableEdit(row) {
    for (let node = syntaxTree(this.state).resolveInner(this.line(row).from, 1); node; node = node.parent) {
      if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "HTMLBlock") return false;
    }
    return true;
  }

  getLine(row) {
    return this.line(row).text;
  }

  insertLine(row, text) {
    if (row > this.getLastRow()) {
      this.apply({ changes: { from: this.state.doc.length, insert: `\n${text}` } });
    } else {
      this.apply({ changes: { from: this.line(row).from, insert: `${text}\n` } });
    }
  }

  deleteLine(row) {
    const line = this.line(row);
    if (this.state.doc.lines === 1) this.apply({ changes: { from: 0, to: line.to } });
    else if (row === this.getLastRow()) this.apply({ changes: { from: line.from - 1, to: line.to } });
    else this.apply({ changes: { from: line.from, to: line.to + 1 } });
  }

  replaceLines(startRow, endRow, lines) {
    if (endRow <= startRow) {
      lines.forEach((text, i) => this.insertLine(startRow + i, text));
      return;
    }
    const from = this.line(startRow).from;
    const to = this.line(endRow - 1).to;
    this.apply({ changes: { from, to, insert: lines.join("\n") } });
  }

  transact(func) {
    func();
  }
}

const textEditor = new CodeMirrorTextEditor();
const tableEditor = new TableEditor(textEditor);

/** Runs `fn(tableEditor)` against `view` as one transaction. */
function runTableEdit(view, fn) {
  textEditor.begin(view);
  fn(tableEditor);
  textEditor.finish();
}

function cursorInTable(view) {
  textEditor.begin(view);
  return tableEditor.cursorIsInTable(options);
}

/** A command that runs `fn` when the cursor is in a table, and otherwise does nothing. */
function tableCommand(fn) {
  return (view) => {
    if (!cursorInTable(view)) return false;
    runTableEdit(view, fn);
    return true;
  };
}

function emptyRow(table) {
  return new TableRow(new Array(table.getHeaderWidth()).fill(new TableCell("")), "", "");
}

const insertRowBelow = (te) =>
  te.withCompletedTable(options, ({ range, lines, formulaLines, table, focus }) => {
    const row = Math.max(focus.row, 1) + 1;
    const altered = insertRow(table, row, emptyRow(table));
    te.formatAndApply(options, range, lines, formulaLines, altered, focus.setRow(row).setColumn(0).setOffset(0));
  });

const insertColumnRight = (te) =>
  te.withCompletedTable(options, ({ range, lines, formulaLines, table, focus }) => {
    const width = table.getHeaderWidth();
    const column = Math.min(Math.max(focus.column + 1, 0), width);
    const cells = new Array(table.getHeight() - 1).fill(new TableCell(""));
    const altered = insertColumn(table, column, cells, options);
    const row = focus.row === 1 ? 0 : focus.row;
    te.formatAndApply(options, range, lines, formulaLines, altered, focus.setRow(row).setColumn(column).setOffset(0));
  });

/**
 * Enter moves to the next row, adding one at the end of the table. Enter on an
 * empty last row removes it and leaves the table. At the start of a line Enter
 * behaves as usual, so a line can still be opened above a table.
 */
function tableEnter(view) {
  const { head, empty } = view.state.selection.main;
  if ((empty && head === view.state.doc.lineAt(head).from) || !cursorInTable(view)) return false;
  let leave = false;
  tableEditor.withCompletedTable(options, ({ table, focus }) => {
    const isLastRow = focus.row >= 2 && focus.row === table.getHeight() - 1;
    leave = isLastRow && table.getRows()[focus.row].getCells().every((cell) => cell.content === "");
  });
  runTableEdit(view, (te) => {
    if (leave) {
      te.deleteRow(options);
      te.escape(options);
    } else {
      te.nextRow(options);
    }
  });
  return true;
}

/** Inserts an empty two-column table on its own lines, with the cursor in the first header cell. */
export function insertTable(view) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const table = ["|  |  |", "| --- | --- |", "|  |  |"].join("\n");
  const atEmptyLine = line.text.trim() === "";
  const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const before = !atEmptyLine ? "\n\n" : prev && prev.text.trim() !== "" ? "\n" : "";
  const from = atEmptyLine ? line.from : line.to;
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const after = next && next.text.trim() !== "" ? "\n" : "";
  view.dispatch({
    changes: { from, to: line.to, insert: before + table + after },
    selection: { anchor: from + before.length + 2 },
    scrollIntoView: true,
    userEvent: "input.table",
  });
  runTableEdit(view, (te) => te.format(options));
  view.focus();
  return true;
}

// ---------- Context menu ----------

const isMac = /Mac/.test(navigator.platform);
const altKey = isMac ? "⌥" : "Alt+";
const moveColumnKey = isMac ? "⌃⌥" : "Alt+";

const MENU = [
  { label: "Insert row above", run: (te) => te.insertRow(options), bodyRow: true },
  { label: "Insert row below", run: insertRowBelow },
  { label: "Delete row", run: (te) => te.deleteRow(options), bodyRow: true },
  null,
  { label: "Insert column left", run: (te) => te.insertColumn(options) },
  { label: "Insert column right", run: insertColumnRight },
  { label: "Delete column", run: (te) => te.deleteColumn(options) },
  null,
  { label: "Move row up", run: (te) => te.moveRow(-1, options), key: `${altKey}↑`, bodyRow: true },
  { label: "Move row down", run: (te) => te.moveRow(1, options), key: `${altKey}↓`, bodyRow: true },
  { label: "Move column left", run: (te) => te.moveColumn(-1, options), key: `${moveColumnKey}←` },
  { label: "Move column right", run: (te) => te.moveColumn(1, options), key: `${moveColumnKey}→` },
  null,
  { label: "Align column left", run: (te) => te.alignColumn(Alignment.LEFT, options) },
  { label: "Align column center", run: (te) => te.alignColumn(Alignment.CENTER, options) },
  { label: "Align column right", run: (te) => te.alignColumn(Alignment.RIGHT, options) },
  null,
  { label: "Sort rows A → Z", run: (te) => te.sortRows(SortOrder.Ascending, options) },
  { label: "Sort rows Z → A", run: (te) => te.sortRows(SortOrder.Descending, options) },
  { label: "Format table", run: (te) => te.format(options) },
];

let openMenu = null;

function closeTableMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  window.removeEventListener("mousedown", onOutsideMouseDown, true);
  window.removeEventListener("keydown", onMenuKeyDown, true);
  window.removeEventListener("blur", closeTableMenu);
  window.removeEventListener("resize", closeTableMenu);
}

function onOutsideMouseDown(e) {
  if (!openMenu?.contains(e.target)) closeTableMenu();
}

function onMenuKeyDown(e) {
  if (e.key === "Escape") {
    closeTableMenu();
    e.preventDefault();
    e.stopPropagation();
  }
}

/**
 * Shows the table menu at (x, y) if the cursor is in a table. Returns false
 * (and shows nothing) otherwise.
 */
export function showTableMenu(view, x, y) {
  closeTableMenu();
  if (!cursorInTable(view)) return false;
  let inHeader = false;
  tableEditor.withCompletedTable(options, ({ focus }) => (inHeader = focus.row < 2));

  const menu = document.createElement("div");
  menu.className = "table-menu";
  for (const item of MENU) {
    if (!item) {
      menu.append(Object.assign(document.createElement("div"), { className: "table-menu-sep" }));
      continue;
    }
    const button = document.createElement("button");
    button.disabled = item.bodyRow && inHeader; // the header row can't be moved or deleted
    button.append(Object.assign(document.createElement("span"), { textContent: item.label }));
    if (item.key) {
      button.append(Object.assign(document.createElement("span"), { className: "table-menu-key", textContent: item.key }));
    }
    button.addEventListener("click", () => {
      closeTableMenu();
      runTableEdit(view, item.run);
      view.focus();
    });
    menu.append(button);
  }
  document.body.append(menu);

  // Keep the menu inside the window.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height - 4))}px`;

  openMenu = menu;
  window.addEventListener("mousedown", onOutsideMouseDown, true);
  window.addEventListener("keydown", onMenuKeyDown, true);
  window.addEventListener("blur", closeTableMenu);
  window.addEventListener("resize", closeTableMenu);
  return true;
}

// ---------- Extension ----------

export const tableEditing = [
  Prec.high(
    keymap.of([
      { key: "Tab", run: tableCommand((te) => te.nextCell(options)) },
      { key: "Shift-Tab", run: tableCommand((te) => te.previousCell(options)) },
      { key: "Enter", run: tableEnter },
      { key: "Alt-ArrowUp", run: tableCommand((te) => te.moveRow(-1, options)) },
      { key: "Alt-ArrowDown", run: tableCommand((te) => te.moveRow(1, options)) },
      { key: "Alt-ArrowLeft", mac: "Ctrl-Alt-ArrowLeft", run: tableCommand((te) => te.moveColumn(-1, options)) },
      { key: "Alt-ArrowRight", mac: "Ctrl-Alt-ArrowRight", run: tableCommand((te) => te.moveColumn(1, options)) },
      { key: "Mod-Shift-t", run: insertTable },
    ]),
  ),
  EditorView.domEventHandlers({
    contextmenu(event, view) {
      // Right-clicking outside the selection moves the cursor there first.
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const { from, to } = view.state.selection.main;
      if (pos != null && (pos < from || pos > to)) view.dispatch({ selection: { anchor: pos } });
      if (!showTableMenu(view, event.clientX, event.clientY)) return false;
      event.preventDefault();
      return true;
    },
  }),
];
