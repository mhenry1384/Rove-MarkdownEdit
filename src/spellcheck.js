// Spell checking of text typed since the document was opened. Text that was
// loaded from the file or pasted is never underlined, unless a word in it is
// edited by typing. Right-clicking an underlined word offers corrections and
// adding the word to the personal dictionary.

import { invoke } from "@tauri-apps/api/core";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

import { showContextMenu } from "./context-menu.js";

const MAX_SUGGESTIONS = 7;

// Letters with internal apostrophes or underscores; digits are included so that
// "h264" is one token (and skipped) rather than the word "h".
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’_]+[\p{L}\p{M}\p{N}]+)*/gu;

// Next to these a word is probably a path, address, tag or function name.
const CODE_BEFORE = /[\\/@#.]$/;
const CODE_AFTER = /^(?:[\\/@(]|\.[\p{L}\p{N}])/u;

const NOT_PROSE_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "URL",
  "Autolink",
  "LinkLabel",
  "HTMLTag",
  "HTMLBlock",
  "Comment",
  "CommentBlock",
  "ProcessingInstruction",
  "Entity",
]);

// ---------- Dictionary ----------

let speller = null; // null until the dictionary has loaded

const refreshSpelling = StateEffect.define();

/** Loads the dictionaries, then underlines anything typed in the meantime. */
export async function loadSpellchecker(view) {
  const [{ default: nspell }, { default: aff }, { default: dic }, personalWords] = await Promise.all([
    import("nspell"),
    // Through node_modules because the package's "exports" hides these files.
    import("../node_modules/dictionary-en/index.aff?raw"),
    import("../node_modules/dictionary-en/index.dic?raw"),
    invoke("get_dictionary_words"),
  ]);
  speller = nspell(aff, dic);
  for (const word of personalWords) speller.add(word);
  view.dispatch({ effects: refreshSpelling.of(null) });
}

const straighten = (word) => word.replace(/’/g, "'");

/** Edit distance where swapping two adjacent letters counts as half an edit. */
function typoDistance(a, b) {
  let beforePrev = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], beforePrev[j - 2] + 0.5);
      }
    }
    beforePrev = prev;
    prev = row;
  }
  return prev[b.length];
}

/** Corrections for `word`, closest first. */
function suggestionsFor(word) {
  const target = straighten(word).toLowerCase();
  const ranked = speller
    .suggest(straighten(word))
    .map((text) => ({ text, distance: typoDistance(target, text.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ text }) => text);
  return word.includes("’") ? ranked.map((s) => s.replace(/'/g, "’")) : ranked;
}

function looksLikeProse(word, before, after) {
  return (
    word.length > 1 &&
    !/[\p{N}_]/u.test(word) &&
    word !== word.toUpperCase() && // acronyms
    !/\p{Ll}\p{Lu}/u.test(word) && // camelCase
    !CODE_BEFORE.test(before) &&
    !CODE_AFTER.test(after)
  );
}

function inProse(tree, pos) {
  for (let node = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (NOT_PROSE_NODES.has(node.name)) return false;
  }
  return true;
}

// ---------- Typed text ----------
// `ranges` are the sorted, non-touching [from, to] spans of typed text.
// `typingAt` is the cursor position right after typing (otherwise -1): the word
// there isn't finished, so it isn't checked until the cursor leaves it.

function merge(ranges) {
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

const typedText = StateField.define({
  create: () => ({ ranges: [], typingAt: -1 }),
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    const typing = tr.isUserEvent("input.type");
    let { ranges } = value;
    if (tr.docChanged) {
      // Text inserted at either edge of a span doesn't join it unless typed.
      ranges = ranges
        .map(([from, to]) => [tr.changes.mapPos(from, 1), tr.changes.mapPos(to, -1)])
        .filter(([from, to]) => from < to);
      if (typing) {
        tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
          if (fromB < toB) ranges.push([fromB, toB]);
        });
      }
      ranges = merge(ranges);
    }
    const { empty, head } = tr.state.selection.main;
    return { ranges, typingAt: typing && empty ? head : -1 };
  },
});

// ---------- Underlines ----------

const misspelled = Decoration.mark({ class: "cm-misspelled" });

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  if (!speller) return builder.finish();
  const { state } = view;
  const { ranges, typingAt } = state.field(typedText);
  const tree = syntaxTree(state);
  let lastEnd = -1; // a word can touch two spans, with old text between them

  for (const [spanFrom, spanTo] of ranges) {
    const from = Math.max(spanFrom, view.viewport.from);
    const to = Math.min(spanTo, view.viewport.to);
    if (from >= to) continue;
    for (let line = state.doc.lineAt(from); ; line = state.doc.line(line.number + 1)) {
      for (const match of line.text.matchAll(WORD)) {
        const word = match[0];
        const wordFrom = line.from + match.index;
        const wordTo = wordFrom + word.length;
        if (wordTo <= from || wordFrom >= to || wordFrom < lastEnd) continue;
        if (typingAt >= wordFrom && typingAt <= wordTo) continue;
        const before = line.text.slice(0, match.index);
        const after = line.text.slice(match.index + word.length);
        if (looksLikeProse(word, before, after) && inProse(tree, wordFrom) && !speller.correct(straighten(word))) {
          builder.add(wordFrom, wordTo, misspelled);
          lastEnd = wordTo;
        }
      }
      if (line.to >= to) break;
    }
  }
  return builder.finish();
}

const spellPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.state.field(typedText) !== update.startState.field(typedText) ||
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshSpelling)))
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------- Menu ----------

function misspelledWordAt(view, pos) {
  let found = null;
  view.plugin(spellPlugin).decorations.between(pos, pos, (from, to) => {
    found = { from, to };
    return false;
  });
  return found;
}

function replaceWord(view, { from, to }, word, replacement) {
  if (view.state.sliceDoc(from, to) !== word) return; // edited while the menu was open
  view.dispatch({
    changes: { from, to, insert: replacement },
    selection: { anchor: from + replacement.length },
    userEvent: "input.spellcheck",
  });
}

function addToDictionary(view, word, onError) {
  speller.add(straighten(word));
  view.dispatch({ effects: refreshSpelling.of(null) });
  invoke("add_dictionary_word", { word: straighten(word) }).catch(onError);
}

function menuItems(view, range, onError) {
  const word = view.state.sliceDoc(range.from, range.to);
  const corrections = suggestionsFor(word).map((text) => ({
    label: text,
    run: () => replaceWord(view, range, word, text),
  }));
  return [
    ...(corrections.length ? corrections : [{ label: "No suggestions", disabled: true }]),
    null,
    { label: `Add "${word}" to dictionary`, run: () => addToDictionary(view, word, onError) },
  ];
}

// ---------- Extension ----------

/** `onError` is told if a word couldn't be saved to the personal dictionary. */
export function spellcheck(onError) {
  return [
    typedText,
    spellPlugin,
    EditorView.domEventHandlers({
      contextmenu(event, view) {
        if (!event.target.closest?.(".cm-misspelled")) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const range = pos == null ? null : misspelledWordAt(view, pos);
        if (!range) return false;
        showContextMenu(view, event.clientX, event.clientY, menuItems(view, range, onError));
        event.preventDefault();
        return true;
      },
    }),
  ];
}
