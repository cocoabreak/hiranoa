import { mkdirSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import path from "node:path";

const LARGE_MARKDOWN_BYTES = 5 * 1024 * 1024;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZipEntries(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [entryName, content] of entries) {
    const name = Buffer.from(entryName);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    const localEntry = Buffer.concat([local, name, data]);
    locals.push(localEntry);
    centrals.push(Buffer.concat([central, name]));
    offset += localEntry.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(
    centrals.reduce((size, entry) => size + entry.length, 0),
    12
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function fixedSizeMarkdown(size, heading) {
  const prefix = Buffer.from(`# ${heading}\n\n`);
  return Buffer.concat([prefix, Buffer.alloc(size - prefix.length, 0x78)]);
}

export function createFixtures(root) {
  mkdirSync(root, { recursive: true });
  const basic = path.join(root, "basic.md");
  const validMermaid = path.join(root, "valid-mermaid.md");
  const invalidMermaid = path.join(root, "invalid-mermaid.md");
  const math = path.join(root, "math.md");
  const compatibility = path.join(root, "compatibility.md");
  const belowLimit = path.join(root, "below-limit.md");
  const atLimit = path.join(root, "at-limit.md");
  const archive = path.join(root, "notes.zip");

  writeFileSync(
    basic,
    `# Smoke marker\n\nsmoke-marker\n\n${Array.from({ length: 300 }, (_, i) => `## Section ${i}\n\nline ${i}`).join("\n\n")}\n`
  );
  writeFileSync(
    validMermaid,
    [
      "# Mermaid",
      "",
      "```mermaid",
      "graph TD",
      "  F[Filter: SetCharacterEncodingFilter UTF-8] --> S[ActionServlet: action]",
      "  Rounded(Long rounded node label<br/>with explicit break)",
      "  Diamond{Diamond node label<br/>with explicit break}",
      "  Stadium([Stadium node label<br/>with explicit break])",
      "  Single[Single line]",
      "```",
      "",
      "regular paragraph",
      "",
    ].join("\n")
  );
  writeFileSync(invalidMermaid, "# Broken Mermaid\n\n```mermaid\ngraph TD\n  A -- ???\n```\n");
  writeFileSync(
    math,
    [
      "# Math",
      String.raw`Inline: $\frac{1}{2} + \sqrt{2} + \mathbb{R} + \mathbf{x} + \mathit{y}$`,
      "$$",
      String.raw`\left(\sum_{i=1}^{n} i\right) = \frac{n(n+1)}{2}`,
      "$$",
      "$$",
      String.raw`\boldsymbol{\alpha} + \mathcal{ABC} + \mathfrak{xyz} + \mathsf{Sans} + \mathtt{Code}`,
      "$$",
      "$$",
      String.raw`\left\{\frac{\displaystyle\int_0^\infty e^{-x^2}\,dx}{\sqrt{\frac{1}{1+x^2}}}\right\} \quad \bigg( \Bigg[ \sum \Bigg] \bigg)`,
      "$$",
      "```mermaid",
      "flowchart LR",
      String.raw`  A["$$\frac{1}{2}$$"] --> B["Math"]`,
      "```",
    ].join("\n\n")
  );
  writeFileSync(belowLimit, fixedSizeMarkdown(LARGE_MARKDOWN_BYTES - 1, "Below limit"));
  const imageReferences =
    "![Supported format](images/pixel.GIF)\n\n![Unsupported format](images/pixel.txt)\n";
  writeFileSync(
    compatibility,
    [
      "# Markdown compatibility",
      "## 日本語見出し",
      "## 日本語見出し",
      "Term\n: **Definition**[^note]",
      "[^note]: Footnote body",
      "> [!NOTE] Callout title\n> Callout body",
      "- [x] Completed task",
      ":smile:",
      String.raw`$\frac{1}{2}$`,
      "www.example.com user@example.com https://example.com/。次の文",
      "[local](guide/index.md) [[guide/index|Local Wiki]]",
      '<map name="compatibility-map"><area alt="Local guide" href="guide/index.md"></map>',
      imageReferences,
    ].join("\n\n")
  );
  writeFileSync(atLimit, fixedSizeMarkdown(LARGE_MARKDOWN_BYTES, "At limit"));
  const image = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const imageEntries = [
    ["images/pixel.GIF", image],
    ["images/pixel.txt", image],
  ];
  mkdirSync(path.join(root, "images"), { recursive: true });
  for (const [name, bytes] of imageEntries) writeFileSync(path.join(root, name), bytes);
  writeFileSync(
    archive,
    createStoredZipEntries([
      ["inside.md", `# Archive\n\nzip-smoke-marker\n\n${imageReferences}`],
      ...imageEntries,
    ])
  );
  const directoryLinks = path.join(root, "directory-links.md");
  const directoryArchive = path.join(root, "directory-links.zip");
  const directoryEntries = [
    [
      "directory-links.md",
      "# Directory links\n\n[slash](guide/#details) [bare](guide) [direct](guide/index.md) [missing](empty/) [image](image.png)\n",
    ],
    [
      "guide/index.md",
      `# Directory index\n\ndirectory-index-marker\n\n${"paragraph\n\n".repeat(100)}## Details\n\ndirectory-anchor-marker\n\n[self](./#details) [back](../directory-links.md)\n`,
    ],
    ["empty/README.md", "# No fallback"],
    ["image.png", "not-an-image"],
  ];
  for (const name of ["read me", "日本語 資料", "literal%20name"]) {
    directoryEntries[0][1] += `\n[encoded](${encodeURIComponent(name)}/)\n`;
    directoryEntries.push([
      `${name}/index.md`,
      "# Encoded directory\n\n[back](../directory-links.md)\n",
    ]);
  }
  for (const [name, content] of directoryEntries) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  writeFileSync(directoryArchive, createStoredZipEntries(directoryEntries));
  return {
    basic,
    validMermaid,
    invalidMermaid,
    math,
    compatibility,
    belowLimit,
    atLimit,
    archive,
    directoryLinks,
    directoryArchive,
  };
}
