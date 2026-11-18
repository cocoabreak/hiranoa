import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderAllPending, setupLazyMermaid } from "./post";

const { initializeMock, renderMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  renderMock: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMock,
    render: renderMock,
  },
}));

describe("Mermaid post renderer", () => {
  beforeEach(() => {
    initializeMock.mockClear();
    renderMock.mockReset();
    document.body.innerHTML = "";
  });

  it("正常な図をSVGとして残し、一時DOMだけを削除する", async () => {
    renderMock.mockImplementation(async (id: string) => {
      const temporary = document.createElement("div");
      temporary.id = `d${id}`;
      document.body.appendChild(temporary);
      return { svg: `<svg id="${id}" role="graphics-document"><text>Diagram</text></svg>` };
    });

    const container = document.createElement("main");
    const diagram = document.createElement("div");
    diagram.className = "mermaid-pending";
    diagram.dataset.code = encodeURIComponent("flowchart TD\n  A-->B");
    container.appendChild(diagram);
    document.body.appendChild(container);

    await renderAllPending(container, "ja");

    const renderId = renderMock.mock.calls[0][0] as string;
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", suppressErrorRendering: true })
    );
    expect(initializeMock.mock.calls[0][0].secure).toEqual(
      expect.arrayContaining([
        "secure",
        "securityLevel",
        "themeCSS",
        "themeVariables",
        "fontFamily",
      ])
    );
    expect(document.getElementById(`d${renderId}`)).not.toBeInTheDocument();
    expect(diagram).toHaveClass("mermaid-rendered");
    expect(diagram.querySelector("svg")).toHaveAttribute("id", renderId);
    expect(diagram.querySelector("svg")).toHaveTextContent("Diagram");
    expect(diagram.querySelector(".lightbox-trigger-button")).toBeInTheDocument();
  });

  it("構文エラー時にMermaidの一時DOMを本文外へ残さない", async () => {
    renderMock.mockImplementation(async (id: string) => {
      const temporary = document.createElement("div");
      temporary.id = `d${id}`;
      temporary.innerHTML = '<svg><text class="error-text">Syntax error in text</text></svg>';
      document.body.appendChild(temporary);
      throw new Error("Parse error");
    });

    const container = document.createElement("main");
    const diagram = document.createElement("div");
    diagram.className = "mermaid-pending";
    diagram.dataset.code = encodeURIComponent("flowchart TD\n  A-->");
    container.appendChild(diagram);
    document.body.appendChild(container);

    await renderAllPending(container, "ja");

    expect(document.body.querySelector(".error-text")).not.toBeInTheDocument();
    expect(diagram).toHaveClass("mermaid-error-container");
    expect(diagram).toHaveTextContent("Mermaid レンダリング失敗");
    expect(diagram.querySelector("pre")).toHaveTextContent("flowchart TD");
  });
  it("履歴のCSS資源指定を一時DOM生成前に拒否する", async () => {
    const container = document.createElement("main");
    const diagram = document.createElement("div");
    diagram.className = "mermaid-pending";
    diagram.dataset.code = encodeURIComponent(
      '%%{init: {"themeCSS":".node {fill:url(https://example.invalid/probe)}"}}%%\nflowchart TD\nA[probe]'
    );
    container.append(diagram);
    await renderAllPending(container, "en", false, undefined, true);
    expect(renderMock).not.toHaveBeenCalled();
    expect(diagram).toHaveClass("mermaid-error-container");
  });

  it("位置復元等で購読を作り直しても処理中の図を再試行し、旧結果で上書きしない", async () => {
    type ObserverCallback = (entries: { target: Element; isIntersecting: boolean }[]) => void;
    let intersect!: ObserverCallback;
    class Observer {
      constructor(callback: ObserverCallback) {
        intersect = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    const container = document.createElement("main");
    container.innerHTML = '<div class="mermaid-pending" data-code="graph%20LR%3B%20A--%3EB"></div>';
    const diagram = container.firstElementChild as HTMLElement;
    document.body.append(container);
    let finish!: (value: { svg: string }) => void;
    renderMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const enter = () => intersect([{ target: diagram, isIntersecting: true }]);
    try {
      const stop = setupLazyMermaid(container, "ja");
      enter();
      await vi.waitFor(() => expect(renderMock).toHaveBeenCalledOnce());
      stop();
      expect(diagram).toHaveClass("mermaid-pending");
      renderMock.mockResolvedValueOnce({ svg: "<svg><text>New</text></svg>" });
      const stopNext = setupLazyMermaid(container, "ja");
      enter();
      await vi.waitFor(() => expect(diagram).toHaveClass("mermaid-rendered"));
      finish({ svg: "<svg><text>Old</text></svg>" });
      await Promise.resolve();
      await Promise.resolve();
      expect(diagram).toHaveTextContent("New");
      expect(diagram).not.toHaveTextContent("Old");
      stopNext();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
