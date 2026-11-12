// Highlights the display line the cursor is on. CodeMirror's own active-line
// highlight covers the whole document line, which with line wrapping can span
// several display lines.

import { layer } from "@codemirror/view";

class LineMarker {
  constructor(left, top, width, height) {
    this.left = left;
    this.top = top;
    this.width = width;
    this.height = height;
  }

  draw() {
    const el = document.createElement("div");
    el.className = "cm-currentLine";
    this.update(el);
    return el;
  }

  update(el) {
    el.style.left = `${this.left}px`;
    el.style.top = `${this.top}px`;
    el.style.width = `${this.width}px`;
    el.style.height = `${this.height}px`;
    return true;
  }

  eq(o) {
    return o.left === this.left && o.top === this.top && o.width === this.width && o.height === this.height;
  }
}

function markers(view) {
  const range = view.state.selection.main;
  const coords = view.coordsAtPos(range.head, range.assoc < 0 ? -1 : 1);
  if (!coords) return [];

  // The marker's coordinates are relative to the scrolled content (see the
  // layer docs); the scroller's own rect gives that origin.
  const scroller = view.scrollDOM.getBoundingClientRect();
  const originX = scroller.left - view.scrollDOM.scrollLeft;
  const originY = scroller.top - view.scrollDOM.scrollTop;

  // The caret rect covers the glyphs only. The display line's box is one line
  // height tall, centred on them, and stays within the document line's block.
  const { node } = view.domAtPos(range.head);
  const lineEl = (node.nodeType === 1 ? node : node.parentElement)?.closest(".cm-line");
  const lineHeight = lineEl ? parseFloat(getComputedStyle(lineEl).lineHeight) : NaN;
  const block = view.lineBlockAt(range.head);
  const blockTop = view.documentTop + block.top;
  const blockBottom = blockTop + block.height;
  let top = blockTop;
  let bottom = blockBottom;
  if (lineHeight > 0) {
    const mid = (coords.top + coords.bottom) / 2;
    top = Math.max(blockTop, mid - lineHeight / 2);
    bottom = Math.min(blockBottom, mid + lineHeight / 2);
  }

  const content = view.contentDOM.getBoundingClientRect();
  return [new LineMarker(content.left - originX, top - originY, content.width, bottom - top)];
}

/** Style `.cm-currentLine` for the colour, and hide basicSetup's `.cm-activeLine`. */
export const currentLineHighlight = layer({
  above: false,
  class: "cm-currentLineLayer",
  markers,
  update: (update) => update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged,
});
