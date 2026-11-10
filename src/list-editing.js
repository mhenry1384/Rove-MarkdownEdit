// ---------- List editing ----------
// Enter at the end of a list item starts a new item. CodeMirror's Markdown
// keymap does this for most items, but it silently falls back to a plain
// newline when the parser hasn't reached the cursor yet (which happens after an
// edit in a long document), on the wrapped lines of a multi-line item, and when
// a tab follows the marker.
//
// Pasting multi-line text into a list item joins it into one line, so wrapped
// text from elsewhere doesn't break the item apart.
//
// Tab on a list item nests it under the item above; Shift+Tab moves it out one
// level. Its sub-items and continuation lines move with it.

import { Prec, countColumn } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { ensureSyntaxTree, forceParsing, syntaxTree } from "@codemirror/language";

const PARSE_TIMEOUT_MS = 500;
const NOT_ITEM_TEXT = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "Blockquote"]);
const LIST_LINE = /^\s*(?:[-+*]|\d+[.)])\s/;

/** The ListItem whose own text contains pos, or null if pos is in a nested block. */
function listItemAt(state, pos) {
  const tree = ensureSyntaxTree(state, pos, PARSE_TIMEOUT_MS) ?? syntaxTree(state);
  for (let node = tree.resolveInner(pos, -1); node; node = node.parent) {
    if (NOT_ITEM_TEXT.has(node.name)) return null;
    if (node.name === "ListItem") return node;
  }
  return null;
}

/** Changes that keep the numbers after an inserted ordered item consecutive. */
function renumberAfter(item, number, doc) {
  const changes = [];
  let expected = number + 1;
  for (let next = item.nextSibling; next?.name === "ListItem"; next = next.nextSibling) {
    const mark = next.getChild("ListMark");
    const digits = mark && /^\d+/.exec(doc.sliceString(mark.from, mark.to))?.[0];
    if (!digits || +digits !== expected) break;
    expected++;
    changes.push({ from: mark.from, to: mark.from + digits.length, insert: String(expected) });
  }
  return changes;
}

export function listEnter(view) {
  // The Markdown command only sees the finished part of the parse.
  forceParsing(view, view.state.doc.lineAt(view.state.selection.main.head).to, PARSE_TIMEOUT_MS);

  const { state } = view;
  const { doc, selection } = state;
  const { head, empty } = selection.main;
  if (selection.ranges.length > 1 || !empty) return false;
  const line = doc.lineAt(head);
  const end = line.from + line.text.trimEnd().length;
  if (head < end || end === line.from) return false;

  const item = listItemAt(state, end);
  const mark = item?.getChild("ListMark");
  if (!mark) return false;

  const onMarkerLine = mark.from >= line.from;
  const afterMark = doc.sliceString(mark.to, doc.lineAt(mark.to).to);
  if (onMarkerLine) {
    // The Markdown command handles everything here except a tab after the marker.
    if (!afterMark.startsWith("\t") || !afterMark.trim()) return false;
  } else {
    // Only the wrapped lines of the item's first paragraph continue the list.
    const paragraph = item.getChild("Paragraph") ?? item.getChild("Task");
    if (!paragraph || end < paragraph.from || end > paragraph.to) return false;
  }

  const markerLine = doc.lineAt(mark.from);
  const indent = doc.sliceString(markerLine.from, mark.from).replace(/[^\s>]/g, " ");
  const markText = doc.sliceString(mark.from, mark.to);
  const spacing = /^(?: {1,4}\[[ xX]\])?[ \t]*/.exec(afterMark)[0].replace(/[xX]/, " ").replace(/\t/g, " ") || " ";

  const digits = /^\d+/.exec(markText)?.[0];
  const marker = digits ? `${+digits + 1}${markText.slice(digits.length)}` : markText;
  const insert = state.lineBreak + indent + marker + spacing;
  view.dispatch({
    changes: [{ from: end, to: head, insert }, ...(digits ? renumberAfter(item, +digits, doc) : [])],
    selection: { anchor: end + insert.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/**
 * `text` joined into one line if it should be when pasted at the cursor, or
 * null to paste it as usual. Line breaks become a space unless the lines
 * already have whitespace between them. Text that is itself a list keeps its
 * lines, so list items can still be moved around by cut and paste.
 */
export function pastedTextForListItem(state, text) {
  if (!/[\r\n]/.test(text) || state.selection.ranges.length > 1) return null;
  if (text.split(/\r\n?|\n/).some((pasted) => LIST_LINE.test(pasted))) return null;

  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const end = line.from + line.text.trimEnd().length;
  if (end === line.from) return null;
  const mark = listItemAt(state, end)?.getChild("ListMark");
  if (!mark || (mark.from >= line.from && from < mark.to)) return null;

  return text
    .replace(/^[\r\n]+|[\r\n]+$/g, "")
    .replace(/(\S)[\r\n]+(?=\S)/g, "$1 ")
    .replace(/[\r\n]+/g, "");
}

// ---------- Indent / outdent ----------

const column = (state, line, pos) => countColumn(line.text.slice(0, pos - line.from), state.tabSize);

/** Column where a child of `item` has to start: just after its marker and spacing. */
function contentColumn(state, item) {
  const mark = item.getChild("ListMark");
  const line = state.doc.lineAt(mark.from);
  const markEnd = column(state, line, mark.to);
  const ws = /^[ \t]*/.exec(state.doc.sliceString(mark.to, line.to))[0];
  const spacing = column(state, line, mark.to + ws.length) - markEnd;
  return spacing >= 1 && spacing <= 4 ? markEnd + spacing : markEnd + 1;
}

const markColumn = (state, item) => {
  const from = item.getChild("ListMark").from;
  return column(state, state.doc.lineAt(from), from);
};

const markNumber = (state, item) => {
  const mark = item?.getChild("ListMark");
  const digits = mark && /^\d+/.exec(state.doc.sliceString(mark.from, mark.to))?.[0];
  return digits ? +digits : null;
};

const isInBlockquote = (node) => {
  for (let p = node.parent; p; p = p.parent) if (p.name === "Blockquote") return true;
  return false;
};

/** The list items the selection's lines belong to, outermost only, in order. */
function selectedItems(state) {
  const items = new Map();
  const tree = syntaxTree(state);
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(range.to);
    if (first.number !== last.number) {
      tree.iterate({
        from: first.from,
        to: last.to,
        enter(node) {
          if (node.name !== "ListItem") return;
          const mark = node.node.getChild("ListMark");
          if (mark && mark.from >= first.from && mark.from <= last.to) items.set(node.from, node.node);
        },
      });
    }
    if (first.number === last.number || !items.size) {
      const end = first.from + first.text.trimEnd().length;
      const item = end > first.from ? listItemAt(state, end) : null;
      if (item?.getChild("ListMark")) items.set(item.from, item);
    }
  }
  const all = [...items.values()];
  return all
    .filter((item) => !all.some((other) => other !== item && other.from <= item.from && other.to >= item.to))
    .sort((a, b) => a.from - b.from);
}

/** Changes that move every line of `item` by `delta` columns (spaces). */
function shiftItem(state, item, delta) {
  const changes = [];
  const last = state.doc.lineAt(item.to).number;
  for (let n = state.doc.lineAt(item.from).number; n <= last; n++) {
    const line = state.doc.line(n);
    if (!line.text.trim()) continue;
    const ws = /^[ \t]*/.exec(line.text)[0];
    const width = Math.max(0, countColumn(ws, state.tabSize) + delta);
    changes.push({ from: line.from, to: line.from + ws.length, insert: " ".repeat(width) });
  }
  return changes;
}

function renumber(state, item, number) {
  const mark = item.getChild("ListMark");
  const digits = /^\d+/.exec(state.doc.sliceString(mark.from, mark.to))?.[0];
  return digits && +digits !== number ? [{ from: mark.from, to: mark.from + digits.length, insert: String(number) }] : [];
}

function changeListLevel(view, outdent) {
  forceParsing(view, view.state.doc.lineAt(view.state.selection.main.to).to, PARSE_TIMEOUT_MS);
  const { state } = view;
  const items = selectedItems(state).filter((item) => !isInBlockquote(item));
  if (!items.length) return false;

  const selected = new Set(items.map((item) => item.from));
  const renumbered = new Set();
  const changes = [];
  const done = new Map(); // item.from -> { delta, number, next } for items already moved
  for (const item of items) {
    const ordered = markNumber(state, item) !== null;
    const prev = item.prevSibling?.name === "ListItem" ? item.prevSibling : null;
    const prevDone = prev && done.get(prev.from);
    // `next` is the number the old list continues with after the moved items.
    let delta, number, next;
    if (prevDone) {
      // A run of selected siblings moves together, keeping them siblings.
      ({ delta, next } = prevDone);
      number = prevDone.number + 1;
    } else if (outdent) {
      const parent = item.parent?.parent;
      if (parent?.name !== "ListItem") continue;
      delta = markColumn(state, parent) - markColumn(state, item);
      number = (markNumber(state, parent) ?? 0) + 1;
    } else {
      if (!prev) continue; // the first item of a list has nothing to nest under
      delta = contentColumn(state, prev) - markColumn(state, item);
      const sublist = prev.lastChild?.name === "OrderedList" ? prev.lastChild : null;
      number = sublist ? (markNumber(state, sublist.lastChild) ?? 0) + 1 : 1;
      next = (markNumber(state, prev) ?? 0) + 1;
    }
    if ((outdent && delta >= 0) || (!outdent && delta <= 0)) continue;
    done.set(item.from, { delta, number, next });
    changes.push(...shiftItem(state, item, delta), ...(ordered ? renumber(state, item, number) : []));

    // After the last item of a run, keep the following items' numbers consecutive.
    if (!ordered || (item.nextSibling && selected.has(item.nextSibling.from))) continue;
    let follower = outdent ? item.parent.parent.nextSibling : item.nextSibling;
    let expected = outdent ? number + 1 : next;
    for (; follower?.name === "ListItem" && markNumber(state, follower) !== null; follower = follower.nextSibling) {
      if (selected.has(follower.from) || renumbered.has(follower.from)) break;
      renumbered.add(follower.from);
      changes.push(...renumber(state, follower, expected++));
    }
  }

  // Swallow the key even when nothing moves, so Tab doesn't leave the editor.
  if (changes.length) view.dispatch({ changes, scrollIntoView: true, userEvent: "input.indent" });
  return true;
}

export const indentListItem = (view) => changeListLevel(view, false);
export const outdentListItem = (view) => changeListLevel(view, true);

export const listEditing = [
  // Highest precedence: this has to run before the Markdown keymap's Enter.
  Prec.highest(
    keymap.of([
      { key: "Enter", run: listEnter },
      { key: "Tab", run: indentListItem },
      { key: "Shift-Tab", run: outdentListItem },
    ]),
  ),
  EditorView.domEventHandlers({
    paste(event, view) {
      const joined = pastedTextForListItem(view.state, event.clipboardData?.getData("text/plain") ?? "");
      if (joined === null) return false;
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(joined), { userEvent: "input.paste", scrollIntoView: true });
      return true;
    },
  }),
];
