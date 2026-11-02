// ---------- Formatting ----------
// Ctrl+B / Ctrl+I / Ctrl+U toggle bold, italic and underline (<u>) on the
// selection (or the word at the cursor). Ctrl+1 … Ctrl+5 turn the current line(s) into a heading of that
// level; pressing it again on a heading of the same level removes the heading.

import { EditorSelection, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";

/** The innermost `name` node (Emphasis / StrongEmphasis) around from..to. */
function enclosingNode(state, from, to, name) {
  const tree = ensureSyntaxTree(state, to, 200) ?? syntaxTree(state);
  const empty = from === to;
  for (const start of [tree.resolveInner(from, 1), tree.resolveInner(to, -1)]) {
    for (let node = start; node; node = node.parent) {
      if (node.name !== name) continue;
      // A bare cursor must be strictly inside, not just touching the markers.
      if (empty ? node.from < from && from < node.to : node.from <= from && to <= node.to) return node;
    }
  }
  return null;
}

const WORD = /[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*/gu;

/** The word touching pos, counting apostrophes inside it ("don't"), or null. */
function wordAt(state, pos) {
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(WORD)) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (from <= pos && pos <= to) return { from, to };
  }
  return null;
}

/** The opening and closing EmphasisMark of the `name` node around from..to, or null. */
function emphasisMarks(name) {
  return (state, from, to) => {
    const node = enclosingNode(state, from, to, name);
    if (node?.firstChild?.name !== "EmphasisMark" || node.lastChild?.name !== "EmphasisMark") return null;
    return { open: node.firstChild, close: node.lastChild };
  };
}

/** The <u> and </u> tags around from..to on one line, or null. */
function underlineTags(state, from, to) {
  const line = state.doc.lineAt(from);
  if (to > line.to) return null;
  const tree = ensureSyntaxTree(state, line.to, 200) ?? syntaxTree(state);
  const empty = from === to;
  for (const m of line.text.matchAll(/<u>(.*?)<\/u>/gi)) {
    const start = line.from + m.index;
    const end = start + m[0].length;
    if (empty ? !(start < from && from < end) : !(start <= from && to <= end)) continue;
    if (tree.resolve(start, 1).name !== "HTMLTag") continue; // inside code
    return { open: { from: start, to: start + 3 }, close: { from: end - 4, to: end } };
  }
  return null;
}

/**
 * Toggles open/close markers around each selection range. `findMarks` returns
 * the existing markers around a range, if it is already formatted.
 */
function toggleInline(findMarks, openMarker, closeMarker = openMarker) {
  const n = openMarker.length;
  const c = closeMarker.length;
  // Cursor between empty markers ("**|**") from a previous toggle, but not "***|***".
  const isEmptyPair = (state, pos) =>
    state.sliceDoc(pos - n, pos) === openMarker &&
    state.sliceDoc(pos, pos + c) === closeMarker &&
    !(openMarker[0] === "*" && (state.sliceDoc(pos - n - 1, pos - n) === "*" || state.sliceDoc(pos + c, pos + c + 1) === "*"));
  return (view) => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      // Already formatted: remove the markers.
      const marks = findMarks(state, range.from, range.to);
      if (marks) {
        const { open, close } = marks;
        const changes = state.changes([
          { from: open.from, to: open.to },
          { from: close.from, to: close.to },
        ]);
        return {
          changes,
          range: EditorSelection.range(changes.mapPos(range.anchor), changes.mapPos(range.head)),
        };
      }

      if (range.empty) {
        const pos = range.from;
        if (isEmptyPair(state, pos)) {
          return { changes: { from: pos - n, to: pos + c }, range: EditorSelection.cursor(pos - n) };
        }
        // Wrap the word at the cursor, or insert empty markers to type into.
        const word = wordAt(state, pos);
        const from = word ? word.from : pos;
        const to = word ? word.to : pos;
        return {
          changes: [
            { from, insert: openMarker },
            { from: to, insert: closeMarker },
          ],
          range: EditorSelection.cursor(pos + n),
        };
      }

      // Keep surrounding whitespace outside the markers ("** x **" isn't bold).
      let { from, to } = range;
      while (from < to && /\s/.test(state.sliceDoc(from, from + 1))) from++;
      while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
      const changes = [
        { from, insert: openMarker },
        { from: to, insert: closeMarker },
      ];
      return {
        changes,
        range:
          range.anchor <= range.head
            ? EditorSelection.range(from + n, to + n)
            : EditorSelection.range(to + n, from + n),
      };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
    return true;
  };
}

const ATX_PREFIX = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;

function setHeading(level) {
  const prefix = "#".repeat(level) + " ";
  return (view) => {
    const { state } = view;
    const lines = new Map();
    for (const range of state.selection.ranges) {
      // A selection ending at the start of a line doesn't include that line.
      const end = range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
      for (let pos = range.from; pos <= end; ) {
        const line = state.doc.lineAt(pos);
        lines.set(line.number, line);
        pos = line.to + 1;
      }
    }
    let targets = [...lines.values()];
    if (targets.length > 1) targets = targets.filter((line) => line.text.trim() !== "");
    if (targets.length === 0) return true;

    // All already at this level: make them plain lines again.
    const remove = targets.every((line) => ATX_PREFIX.exec(line.text)?.[1].length === level);
    const changes = state.changes(
      targets.map((line) => {
        const m = ATX_PREFIX.exec(line.text);
        const to = line.from + (m ? m[0].length : 0);
        return { from: line.from, to, insert: remove ? "" : prefix };
      }),
    );
    const selection = EditorSelection.create(
      state.selection.ranges.map((r) => EditorSelection.range(changes.mapPos(r.anchor, 1), changes.mapPos(r.head, 1))),
      state.selection.mainIndex,
    );
    view.dispatch({ changes, selection, scrollIntoView: true, userEvent: "input.format" });
    return true;
  };
}

/** Commands by native menu item id (see build_menu in lib.rs). */
export const formatCommands = {
  bold: toggleInline(emphasisMarks("StrongEmphasis"), "**"),
  italic: toggleInline(emphasisMarks("Emphasis"), "*"),
  underline: toggleInline(underlineTags, "<u>", "</u>"),
};
for (let level = 1; level <= 5; level++) formatCommands[`heading-${level}`] = setHeading(level);

// High precedence: the default keymap binds Mod-i to "select parent syntax"
// and Mod-u to "undo selection".
export const formatting = Prec.high(
  keymap.of([
    { key: "Mod-b", run: formatCommands.bold },
    { key: "Mod-i", run: formatCommands.italic },
    { key: "Mod-u", run: formatCommands.underline },
    ...[1, 2, 3, 4, 5].map((level) => ({ key: `Mod-${level}`, run: formatCommands[`heading-${level}`] })),
  ]),
);
