// ---------- List editing ----------
// Enter at the end of a list item starts a new item. CodeMirror's Markdown
// keymap does this for most items, but it silently falls back to a plain
// newline when the parser hasn't reached the cursor yet (which happens after an
// edit in a long document), on the wrapped lines of a multi-line item, and when
// a tab follows the marker.
//
// Pasting multi-line text into a list item joins it into one line, so wrapped
// text from elsewhere doesn't break the item apart.

import { Prec } from "@codemirror/state";
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

export const listEditing = [
  // Highest precedence: this has to run before the Markdown keymap's Enter.
  Prec.highest(keymap.of([{ key: "Enter", run: listEnter }])),
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
