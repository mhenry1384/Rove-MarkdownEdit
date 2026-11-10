// Converts between a document's heading and its file name, for first saves.

const MAX_NAME_LENGTH = 120;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A file name (without extension) made from heading text, or "" if none is usable. */
export function fileStemFromHeading(text) {
  const stem = text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/^[. ]+|[. ]+$/g, "");
  return RESERVED_WINDOWS_NAME.test(stem) ? "" : stem;
}

/** The heading text for a file name: the name without its extension. */
export function headingFromFileName(name) {
  return name.replace(/\.[^.]*$/, "").trim();
}
