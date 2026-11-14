import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import dialectPlugin from "$lib/plugins/markdown-dialects";
import { sanitizeHtml } from "./sanitize";

function render(markdown: string): string {
  const md = new MarkdownIt();
  dialectPlugin.extendMarkdownIt?.(md);
  return sanitizeHtml(md.render(markdown));
}

describe("Markdown dialects", () => {
  it("脚注と本文へ戻るリンクを描画する", () => {
    const html = render("本文[^note]\n\n[^note]: 脚注本文");

    expect(html).toContain('class="footnote-ref"');
    expect(html).toContain('href="#fn1"');
    expect(html).toContain('id="fn1"');
    expect(html).toContain('class="footnote-backref"');
    expect(html).toContain("脚注本文");
  });

  it.each(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"])(
    "GitHub Alert %sを描画する",
    (type) => {
      const html = render(`> [!${type}]\n> Alert body`);

      expect(html).toContain(`class="callout callout-${type.toLowerCase()}"`);
      expect(html).toContain('class="callout-title"');
      expect(html).toContain("<svg");
      expect(html).toContain("Alert body");
    }
  );

  it("定義リストを描画する", () => {
    const html = render("Term\n: Definition");

    expect(html).toContain("<dl>");
    expect(html).toContain("<dt>Term</dt>");
    expect(html).toContain("<dd>Definition</dd>");
  });

  it("定義リストと脚注・Calloutを同じ文書で描画する", () => {
    const html = render(
      "Term\n: **Definition**[^note]\n\n[^note]: Footnote\n\n> [!NOTE] Title\n> Body"
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector("dl dt")?.textContent).toBe("Term");
    expect(container.querySelector("dl dd strong")?.textContent).toBe("Definition");
    expect(container.querySelector(".footnote-ref a")?.getAttribute("href")).toBe("#fn1");
    expect(container.querySelector("#fn1")?.textContent).toContain("Footnote");
    expect(container.querySelector(".callout-note .callout-title-text")?.textContent).toBe("Title");
  });
});
