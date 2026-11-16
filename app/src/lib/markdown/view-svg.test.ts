import { describe, expect, it } from "vitest";
import { namespaceGeneratedSvg } from "./view-svg";
import { namespaceViewDom } from "./view-dom";

describe("late renderer SVG", () => {
  it("論理IDが他要素の旧DOM IDに一致しても、再処理で参照先を変えない", () => {
    const root = document.createElement("main");
    root.innerHTML =
      '<svg id="diagram"><style>#diagram #node { fill: red }</style><rect id="view-primary-node" /><circle id="node" /><use href="#node" /></svg>';
    namespaceGeneratedSvg(root, "view-primary");
    const target = root.querySelector("circle")!.id;
    const before = root.querySelector("style")!.textContent;
    namespaceViewDom(root, "view-primary");
    expect(root.querySelector("use")?.getAttribute("href")).toBe(`#${target}`);
    expect(root.querySelector("style")!.textContent).toBe(before);
    expect(root.querySelector("style")!.textContent).toContain(`#${target}`);
  });
  it("本文と同名のIDを持つSVGでも参照先を局所化し、後の採番変更へCSSを追従させる", () => {
    const root = document.createElement("main");
    root.className = "markdown-body";
    root.innerHTML =
      '<p id="node">body</p><div><svg id="diagram"><style>#diagram #node { fill: red }</style><rect id="node" /><use href="#node" /></svg></div>';
    const diagram = root.lastElementChild as HTMLElement;
    namespaceGeneratedSvg(diagram, "view-pane");
    const node = diagram.querySelector("rect")!;
    expect(node.id).not.toBe(root.querySelector("p")!.id);
    expect(diagram.querySelector("style")?.textContent).toContain(`#${node.id}`);
    expect(diagram.querySelector("use")?.getAttribute("href")).toBe(`#${node.id}`);
    const extra = document.createElement("p");
    extra.id = "node";
    root.prepend(extra);
    namespaceViewDom(root, "view-pane");
    const ids = [...root.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(diagram.querySelector("style")?.textContent).toContain(`#${node.id}`);
    expect(diagram.querySelector("use")?.getAttribute("href")).toBe(`#${node.id}`);
  });
  it("内部CSSと参照属性を一緒に変換し、後の位置復元でもIDを変更しない", () => {
    const root = document.createElement("main");
    root.innerHTML =
      '<div><svg id="diagram"><style>#diagram .node { fill: red } #diagram #node { marker-end: url(#arrow) }</style><defs><marker id="arrow"></marker></defs><rect id="node" class="node" /></svg></div>';
    const diagram = root.firstElementChild as HTMLElement;
    namespaceGeneratedSvg(diagram, "view-pane");
    expect(root.querySelector("svg")?.id).toBe("view-pane-diagram");
    expect(root.querySelector("style")?.textContent).toContain(
      "#view-pane-diagram #view-pane-node"
    );
    expect(root.querySelector("style")?.textContent).toContain("url(#view-pane-arrow)");
    expect(root.querySelector("svg")?.getAttribute("data-logical-id")).toBe("diagram");
    const before = root.innerHTML;
    namespaceViewDom(root, "view-pane");
    expect(root.innerHTML).toBe(before);
  });
});
