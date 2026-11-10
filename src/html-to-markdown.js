// Converts HTML from the clipboard to Markdown, for pasting from web pages.

import TurndownService from "turndown";
import { syntaxTree } from "@codemirror/language";

// Markup that plain text can't express. Without any of it (code copied from
// VS Code is only styled <div>s and <span>s), the plain text is the better paste.
const MEANINGFUL_MARKUP = /<(?:a\s[^>]*href\s*=|(?:strong|b|em|i|h[1-6]|ul|ol|table|img|blockquote|pre|code|del|s|strike)[\s>/])/i;

const collapse = (text) => text.replace(/\s+/g, " ").trim();
const linkTarget = (url) => url.replace(/([()])/g, "\\$1").replace(/ /g, "%20");

/** The <table> around `node` (or `node` itself), if it holds data and isn't page layout. */
function dataTable(node) {
  let table = node;
  while (table && table.nodeName !== "TABLE") table = table.parentNode;
  if (!table || table.querySelector("table")) return null;
  const firstRow = table.querySelector("tr");
  return firstRow && cellCount(firstRow) > 1 ? table : null;
}

function cellCount(row) {
  return Array.from(row.children).filter((cell) => /^T[DH]$/.test(cell.nodeName)).length;
}

const inDataTable = (names) => (node) => names.includes(node.nodeName) && !!dataTable(node);

const turndown = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

// Underscores inside a word don't need escaping, and snake\_case is hard to read.
const escapeText = turndown.escape;
turndown.escape = (text) => escapeText.call(turndown, text).replace(/(\w)\\_(?=\w)/g, "$1_");

turndown.remove(["style", "script", "noscript", "title", "meta", "link", "svg", "template"]);

turndown.addRule("link", {
  filter: "a",
  // Links often wrap blocks, whose line breaks would end the link early.
  replacement(content, node) {
    const text = collapse(content);
    const href = (node.getAttribute("href") ?? "").trim();
    if (!text || !href || /^javascript:/i.test(href)) return text;
    return `[${text}](${linkTarget(href)})`;
  },
});

turndown.addRule("image", {
  filter: "img",
  replacement(_content, node) {
    const alt = collapse(node.getAttribute("alt") ?? "");
    const src = (node.getAttribute("src") ?? "").trim();
    return !src || /^data:/i.test(src) ? alt : `![${alt}](${linkTarget(src)})`;
  },
});

// Google Docs wraps whole documents in <b style="font-weight:normal">.
turndown.addRule("notBold", {
  filter: (node) =>
    ["B", "STRONG"].includes(node.nodeName) && /font-weight:\s*(normal|[1-4]00)\b/i.test(node.getAttribute("style") ?? ""),
  replacement: (content) => content,
});

turndown.addRule("strikethrough", {
  filter: ["del", "s", "strike"],
  replacement: (content) => (content.trim() ? `~~${content}~~` : ""),
});

// One space after the marker, where turndown would pad it to four columns.
turndown.addRule("listItem", {
  filter: "li",
  replacement(content, node, options) {
    const list = node.parentNode;
    const number = (Number(list.getAttribute?.("start")) || 1) + Array.from(list.children).indexOf(node);
    const marker = list.nodeName === "OL" ? `${number}. ` : `${options.bulletListMarker} `;
    const body = content.trim().replace(/\n(?=[^\n])/g, `\n${" ".repeat(marker.length)}`);
    return `${marker}${body}${node.nextSibling ? "\n" : ""}`;
  },
});

// Also catches a <pre> with no <code> inside, and keeps the code's language.
turndown.addRule("codeBlock", {
  filter: "pre",
  replacement(_content, node) {
    const text = node.textContent.replace(/\n$/, "");
    const language = /\blang(?:uage)?-([\w+-]+)/.exec(`${node.querySelector("code")?.className ?? ""} ${node.className}`)?.[1] ?? "";
    const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
  },
});

// Every data table becomes a Markdown table, using its first row as the header
// because Markdown requires one. Spreadsheets don't mark a header row in HTML.
turndown.addRule("tableCell", {
  filter: inDataTable(["TD", "TH"]),
  replacement: (content) => `| ${collapse(content).replace(/\|/g, "\\|")} `,
});

turndown.addRule("tableRow", {
  filter: inDataTable(["TR"]),
  replacement(content, node) {
    const isFirst = dataTable(node).querySelector("tr") === node;
    return `${content}|\n${isFirst ? `${"| --- ".repeat(cellCount(node))}|\n` : ""}`;
  },
});

turndown.addRule("tableSection", {
  filter: inDataTable(["THEAD", "TBODY", "TFOOT"]),
  replacement: (content) => content,
});

turndown.addRule("table", {
  filter: inDataTable(["TABLE"]),
  replacement: (content) => `\n\n${content.trim()}\n\n`,
});

/** Markdown for `html`, or "" if it has nothing worth keeping over plain text. */
export function htmlToMarkdown(html) {
  if (!MEANINGFUL_MARKUP.test(html)) return "";
  return turndown.turndown(html).replace(/\u00a0/g, " ").trim();
}

function cursorIsIn(state, names) {
  for (let node = syntaxTree(state).resolveInner(state.selection.main.from); node; node = node.parent) {
    if (names.includes(node.name)) return true;
  }
  return false;
}

/** What to paste for clipboard `html` at the cursor, or null to paste plain text. */
export function markdownForPaste(state, html) {
  if (!html || cursorIsIn(state, ["FencedCode", "CodeBlock", "InlineCode"])) return null;
  let markdown;
  try {
    markdown = htmlToMarkdown(html);
  } catch (err) {
    console.error(err);
    return null;
  }
  if (!markdown || (markdown.includes("\n") && cursorIsIn(state, ["Table"]))) return null;
  return markdown;
}
