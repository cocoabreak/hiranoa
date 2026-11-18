import { describe, expect, it } from "vitest";
import { assertHistoryDiagramResources } from "./history-resources";

describe("history diagram resource preflight", () => {
  it("rejects CSS and image resources before Mermaid creates temporary DOM", () => {
    for (const code of [
      '%%{init: {"themeCSS":".node {fill:url(https://example.invalid/probe)}"}}%%',
      "flowchart TD\nclassDef probe fill:url(asset.svg);",
      String.raw`classDef probe fill:u\72l(https://example.invalid/probe);`,
      String.raw`classDef probe fill:\75\72\6c(https://example.invalid/probe);`,
      String.raw`%%{init: {"themeCSS":".node {fill:\u0075rl(https://example.invalid/probe)}"}}%%`,
      'A["<img src=https://example.invalid/probe>"]',
      'A["&lt;&#105;mg src=asset.png&gt;"]',
      '@import "https://example.invalid/probe";',
      'A@{ img: "asset.svg" }',
      'A@{ "img": "asset.svg" }',
      'image-set("asset.png" 1x)',
    ])
      expect(() => assertHistoryDiagramResources(code)).toThrow();
  });
  it("keeps ordinary diagrams and TeX labels", () => {
    expect(() =>
      assertHistoryDiagramResources(String.raw`graph LR; A[Start] --> B["$$\frac{1}{2}$$"]`)
    ).not.toThrow();
  });
});
