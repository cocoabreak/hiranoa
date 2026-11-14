import { describe, expect, it } from "vitest";
import { cancelMarkdownRender, renderMarkdown } from "./engine";
import { buildToc } from "./toc-dom";

const options = {
  renderers: {
    mermaid: false,
    katex: false,
    "markdown-dialects": false,
    "wiki-links": false,
  },
  codeTheme: "dark-plus",
  showLineNumbers: false,
};

describe("Markdown render cancellation", () => {
  it("明示キャンセル後はawait中のレンダリング結果を生成しない", async () => {
    const pending = renderMarkdown("# cancelled", options);

    cancelMarkdownRender();

    await expect(pending).resolves.toEqual({ html: "", frontmatter: null });
  });
});

describe("Markdown plugin integration", () => {
  it("裸のドメイン・メールの自動リンクを維持し、裸のIPはリンクしない", async () => {
    const result = await renderMarkdown(
      "www.example.com example.com user@example.com 127.0.0.1",
      options
    );
    const container = document.createElement("div");
    container.innerHTML = result.html;
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "http://www.example.com",
      "http://example.com",
      "mailto:user@example.com",
    ]);
  });

  it("自動リンクに日本語句読点を含めず、明示的な日本語パスは維持する", async () => {
    const result = await renderMarkdown(
      "https://example.com/。次の文\n\n[日本語](guide/日本語.md#見出し)",
      options
    );
    const container = document.createElement("div");
    container.innerHTML = result.html;
    const anchors = [...container.querySelectorAll("a")];
    expect(anchors[0].textContent).toBe("https://example.com/");
    expect(anchors[0].getAttribute("href")).toBe("https://example.com/");
    expect(container.textContent).toContain("。次の文");
    expect(anchors[1].getAttribute("href")).toBe(
      "guide/%E6%97%A5%E6%9C%AC%E8%AA%9E.md#%E8%A6%8B%E5%87%BA%E3%81%97"
    );
  });

  it("日本語見出しの重複IDを分離する", async () => {
    const result = await renderMarkdown("## 日本語見出し\n\n## 日本語見出し", options);
    const container = document.createElement("div");
    container.innerHTML = result.html;
    buildToc(container);
    const headings = [...container.querySelectorAll("h2")];
    expect(headings).toHaveLength(2);
    expect(headings[0].id).not.toBe("");
    expect(headings[1].id).not.toBe(headings[0].id);
  });

  it("Callout内部でMermaidとKaTeXを既存プラグイン順序のまま描画する", async () => {
    const result = await renderMarkdown(
      [
        "> [!note] Rich renderers",
        "> Inline math: $E = mc^2$",
        ">",
        "> ```mermaid",
        "> flowchart LR",
        ">   A --> B",
        "> ```",
      ].join("\n"),
      {
        ...options,
        renderers: {
          ...options.renderers,
          mermaid: true,
          katex: true,
          "markdown-dialects": true,
        },
      }
    );

    expect(result.html).toContain('class="callout callout-note"');
    expect(result.html).toContain('class="katex"');
    expect(result.html).toContain("mermaid-pending");
    expect(result.html).toContain('data-code="');
  });
});
