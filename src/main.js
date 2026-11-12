import "./style.css";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog, save as saveDialog, ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { EditorView, basicSetup } from "codemirror";
import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  syntaxTree,
  ensureSyntaxTree,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { tags } from "@lezer/highlight";

import { tableEditing, showTableMenu, insertTable } from "./table-editing.js";
import { formatting, formatCommands } from "./formatting.js";
import { listEditing } from "./list-editing.js";
import { spellcheck, loadSpellchecker } from "./spellcheck.js";
import { fileStemFromHeading, headingFromFileName } from "./file-title.js";
import { richPaste, pasteAsPlainText } from "./paste.js";
import { findPanel, openReplacePanel } from "./find-panel.js";

const APP_NAME = "Rove MarkdownEdit";
const AUTOSAVE_DELAY_MS = 1500;
const MD_FILTERS = [
  { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
  { name: "All files", extensions: ["*"] },
];

const appWindow = getCurrentWindow();

// ---------- Document state ----------

let currentPath = null; // null = untitled
let dirty = false;
let changeGen = 0; // bumps on every edit; lets a save know if edits happened mid-write
let eol = "\n"; // preserved line ending of the open file
let recentFiles = [];
let headings = [];

// Serialize file operations so rapid clicks / shell opens can't interleave.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch(showError);
  return queue;
}

// ---------- Editor ----------

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.6em", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "1.4em", fontWeight: "700" },
  { tag: tags.heading3, fontSize: "1.2em", fontWeight: "700" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--link)" },
  { tag: tags.url, color: "var(--muted)" },
  { tag: tags.monospace, fontFamily: "var(--mono)", color: "var(--code)" },
  { tag: tags.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.meta], color: "var(--muted)" },
  // Fenced code blocks
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--kw)" },
  { tag: [tags.string, tags.regexp], color: "var(--str)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.atom], color: "var(--num)" },
]);

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "var(--bg)", color: "var(--fg)", fontSize: "15px" },
  ".cm-content": { fontFamily: "var(--ui)", padding: "16px 0", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0 24px 0 12px", lineHeight: "1.6" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--sel) !important",
  },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-gutters": { display: "none" },
  ".cm-clickable-link": { cursor: "pointer" },
  ".cm-bullet": { color: "var(--fg)", display: "inline-block", width: "0.7em", textAlign: "center" },
  ".cm-bullet::before": {
    content: '""',
    display: "inline-block",
    boxSizing: "border-box",
    width: "0.38em",
    height: "0.38em",
    verticalAlign: "0.12em",
    backgroundColor: "currentColor",
    borderRadius: "50%",
  },
  ".cm-bullet-2::before": { backgroundColor: "transparent", border: "1.5px solid currentColor" },
  ".cm-bullet-3::before": { borderRadius: "0" },
  ".cm-line.cm-list-gap": { lineHeight: "6px", fontSize: "6px" },
  ".cm-header-mark": { opacity: "0.25" },
  ".cm-header-mark, .cm-header-mark *": { color: "var(--fg) !important" },
  ".cm-table-wrap": { padding: "4px 24px 4px 12px", overflowX: "auto", cursor: "text" },
  ".cm-table": { borderCollapse: "collapse", lineHeight: "1.5" },
  ".cm-table th, .cm-table td": { border: "1px solid var(--border)", padding: "4px 12px", verticalAlign: "top" },
  ".cm-table th": { backgroundColor: "var(--sidebar-bg)", fontWeight: "600", textAlign: "left" },
  ".cm-inline-code": { backgroundColor: "var(--code-bg)", borderRadius: "3px", padding: "1px 0" },
  ".cm-underline": { textDecoration: "underline" },
  ".cm-misspelled": {
    textDecoration: "underline wavy var(--error) 1px",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "2px",
  },
  // Horizontal margins only: CodeMirror measures line heights, and vertical
  // margins would throw them off.
  ".cm-line.cm-codeblock": {
    backgroundColor: "var(--code-bg)",
    fontFamily: "var(--mono)",
    margin: "0 24px 0 12px",
    padding: "0 12px",
    borderLeft: "1px solid var(--border)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-line.cm-codeblock-first": {
    borderTop: "1px solid var(--border)",
    borderTopLeftRadius: "4px",
    borderTopRightRadius: "4px",
  },
  ".cm-line.cm-codeblock-last": {
    borderBottom: "1px solid var(--border)",
    borderBottomLeftRadius: "4px",
    borderBottomRightRadius: "4px",
  },
  ".cm-line.cm-codeblock-fence": { lineHeight: "6px", fontSize: "6px" },
  ".cm-table code": {
    fontFamily: "var(--mono)",
    color: "var(--code)",
    backgroundColor: "var(--code-bg)",
    borderRadius: "3px",
    padding: "1px 3px",
  },
  ".cm-table-link": { color: "var(--link)" },
});

// ---------- List display (display only; the text is unchanged) ----------
// Bullet markers (*, -, +) are drawn as real bullets, and blank lines between
// items of a loose list shrink to a small gap, as in Typora. The bullet's
// shape cycles with nesting depth: solid dot, hollow circle, solid square.

const BULLET_SHAPES = 3;

class BulletWidget extends WidgetType {
  constructor(level) {
    super();
    this.level = level;
  }
  eq(other) {
    return other.level === this.level;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = `cm-bullet cm-bullet-${this.level}`;
    return span;
  }
}

const listGapLine = Decoration.line({ class: "cm-list-gap" });

function buildListDecorations(view) {
  const { state } = view;
  const cursorLine = state.doc.lineAt(state.selection.main.head).number;
  const tree = syntaxTree(state);
  const marks = [];

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name === "ListMark" && node.node.parent?.parent?.name === "BulletList") {
          let depth = 0;
          for (let p = node.node.parent; p; p = p.parent) if (p.name === "BulletList") depth++;
          const widget = new BulletWidget(((depth - 1) % BULLET_SHAPES) + 1);
          marks.push([node.from, Decoration.replace({ widget })]);
        } else if (node.name === "BulletList" || node.name === "OrderedList") {
          // Only the outermost list: nested lists are covered by its range.
          if (node.node.parent?.name === "ListItem") return;
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(node.to).number;
          for (let n = first + 1; n < last; n++) {
            const line = state.doc.line(n);
            if (n === cursorLine || line.text.trim() !== "") continue;
            const inner = tree.resolveInner(line.from, 1);
            let inCode = false;
            for (let p = inner; p; p = p.parent) {
              if (p.name === "FencedCode" || p.name === "CodeBlock") inCode = true;
            }
            if (!inCode) marks.push([line.from, listGapLine]);
          }
        }
      },
    });
  }

  // Line decorations must precede replace decorations at the same position.
  marks.sort((a, b) => a[0] - b[0] || (b[1].spec.class ? 1 : 0) - (a[1].spec.class ? 1 : 0));
  const builder = new RangeSetBuilder();
  const seen = new Set(); // a list spanning two visible ranges is visited twice
  for (const [pos, deco] of marks) {
    const isGap = deco === listGapLine;
    const key = `${pos}${isGap ? "g" : "b"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    builder.add(pos, isGap ? pos : pos + 1, deco);
  }
  return builder.finish();
}

const listDisplay = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildListDecorations(view);
    }
    update(update) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildListDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------- Heading marks ----------
// The # markers of ATX headings are shown faded.

const headerMarkDeco = Decoration.mark({ class: "cm-header-mark" });

function buildHeaderMarkDecorations(view) {
  const builder = new RangeSetBuilder();
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name === "HeaderMark" && node.from >= last && /^ATXHeading/.test(node.node.parent?.name)) {
          builder.add(node.from, node.to, headerMarkDeco);
          last = node.to;
        }
      },
    });
  }
  return builder.finish();
}

const headerMarks = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildHeaderMarkDecorations(view);
    }
    update(update) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildHeaderMarkDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------- Inline marks ----------
// `code`, **bold**, *italic*, ~~strikethrough~~ and <u>underline</u> hide their
// markers unless the selection is inside the span. `code` spans get a shaded
// background and <u> spans are underlined. Entities such as &rarr; are always
// drawn as the character they stand for, and are deleted as a unit.

const inlineCodeDeco = Decoration.mark({ class: "cm-inline-code" });
const underlineDeco = Decoration.mark({ class: "cm-underline" });
const hiddenMark = Decoration.replace({});

/** Node name -> name of its marker children. */
const MARKED_SPANS = {
  InlineCode: "CodeMark",
  StrongEmphasis: "EmphasisMark",
  Emphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
};

const entityDecoder = document.createElement("textarea");
/** The text an HTML entity such as "&rarr;" stands for (unchanged if unknown). */
function decodeEntity(entity) {
  entityDecoder.innerHTML = entity;
  return entityDecoder.value;
}

class EntityWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.text;
    return span;
  }
}

/** Whether a selection range overlaps from..to (a cursor must be strictly inside). */
function selectionTouches(state, from, to) {
  return state.selection.ranges.some((r) => r.from < to && r.to > from);
}

function buildInlineMarkDecorations(view) {
  const { state } = view;
  const tree = syntaxTree(state);
  const decos = [];
  const entities = [];

  const addSpan = (open, close, contentDeco) => {
    if (selectionTouches(state, open.from, close.to) || open.to >= close.from) {
      if (contentDeco) decos.push(contentDeco.range(open.from, close.to));
      return;
    }
    decos.push(hiddenMark.range(open.from, open.to));
    if (contentDeco) decos.push(contentDeco.range(open.to, close.from));
    decos.push(hiddenMark.range(close.from, close.to));
  };

  tree.iterate({
    from: view.viewport.from,
    to: view.viewport.to,
    enter(node) {
      const markName = MARKED_SPANS[node.name];
      if (markName) {
        const marks = node.node.getChildren(markName);
        const contentDeco = node.name === "InlineCode" ? inlineCodeDeco : null;
        if (marks.length >= 2) addSpan(marks[0], marks[marks.length - 1], contentDeco);
        else if (contentDeco) decos.push(contentDeco.range(node.from, node.to));
        return node.name !== "InlineCode";
      }
      if (node.name === "HTMLTag" && state.sliceDoc(node.from, node.to).toLowerCase() === "<u>") {
        // The matching </u> must be a tag in the same block (not inside code).
        const end = node.node.parent?.to ?? node.to;
        const i = state.sliceDoc(node.to, end).toLowerCase().indexOf("</u>");
        if (i < 0) return;
        const close = { from: node.to + i, to: node.to + i + 4 };
        if (tree.resolve(close.from, 1).name !== "HTMLTag") return;
        addSpan(node, close, underlineDeco);
      } else if (node.name === "Entity") {
        const source = state.sliceDoc(node.from, node.to);
        const text = decodeEntity(source);
        if (text !== source) {
          entities.push(Decoration.replace({ widget: new EntityWidget(text) }).range(node.from, node.to));
        }
      }
    },
  });
  return {
    decorations: Decoration.set([...decos, ...entities], true),
    entities: Decoration.set(entities, true),
  };
}

const inlineMarksPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      Object.assign(this, buildInlineMarkDecorations(view));
    }
    update(update) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        Object.assign(this, buildInlineMarkDecorations(update.view));
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const inlineMarks = [
  inlineMarksPlugin,
  EditorView.atomicRanges.of((view) => view.plugin(inlineMarksPlugin)?.entities ?? Decoration.none),
];

// ---------- Arrows ----------
// Typing -> or <- replaces it with &rarr; or &larr; (outside code). Undo
// restores the typed characters.

const ARROWS = { ">": ["-", "&rarr;"], "-": ["<", "&larr;"] };
const NO_ARROW_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock", "Comment"]);

const typeArrows = EditorView.inputHandler.of((view, from, to, text) => {
  const arrow = ARROWS[text];
  if (!arrow || from !== to) return false;
  const { state } = view;
  const [prev, entity] = arrow;
  // Leave "-->" and "<!--" alone.
  if (state.sliceDoc(from - 1, from) !== prev || /[-<!]/.test(state.sliceDoc(from - 2, from - 1))) return false;
  for (let node = syntaxTree(state).resolveInner(from, -1); node; node = node.parent) {
    if (NO_ARROW_NODES.has(node.name)) return false;
  }
  view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  view.dispatch({
    changes: { from: from - 1, to: from + 1, insert: entity },
    selection: { anchor: from - 1 + entity.length },
    annotations: isolateHistory.of("before"),
    userEvent: "input.autocorrect",
  });
  return true;
});

// ---------- Code blocks ----------
// Fenced and indented code blocks are drawn as a shaded, bordered box. The
// fence lines (```) of a fenced block shrink to a small gap unless the
// selection touches the block.

function buildCodeBlockDecorations(view) {
  const { state } = view;
  const decos = [];
  syntaxTree(state).iterate({
    from: view.viewport.from,
    to: view.viewport.to,
    enter(node) {
      if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
      const first = state.doc.lineAt(node.from).number;
      const last = state.doc.lineAt(node.to).number;
      const fences = new Map(); // line number -> start of its fence
      const editing = state.selection.ranges.some((r) => r.from <= node.to && r.to >= node.from);
      if (node.name === "FencedCode" && !editing) {
        const marks = node.node.getChildren("CodeMark");
        for (const mark of marks.length > 1 ? [marks[0], marks[marks.length - 1]] : marks) {
          fences.set(state.doc.lineAt(mark.from).number, mark.from);
        }
      }
      for (let n = first; n <= last; n++) {
        const line = state.doc.line(n);
        let cls = "cm-codeblock";
        if (n === first) cls += " cm-codeblock-first";
        if (n === last) cls += " cm-codeblock-last";
        if (fences.has(n)) cls += " cm-codeblock-fence";
        decos.push(Decoration.line({ class: cls }).range(line.from));
        if (fences.has(n) && fences.get(n) < line.to) decos.push(hiddenMark.range(fences.get(n), line.to));
      }
      return false;
    },
  });
  return Decoration.set(decos, true);
}

const codeBlocks = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildCodeBlockDecorations(view);
    }
    update(update) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildCodeBlockDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------- Tables (display only; the text is unchanged) ----------
// A GFM table is drawn as a real table unless the selection touches it, in
// which case its markdown source is shown for editing. Clicking a cell moves
// the cursor to that cell's text; right-clicking also opens the table menu
// (see table-editing.js).

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Minimal inline markdown -> HTML for table cells. */
function renderInline(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) => {
      if (i % 2) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part.replace(/\\\|/g, "|"))
        .replace(/&amp;(#\d+|#x[\da-f]+|\w+);/gi, "&$1;") // entities such as &rarr;
        .replace(/&lt;u&gt;(.+?)&lt;\/u&gt;/gi, "<u>$1</u>")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '<span class="cm-table-link">$1</span>')
        .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "<strong>$2</strong>")
        .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "<em>$2</em>")
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<del>$1</del>");
    })
    .join("");
}

/** Cells of one table row: [{ text, offset }], offset relative to the line start. */
function splitRow(line) {
  const cells = [];
  let start = 0;
  let inCode = false;
  const bounds = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") i++;
    else if (c === "`") inCode = !inCode;
    else if (c === "|" && !inCode) bounds.push(i);
  }
  bounds.push(line.length);
  for (const end of bounds) {
    const raw = line.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    cells.push({ text: raw.trim(), offset: start + lead });
    start = end + 1;
  }
  // Drop the empty cells outside leading / trailing pipes.
  if (cells.length > 1 && cells[0].text === "" && /^\s*\|/.test(line)) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].text === "" && /\|\s*$/.test(line)) cells.pop();
  return cells;
}

class TableWidget extends WidgetType {
  constructor(source) {
    super();
    this.source = source;
  }
  eq(other) {
    return other.source === this.source;
  }
  toDOM(view) {
    const lines = this.source.split("\n");
    const lineStarts = [];
    let pos = 0;
    for (const line of lines) {
      lineStarts.push(pos);
      pos += line.length + 1;
    }
    const aligns = splitRow(lines[1] ?? "").map(({ text }) => {
      const left = text.startsWith(":");
      const right = text.endsWith(":");
      return left && right ? "center" : right ? "right" : left ? "left" : "";
    });

    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-table";
    const addRow = (parent, lineIdx, tag) => {
      const tr = document.createElement("tr");
      const cells = splitRow(lines[lineIdx]);
      for (let c = 0; c < Math.max(cells.length, aligns.length); c++) {
        const cell = document.createElement(tag);
        if (aligns[c]) cell.style.textAlign = aligns[c];
        if (cells[c]) {
          cell.innerHTML = renderInline(cells[c].text);
          cell.dataset.offset = lineStarts[lineIdx] + cells[c].offset;
        } else {
          cell.dataset.offset = lineStarts[lineIdx] + lines[lineIdx].length;
        }
        tr.append(cell);
      }
      parent.append(tr);
    };
    const thead = document.createElement("thead");
    addRow(thead, 0, "th");
    const tbody = document.createElement("tbody");
    for (let i = 2; i < lines.length; i++) addRow(tbody, i, "td");
    table.append(thead, tbody);
    wrap.append(table);

    const moveToCell = (e) => {
      const start = view.posAtDOM(wrap);
      const cell = e.target.closest("th, td");
      const offset = cell ? Number(cell.dataset.offset) : 0;
      view.dispatch({ selection: { anchor: start + offset } });
      view.focus();
      e.preventDefault();
    };
    wrap.addEventListener("mousedown", (e) => {
      if (e.button === 0) moveToCell(e);
    });
    wrap.addEventListener("contextmenu", (e) => {
      moveToCell(e);
      showTableMenu(view, e.clientX, e.clientY);
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function buildTableDecorations(state) {
  const { from: selFrom, to: selTo } = state.selection.main;
  const builder = new RangeSetBuilder();
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;
      // Trim a trailing newline so the replaced range ends on the last row.
      let to = node.to;
      while (to > node.from && state.doc.sliceString(to - 1, to) === "\n") to--;
      if (selFrom > to || selTo < node.from) {
        const widget = new TableWidget(state.doc.sliceString(node.from, to));
        builder.add(node.from, to, Decoration.replace({ widget, block: true }));
      }
      return false;
    },
  });
  return builder.finish();
}

const tableDisplay = StateField.define({
  create: (state) => buildTableDecorations(state),
  update(decos, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildTableDecorations(tr.state);
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- Clickable links ----------
// Web links (bare URLs, <autolinks> and [text](url)) show a hand cursor and
// open in the browser when clicked.

const WEB_URL = /^(https?:\/\/|mailto:|www\.)/i;

/** The web URL of the link at `pos`, or null. */
function linkAt(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    let urlNode = null;
    if (node.name === "URL") urlNode = node;
    else if (node.name === "Link" || node.name === "Autolink") urlNode = node.getChild("URL");
    if (!urlNode) continue;
    const url = state.sliceDoc(urlNode.from, urlNode.to);
    if (!WEB_URL.test(url)) return null;
    return /^www\./i.test(url) ? `https://${url}` : url;
  }
  return null;
}

const linkMark = Decoration.mark({ class: "cm-clickable-link" });

function buildLinkDecorations(view) {
  const builder = new RangeSetBuilder();
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const isLink = node.name === "Link" || node.name === "Autolink";
        if (!isLink && node.name !== "URL") return;
        if (node.from >= last && linkAt(view.state, node.from + 1)) {
          builder.add(node.from, node.to, linkMark);
          last = node.to;
        }
        return false; // a Link's URL child is covered by the Link itself
      },
    });
  }
  return builder.finish();
}

const clickableLinks = [
  ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildLinkDecorations(view);
      }
      update(update) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState)
        ) {
          this.decorations = buildLinkDecorations(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  ),
  EditorView.domEventHandlers({
    click(event, view) {
      if (event.button !== 0 || !view.state.selection.main.empty) return false; // drag-select
      if (!event.target.closest?.(".cm-clickable-link")) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const url = pos == null ? null : linkAt(view.state, pos);
      if (!url) return false;
      openUrl(url).catch(showError);
      event.preventDefault();
      return true;
    },
  }),
];

function makeState(text) {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      // Don't highlight other occurrences of the selected text: basicSetup
      // turns this on, and the configs combine by taking the smallest limit.
      highlightSelectionMatches({ maxMatches: 0 }),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(mdHighlight),
      listDisplay,
      headerMarks,
      inlineMarks,
      typeArrows,
      codeBlocks,
      tableDisplay,
      spellcheck(showError), // before tableEditing, so it gets right-clicks on underlined words first
      tableEditing,
      richPaste(showError), // before listEditing, so its paste handler sees only plain text
      listEditing,
      formatting,
      clickableLinks,
      findPanel,
      editorTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          changeGen++;
          setDirty(true);
          promotePending();
          scheduleAutosave();
          scheduleOutline();
        } else if (update.selectionSet) {
          highlightCurrentHeading();
        }
      }),
    ],
  });
}

const view = new EditorView({
  parent: document.getElementById("editor"),
  state: makeState(""),
});

// ---------- Keyboard lists ----------
// The outline and files lists can be focused (Tab, Alt+1 / Alt+2) and driven
// with the keyboard: arrows, Home/End and PageUp/PageDown move a cursor, Enter
// activates the item and Escape returns to the editor. On focus the cursor
// starts at the highlighted ("current") item. Mouse clicks don't focus a list.

function keyboardList(el, { onActivate, onMove, onDelete }) {
  let cursor = -1;
  const items = () => el.children;

  function setCursor(i, notify = true) {
    const n = items().length;
    cursor = n ? Math.max(0, Math.min(n - 1, i)) : -1;
    for (const [j, li] of [...items()].entries()) li.classList.toggle("cursor", j === cursor);
    const li = items()[cursor];
    if (!li) return;
    li.scrollIntoView({ block: "nearest" });
    if (notify) onMove?.(li);
  }

  el.tabIndex = 0;
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("focus", () => {
    const current = [...items()].findIndex((li) => li.classList.contains("current"));
    setCursor(current >= 0 ? current : 0, false);
  });
  el.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const page = Math.max(1, Math.floor(el.parentElement.clientHeight / (items()[0]?.offsetHeight || 24)) - 1);
    const li = items()[cursor];
    switch (e.key) {
      case "ArrowDown": setCursor(cursor + 1); break;
      case "ArrowUp": setCursor(cursor - 1); break;
      case "PageDown": setCursor(cursor + page); break;
      case "PageUp": setCursor(cursor - page); break;
      case "Home": setCursor(0); break;
      case "End": setCursor(items().length - 1); break;
      case "Enter":
      case " ":
        if (li) onActivate(li);
        break;
      case "Delete":
        if (!li || !onDelete) return;
        onDelete(li);
        break;
      case "Escape":
        view.focus();
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  return {
    /** Call after re-rendering the items, to keep the cursor in place. */
    refresh() {
      if (document.activeElement === el) setCursor(cursor, false);
    },
  };
}

// ---------- Outline ----------

const outlineEl = document.getElementById("outline");
const outlineEmptyEl = document.getElementById("outline-empty");

function cleanHeadingText(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links / images -> label
    .replace(/<\/?u>/gi, "")
    .replace(/[*_`~]/g, "")
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, decodeEntity)
    .trim();
}

function extractHeadings(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state);
  const found = [];
  tree.iterate({
    enter(node) {
      const m = /^(ATXHeading|SetextHeading)(\d)$/.exec(node.name);
      if (!m) return;
      const firstLine = state.doc.lineAt(node.from);
      let text;
      if (m[1] === "ATXHeading") {
        text = state.doc
          .sliceString(node.from, node.to)
          .replace(/^#{1,6}[ \t]*/, "")
          .replace(/[ \t]+#+[ \t]*$/, "");
      } else {
        text = firstLine.text;
      }
      found.push({ level: Number(m[2]), text: cleanHeadingText(text), from: node.from });
      return false;
    },
  });
  return found;
}

let outlineTimer = null;
function scheduleOutline() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(renderOutline, 150);
}

function renderOutline() {
  clearTimeout(outlineTimer);
  headings = extractHeadings(view.state);
  outlineEl.replaceChildren(
    ...headings.map((h, i) => {
      const li = document.createElement("li");
      li.className = `level-${h.level}`;
      li.style.paddingLeft = `${10 + (h.level - 1) * 14}px`;
      li.textContent = h.text || "(empty heading)";
      li.title = h.text;
      li.dataset.index = i;
      return li;
    }),
  );
  outlineEmptyEl.classList.toggle("hidden", headings.length > 0);
  highlightCurrentHeading();
  outlineKeys.refresh();
}

function highlightCurrentHeading() {
  const pos = view.state.selection.main.head;
  let idx = -1;
  for (let i = 0; i < headings.length && headings[i].from <= pos; i++) idx = i;
  for (const li of outlineEl.children) {
    li.classList.toggle("current", Number(li.dataset.index) === idx);
  }
}

function goToHeading(li) {
  const h = headings[Number(li.dataset.index)];
  if (!h) return;
  view.dispatch({
    selection: { anchor: h.from },
    effects: EditorView.scrollIntoView(h.from, { y: "start", yMargin: 12 }),
  });
  view.focus();
}

outlineEl.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li) goToHeading(li);
});

const outlineKeys = keyboardList(outlineEl, {
  onActivate: goToHeading,
  // Moving through the outline scrolls the editor without moving its cursor.
  onMove(li) {
    const h = headings[Number(li.dataset.index)];
    if (h) view.dispatch({ effects: EditorView.scrollIntoView(h.from, { y: "start", yMargin: 12 }) });
  },
});

// ---------- Files (recent) ----------

const filesEl = document.getElementById("files");
const filesEmptyEl = document.getElementById("files-empty");

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

function splitPath(p) {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return { dir: p.slice(0, i), name: p.slice(i + 1) };
}

const SLIDE_MS = 300;

function filesVisible() {
  return filesEl.offsetParent !== null && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Re-renders the list. Items that changed position slide to their new place. */
function renderFiles() {
  const key = (p) => p.replace(/\//g, "\\").toLowerCase();
  const before = new Map();
  if (filesVisible()) {
    for (const li of filesEl.children) before.set(key(li.dataset.path), li.getBoundingClientRect().top);
  }

  filesEl.replaceChildren(
    ...recentFiles.map((path) => {
      const { dir, name } = splitPath(path);
      const li = document.createElement("li");
      li.title = path;
      li.dataset.path = path;
      li.classList.toggle("current", samePath(path, currentPath));

      const text = document.createElement("div");
      text.className = "file-text";
      const nameEl = document.createElement("div");
      nameEl.className = "file-name";
      nameEl.textContent = name;
      const dirEl = document.createElement("div");
      dirEl.className = "file-dir";
      dirEl.textContent = dir;
      text.append(nameEl, dirEl);

      const remove = document.createElement("button");
      remove.className = "file-remove";
      remove.title = "Remove from list";
      remove.textContent = "×";

      li.append(text, remove);
      return li;
    }),
  );
  filesEmptyEl.classList.toggle("hidden", recentFiles.length > 0);
  filesKeys.refresh();

  for (const li of filesEl.children) {
    const top = before.get(key(li.dataset.path));
    if (top === undefined) continue;
    const dy = top - li.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    if (dy > 0) li.classList.add("sliding"); // moving up
    const anim = li.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
      duration: SLIDE_MS,
      easing: "ease-in-out",
    });
    anim.onfinish = anim.oncancel = () => li.classList.remove("sliding");
  }
}

// A file opened from the files list moves to the top only once it has been open
// for PROMOTE_DELAY_MS or is edited, so browsing the list doesn't reorder it.
const PROMOTE_DELAY_MS = 60_000;
let pendingPromotion = null; // { path, timer }

function cancelPromotion() {
  if (pendingPromotion) clearTimeout(pendingPromotion.timer);
  pendingPromotion = null;
}

function deferPromotion(path) {
  cancelPromotion();
  const timer = setTimeout(promotePending, PROMOTE_DELAY_MS);
  pendingPromotion = { path, timer };
}

function promotePending() {
  if (!pendingPromotion) return;
  const { path } = pendingPromotion;
  cancelPromotion();
  enqueue(async () => {
    recentFiles = await invoke("add_recent_file", { path });
    renderFiles();
  });
}

function removeRecent(path) {
  enqueue(async () => {
    recentFiles = await invoke("remove_recent_file", { path });
    renderFiles();
  });
}

filesEl.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  const path = li.dataset.path;
  if (e.target.closest(".file-remove")) removeRecent(path);
  else enqueue(() => openFile(path, { fromList: true }));
});

const filesKeys = keyboardList(filesEl, {
  onActivate: (li) =>
    enqueue(async () => {
      await openFile(li.dataset.path, { fromList: true });
      view.focus();
    }),
  onDelete: (li) => removeRecent(li.dataset.path),
});

// ---------- Status / title ----------

const statusPathEl = document.getElementById("status-path");
const statusStateEl = document.getElementById("status-state");

function setDirty(value) {
  if (dirty === value) return;
  dirty = value;
  updateChrome();
}

function updateChrome() {
  const name = currentPath ? splitPath(currentPath).name : "Untitled";
  appWindow.setTitle(`${dirty ? "● " : ""}${name} — ${APP_NAME}`).catch(() => {});
  statusPathEl.textContent = currentPath ?? "Untitled (not saved)";
  statusStateEl.classList.remove("error");
  statusStateEl.textContent = dirty ? "Edited" : currentPath ? "Saved" : "";
}

function showError(err) {
  console.error(err);
  statusStateEl.textContent = String(err?.message ?? err);
  statusStateEl.classList.add("error");
}

// ---------- File operations ----------

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  if (!currentPath) return;
  autosaveTimer = setTimeout(() => enqueue(() => saveCurrent()), AUTOSAVE_DELAY_MS);
}

/** The name offered when first saving: the first heading, or "Untitled". */
function suggestedFileName() {
  const stem = extractHeadings(view.state)
    .map((h) => fileStemFromHeading(h.text))
    .find(Boolean);
  return `${stem ?? "Untitled"}.md`;
}

/** Gives a document that is empty or only whitespace a heading from its file name. */
function addHeadingIfBlank(path) {
  const { doc } = view.state;
  if (doc.toString().trim()) return;
  const title = headingFromFileName(splitPath(path).name);
  if (!title) return;
  const insert = `# ${title}\n\n`;
  view.dispatch({ changes: { from: 0, to: doc.length, insert }, selection: { anchor: insert.length } });
}

/**
 * Save the current document. For an untitled document with content, asks for a
 * path. With `explicit` (the user chose Save), an untitled document always asks
 * for a path, even if it is empty or unchanged. Returns false if the user
 * cancelled the save dialog.
 */
async function saveCurrent({ explicit = false } = {}) {
  clearTimeout(autosaveTimer);
  const untitledSave = explicit && !currentPath;
  if (!dirty && !untitledSave) return true;

  if (!currentPath) {
    if (view.state.doc.length === 0 && !untitledSave) return true; // nothing worth saving
    const path = await saveDialog({ filters: MD_FILTERS, defaultPath: suggestedFileName() });
    if (!path) return false;
    currentPath = path;
    recentFiles = await invoke("add_recent_file", { path });
    renderFiles();
    addHeadingIfBlank(path);
  }

  const gen = changeGen;
  let text = view.state.doc.toString();
  if (eol !== "\n") text = text.replace(/\n/g, eol);
  await invoke("write_file", { path: currentPath, contents: text });
  if (gen === changeGen) setDirty(false);
  updateChrome();
  return true;
}

function loadDocument(path, text) {
  clearTimeout(autosaveTimer);
  eol = text.includes("\r\n") ? "\r\n" : "\n";
  view.setState(makeState(text));
  currentPath = path;
  dirty = false;
  updateChrome();
  renderOutline();
  renderFiles();
  view.focus();
}

/**
 * Opens `path`. With `fromList` (clicked in the files list), the file's place in
 * the list waits for promotePending instead of moving to the top right away.
 */
async function openFile(path, { fromList = false } = {}) {
  if (samePath(path, currentPath)) {
    if (fromList) return;
    cancelPromotion();
    recentFiles = await invoke("add_recent_file", { path });
    renderFiles();
    return;
  }
  if (!(await saveCurrent())) return;

  let text;
  try {
    text = await invoke("read_file", { path });
  } catch (err) {
    const remove = await ask(`Could not open\n${path}\n\n${err}\n\nRemove it from the recent files list?`, {
      title: APP_NAME,
      kind: "warning",
    });
    if (remove) {
      recentFiles = await invoke("remove_recent_file", { path });
      renderFiles();
    }
    return;
  }

  cancelPromotion();
  if (fromList && recentFiles.some((p) => samePath(p, path))) deferPromotion(path);
  else recentFiles = await invoke("add_recent_file", { path });
  loadDocument(path, text);
}

async function openWithDialog() {
  const path = await openDialog({ multiple: false, directory: false, filters: MD_FILTERS });
  if (path) await openFile(path);
}

async function newFile() {
  if (!(await saveCurrent())) return;
  cancelPromotion();
  eol = "\n";
  loadDocument(null, "");
}

document.getElementById("btn-open").addEventListener("click", () => enqueue(openWithDialog));
document.getElementById("btn-new").addEventListener("click", () => enqueue(newFile));

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === "s") enqueue(() => saveCurrent({ explicit: true }));
  else if (key === "o") enqueue(openWithDialog);
  else if (key === "n") enqueue(newFile);
  // Find / replace from outside the editor (the editor's keymap handles them inside).
  // Ctrl+R is always swallowed so the webview never reloads.
  else if (key === "f" || key === "r") {
    if (!e.defaultPrevented) (key === "f" ? openSearchPanel : openReplacePanel)(view);
  } else return;
  e.preventDefault();
});

// Save before the window closes.
appWindow.onCloseRequested(async (event) => {
  // A file still waiting to move to the top goes there now, so it reopens next time.
  promotePending();
  await queue;
  let saved = false;
  try {
    saved = await saveCurrent();
  } catch (err) {
    showError(err);
  }
  if (!saved) {
    const discard = await ask("Your changes have not been saved. Close anyway?", {
      title: APP_NAME,
      kind: "warning",
    });
    if (!discard) event.preventDefault();
  }
});

// ---------- Sidebar tabs & resizing ----------

function selectTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  document.getElementById("panel-outline").classList.toggle("hidden", name !== "outline");
  document.getElementById("panel-files").classList.toggle("hidden", name !== "files");
  try {
    localStorage.setItem("sidebarTab", name);
  } catch {}
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}

const sidebar = document.getElementById("sidebar");
const splitter = document.getElementById("splitter");
splitter.addEventListener("pointerdown", (e) => {
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add("dragging");
  const onMove = (ev) => (sidebar.style.width = `${ev.clientX}px`);
  const onUp = () => {
    splitter.classList.remove("dragging");
    splitter.removeEventListener("pointermove", onMove);
    splitter.removeEventListener("pointerup", onUp);
    try {
      localStorage.setItem("sidebarWidth", sidebar.style.width);
    } catch {}
  };
  splitter.addEventListener("pointermove", onMove);
  splitter.addEventListener("pointerup", onUp);
});

// ---------- Focus shortcuts ----------
// Alt+1 / Alt+2 / Alt+3 focus the outline, the files list and the editor (also
// listed in the View menu). e.code is used because Option+digit on a Mac types
// a symbol.

const FOCUS_TARGETS = {
  "focus-outline": () => {
    selectTab("outline");
    outlineEl.focus();
  },
  "focus-files": () => {
    selectTab("files");
    filesEl.focus();
  },
  "focus-editor": () => view.focus(),
};
const FOCUS_KEYS = { Digit1: "focus-outline", Digit2: "focus-files", Digit3: "focus-editor" };

document.addEventListener(
  "keydown",
  (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = FOCUS_KEYS[e.code];
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    FOCUS_TARGETS[target]();
  },
  true,
);

// The webview keeps Alt+letter from reaching the Windows menu bar, so the menu
// access keys (the "&" letters in build_menu) are passed on here.
if (navigator.userAgent.includes("Windows")) {
  const MENU_MNEMONICS = new Set(["f", "e", "v", "o", "h"]);
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
      const mnemonic = e.key.toLowerCase();
      if (!MENU_MNEMONICS.has(mnemonic)) return;
      e.preventDefault();
      e.stopPropagation();
      invoke("open_menu", { mnemonic }).catch(showError);
    },
    true,
  );
}

try {
  const width = localStorage.getItem("sidebarWidth");
  if (width) sidebar.style.width = width;
  selectTab(localStorage.getItem("sidebarTab") ?? "outline");
} catch {}

// ---------- About ----------

async function showAbout() {
  const version = await getVersion();
  await message(
    `${APP_NAME} ${version}\n\n` +
      "A Markdown editor that shows formatting as you type, with a heading outline, " +
      "recent files and table editing.\n\n" +
      "https://github.com/mhenry1384\n\n" +
      "Licensed under the GNU General Public License v3 (GPLv3).",
    { title: `About ${APP_NAME}`, kind: "info" },
  );
}

// ---------- Startup ----------

async function init() {
  // A second launch (e.g. double-clicking a .md file) is forwarded here by the
  // single-instance plugin.
  await listen("open-file", (event) => enqueue(() => openFile(event.payload)));

  // Custom items of the native menu (see build_menu in lib.rs).
  await listen("menu", (event) => {
    if (event.payload === "new") enqueue(newFile);
    else if (event.payload === "open") enqueue(openWithDialog);
    else if (event.payload === "save") enqueue(() => saveCurrent({ explicit: true }));
    else if (event.payload === "paste-plain") pasteAsPlainText(view).then(() => view.focus()).catch(showError);
    else if (event.payload === "insert-table") insertTable(view);
    else if (event.payload === "about") showAbout().catch(showError);
    else if (FOCUS_TARGETS[event.payload]) FOCUS_TARGETS[event.payload]();
    else if (formatCommands[event.payload]) {
      formatCommands[event.payload](view);
      view.focus();
    }
  });

  recentFiles = await invoke("get_recent_files");
  renderFiles();
  renderOutline();
  updateChrome();

  const initial = await invoke("take_initial_file");
  const toOpen = initial ?? recentFiles[0];
  if (toOpen) await enqueue(() => openFile(toOpen));

  loadSpellchecker(view).catch(showError);
}

init().catch(showError);
