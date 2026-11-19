function decodeResourceSyntax(code: string): string {
  const text = document.createElement("textarea");
  text.innerHTML = code;
  const unicode = text.value.replace(
    /\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,
    (_, wide: string, short: string) => String.fromCharCode(parseInt(wide ?? short, 16))
  );
  return unicode
    .replace(/\\\r?\n/g, "")
    .replace(/\\([0-9a-f]{1,6}\s?|[^\r\n])/gi, (_, escape: string) => {
      if (/^[0-9a-f]/i.test(escape)) {
        const point = parseInt(escape.trim(), 16);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
      }
      return escape;
    });
}

const embeddedImage = /^data:image\/[\w.+-]+[;,]/i;

/** Recognize flowchart image nodes that need permission before drawing. */
export function hasExternalImageNode(code: string): boolean {
  // Consume quoted labels and comments before looking at node metadata.
  for (const [token] of decodeResourceSyntax(code).matchAll(
    /"[^"\r\n]*"|%%[^\r\n]*|@\{[^{}]*\}/g
  )) {
    if (!token.startsWith("@{")) continue;
    for (const [, key, rawValue] of token
      .slice(2, -1)
      .matchAll(/(?:^|,)\s*["']?([\w-]+)["']?\s*:\s*("[^"]*"|'[^']*'|[^,]*)/g)) {
      if (key.toLowerCase() !== "img") continue;
      const source = rawValue.trim().replace(/^["']|["']$/g, "");
      if (source && !embeddedImage.test(source)) return true;
    }
  }
  return false;
}

/** History retains its stricter preflight for resource-bearing syntax. */
export function hasDiagramResources(code: string): boolean {
  return /(?:url|(?:-webkit-)?image-set|image)\s*\(|@import\b|["']?img["']?\s*:|<\s*(?:img|image|feimage|video|source)\b/i.test(
    decodeResourceSyntax(code)
  );
}

/** Check the isolated renderer's output before moving it to the main document. */
export function hasSvgResources(svg: string): boolean {
  const template = document.createElement("template");
  template.innerHTML = svg;
  const resourceElements =
    "audio, video, source, track, link, iframe, object, embed, script, meta, base, animate, set";
  const resourceAttributes = new Set(["src", "srcset", "poster", "background", "ping"]);
  const referencesResource = (value: string) => {
    // Internal SVG paint and marker references stay within the same SVG.
    const css = value.replace(/url\(\s*(['"]?)#[\w:-]+\1\s*\)/gi, "");
    return /\\|@import\b|(?:url|(?:-webkit-)?image-set|image|src)\s*\(/i.test(css);
  };

  if (template.content.querySelector(resourceElements)) return true;
  for (const element of template.content.querySelectorAll("*")) {
    if (element.localName === "style" && referencesResource(element.textContent ?? "")) return true;
    for (const { name, value } of element.attributes) {
      if (name.startsWith("aria-") || name.startsWith("data-")) continue;
      const imageSource =
        (element.localName === "img" && name === "src") ||
        ((element.localName === "image" || element.localName === "feImage") &&
          (name === "href" || name === "xlink:href"));
      if (imageSource && embeddedImage.test(value)) continue;
      if (resourceAttributes.has(name)) return true;
      if (name === "href" || name === "xlink:href") {
        if (element.localName !== "a" && !value.startsWith("#")) return true;
      } else if (referencesResource(value)) {
        return true;
      }
    }
  }
  return false;
}
