import { describe, expect, it, vi } from "vitest";
import { namespaceViewDom, logicalElementId } from "./view-dom";
import { buildToc, scrollToAnchor } from "./toc-dom";
import { prepareCustomCss } from "$lib/custom-css/scope";

describe("independent document DOM", () => {
  it("多数の小さなSVGで文書全体のIDマップを繰り返し複製しない", () => {
    const root = document.createElement("main");
    const svgCount = 50;
    root.innerHTML = Array.from(
      { length: svgCount },
      (_, index) => `<svg><rect id="n${index}"/><use href="#n${index}"/></svg>`
    ).join("");
    const NativeMap = Map;
    let copiedEntries = 0;
    class CountingMap extends NativeMap {
      constructor(input?: Iterable<readonly [unknown, unknown]> | null) {
        super();
        if (input) for (const [key, value] of input) this.set(key, value);
        if (input instanceof NativeMap) copiedEntries += input.size;
      }
    }
    vi.stubGlobal("Map", CountingMap);
    try {
      namespaceViewDom(root, "view-pane");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(copiedEntries).toBeLessThanOrEqual(svgCount * 4);
    expect(root.querySelector("use")?.getAttribute("href")).toBe("#view-pane-n0");
  });
  it("重複用サフィックスと同じ論理IDがあってもDOM IDを衝突させない", () => {
    const root = document.createElement("main");
    root.innerHTML = '<p id="a">1</p><p id="a">2</p><p id="a--duplicate-1">3</p>';
    namespaceViewDom(root, "view-pane");
    const ids = [...root.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe("view-pane-a--duplicate-1");
    namespaceViewDom(root, "view-pane");
    expect([...root.querySelectorAll("[id]")].map((element) => element.id)).toEqual(ids);
  });
  it("見出し・脚注・SVG参照を分離し、元のアンカーから対象ルート内へ移動できる", () => {
    const roots = [document.createElement("main"), document.createElement("main")];
    for (const [index, root] of roots.entries()) {
      root.innerHTML =
        '<h1>Intro</h1><p id="fn1">Footnote</p><a href="#fn1">1</a><svg><defs><linearGradient id="gradient"></linearGradient></defs><rect fill="url(#gradient)"></rect><use href="#gradient"></use></svg>';
      buildToc(root);
      namespaceViewDom(root, `view-pane${index}`);
    }
    const ids = roots.flatMap((root) => [...root.querySelectorAll("[id]")].map((el) => el.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(roots[1].querySelector("rect")?.getAttribute("fill")).toBe("url(#view-pane1-gradient)");
    expect(roots[1].querySelector("use")?.getAttribute("href")).toBe("#view-pane1-gradient");
    expect(roots[1].querySelector("a")?.getAttribute("href")).toBe("#fn1");
    const heading = roots[1].querySelector("h1")!;
    heading.scrollIntoView = vi.fn();
    scrollToAnchor(roots[1], "intro");
    expect(heading.scrollIntoView).toHaveBeenCalledOnce();
    expect(logicalElementId(heading)).toBe("intro");
    namespaceViewDom(roots[1], "view-pane1");
    expect(heading.id).toBe("view-pane1-intro");
  });

  it("CSSのID・id属性・escape・疑似クラスを構文として変換し、宣言値を維持する", async () => {
    const generate = await prepareCustomCss(
      '#intro, :is(#章, [id="intro"]) > a:not(#end), #a\\:b { content: "#intro"; color: red; }'
    );
    const css = generate("pane");
    expect(css).toContain("#view-pane-intro");
    expect(css).toContain('[data-logical-id="intro"]');
    expect(css).toContain("#view-pane-a\\:b");
    expect(css).toContain('content: "#intro"');
    expect(css).toContain('[data-view-scope="pane"]');
    expect(generate("second")).toContain("#view-second-intro");
  });
});
