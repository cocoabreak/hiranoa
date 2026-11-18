/** Mermaid creates temporary live DOM while measuring diagrams. Reject resource
 * syntax before rendering, including CSS escapes, rather than stripping it later. */
export function assertHistoryDiagramResources(code: string): void {
  const text = document.createElement("textarea");
  text.innerHTML = code;
  const unicode = text.value.replace(
    /\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,
    (_, wide: string, short: string) => String.fromCharCode(parseInt(wide ?? short, 16))
  );
  const decoded = unicode
    .replace(/\\\r?\n/g, "")
    .replace(/\\([0-9a-f]{1,6}\s?|[^\r\n])/gi, (_, escape: string) => {
      if (/^[0-9a-f]/i.test(escape)) {
        const point = parseInt(escape.trim(), 16);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
      }
      return escape;
    });
  if (
    /(?:url|(?:-webkit-)?image-set|image)\s*\(|@import\b|["']?img["']?\s*:|<\s*(?:img|image|feimage|video|source)\b/i.test(
      decoded
    )
  )
    throw new Error("Resource references are not supported in history diagrams");
}
