import { describe, expect, it } from "vitest";
import { hasDiagramResources, hasExternalImageNode, hasSvgResources } from "./resources";

describe("Mermaid resource checks", () => {
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
      expect(hasDiagramResources(code)).toBe(true);
  });
  it("keeps ordinary diagrams and TeX labels", () => {
    expect(hasDiagramResources(String.raw`graph LR; A[Start] --> B["$$\frac{1}{2}$$"]`)).toBe(
      false
    );
    expect(hasExternalImageNode('flowchart LR\nA["img: in a label, image()"]')).toBe(false);
    expect(hasExternalImageNode('flowchart LR\nA["Example A@{ img: asset.svg }"]')).toBe(false);
    expect(hasExternalImageNode('flowchart LR\nA@{ shape: rect, label: "About img: " }')).toBe(
      false
    );
    expect(hasExternalImageNode('flowchart LR\nA@{ "img": "asset.svg" }')).toBe(true);
    expect(hasExternalImageNode('flowchart LR\nA@{ img: "data:image/png;base64,abc" }')).toBe(
      false
    );
  });

  it("allows references inside the generated SVG and rejects resource loading", () => {
    expect(hasSvgResources('<svg><path style="marker-end:url(#arrow)" /></svg>')).toBe(false);
    expect(hasSvgResources('<svg><image href="data:image/png;base64,abc" /></svg>')).toBe(false);
    expect(hasSvgResources('<svg><image href="https://example.invalid/image.png" /></svg>')).toBe(
      true
    );
    expect(
      hasSvgResources(
        "<svg><style>path { fill: url(https://example.invalid/image.svg) }</style></svg>"
      )
    ).toBe(true);
  });
});
