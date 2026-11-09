// ---------- List editing ----------
// Enter at the end of a list item starts a new item. CodeMirror's Markdown
// keymap does this for most items, but it silently falls back to a plain
// newline when the parser hasn't reached the cursor yet (which happens after an
// edit in a long document), on the wrapped lines of a multi-line item, and when
// a tab follows the marker.

import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { forceParsing, syntaxTree } from "@codemirror/language";

const PARSE_TIMEOUT_MS = 500;
const NOT_ITEM_TEXT = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "Blockquote"]);

/** The ListItem whose own text contains pos, or null if pos is in a nested block. */
function listItemAt(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
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

// Highest precedence: this has to run before the Markdown keymap's Enter.
export const listEditing = Prec.highest(keymap.of([{ key: "Enter", run: listEnter }]));
