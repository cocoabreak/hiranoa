import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import component from "./MarkdownViewer.svelte?raw";
import { CALLOUT_STYLES } from "$lib/plugins/markdown-dialects/styles";
const source = component + readFileSync("src/lib/markdown/body.css", "utf8");

describe("MarkdownViewer styles", () => {
  it("空のMarkdownでも文書未選択表示へ戻さない", () => {
    expect(source).toContain("{:else if activeContent}");
    expect(source).not.toContain("{:else if renderedHtml}");
    expect(source).not.toContain('if (result.html === "") return');
  });

  it("実文書の表示中だけコンテンツ領域を選択可能にする", () => {
    expect(source).toContain("class:selectable-content={!isLoading && !!activeContent}");
  });

  it("Tailwindのリセット後も通常・入れ子・タスクリストの記号を定義する", () => {
    expect(source).toMatch(/\.markdown-body ul\s*{\s*list-style-type: disc;\s*}/);
    expect(source).toMatch(/\.markdown-body ol\s*{\s*list-style-type: decimal;\s*}/);
    expect(source).toMatch(/\.markdown-body ul ul\s*{\s*list-style-type: circle;\s*}/);
    expect(source).toMatch(/\.markdown-body ul ul ul\s*{\s*list-style-type: square;\s*}/);
    expect(source).toMatch(/\.markdown-body \.task-list-item\s*{\s*list-style: none;/);
  });

  it("脚注と定義リストのスタイルを定義する", () => {
    expect(source).toContain(".markdown-body dl");
    expect(source).toContain(".markdown-body dt");
    expect(source).toContain(".markdown-body dd");
    expect(source).toContain(".markdown-body .footnotes");
    expect(source).toContain(".markdown-body .footnote-backref");
  });

  it("Calloutのテーマ・折りたたみ・印刷スタイルを含む", () => {
    expect(CALLOUT_STYLES).toContain(".markdown-body .callout");
    expect(CALLOUT_STYLES).toContain(".dark .markdown-body .callout");
    expect(CALLOUT_STYLES).toContain("details.callout > summary.callout-title");
    expect(CALLOUT_STYLES).toContain(".callout-danger");
    expect(CALLOUT_STYLES).toContain("details.callout:not([open]) > :not(summary)");
    expect(CALLOUT_STYLES).toContain("display: block !important");
  });

  it("MermaidのノードラベルだけをMermaid既定の行高へ戻す", () => {
    expect(source).toMatch(
      /\.markdown-body \.mermaid-rendered \.nodeLabel p\s*{\s*line-height: 1\.5;\s*}/
    );
    expect(source).toMatch(
      /\.markdown-body p\s*{\s*margin-bottom: 1rem;\s*line-height: 1\.75;\s*}/
    );
  });
});
