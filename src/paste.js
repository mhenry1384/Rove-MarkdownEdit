// Pasting: formatted text arrives as Markdown, with a command for plain text.

import { EditorView, keymap } from "@codemirror/view";
import { readText } from "@tauri-apps/plugin-clipboard-manager";

import { markdownForPaste } from "./html-to-markdown.js";
import { pastedTextForListItem } from "./list-editing.js";

function insertPasted(view, text) {
  const joined = pastedTextForListItem(view.state, text) ?? text;
  view.dispatch(view.state.replaceSelection(joined), { userEvent: "input.paste", scrollIntoView: true });
}

export async function pasteAsPlainText(view) {
  insertPasted(view, await readText());
}

/** `onError` is told if the clipboard couldn't be read. */
export function richPaste(onError) {
  return [
    keymap.of([
      {
        key: "Mod-Shift-v",
        run(view) {
          pasteAsPlainText(view).catch(onError);
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      paste(event, view) {
        const markdown = markdownForPaste(view.state, event.clipboardData?.getData("text/html") ?? "");
        if (markdown === null) return false;
        event.preventDefault();
        insertPasted(view, markdown);
        return true;
      },
    }),
  ];
}
