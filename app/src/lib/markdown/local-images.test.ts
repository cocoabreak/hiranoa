import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRef, DocumentSourceInfo } from "$lib/types";
import { hydrateLocalImages } from "./local-images";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const documentRef: DocumentRef = { sourceId: "source-1", path: "readme.md" };
const source: DocumentSourceInfo = {
  id: "source-1",
  kind: "native",
  label: "notes",
  nativePath: "D:/notes",
  capabilities: {
    watch: "entries",
    externalEditor: true,
    respectGitignore: true,
    fullTextSearch: true,
    wikiLinks: true,
  },
};

describe("hydrateLocalImages", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("同じパスを一度だけ読み、複数imgへ共有する", async () => {
    invokeMock.mockImplementation(async (_command: string, args: { document: DocumentRef }) => {
      return `data:image/png;base64,${args.document.path}`;
    });
    const container = document.createElement("div");
    container.innerHTML = '<img src="./same.png"><img src="./same.png"><img src="./other.png">';

    hydrateLocalImages(container, documentRef, source);

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources[0]).toBe(sources[1]);
    expect(sources[2]).not.toBe(sources[0]);
  });

  it("同時読込を4件までに制限する", async () => {
    const resolvers: (() => void)[] = [];
    invokeMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => resolvers.push(() => resolve("data:image/png;base64,x")))
    );
    const container = document.createElement("div");
    container.innerHTML = Array.from(
      { length: 10 },
      (_, index) => `<img src="./${index}.png">`
    ).join("");

    const { cancel } = hydrateLocalImages(container, documentRef, source);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(4));
    resolvers.shift()?.();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(5));
    cancel();
    resolvers.forEach((resolve) => resolve());
  });

  it("キャンセル後に完了した結果をDOMへ反映しない", async () => {
    let resolveRead: ((value: string) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise<string>((resolve) => (resolveRead = resolve)));
    const container = document.createElement("div");
    container.innerHTML = '<img src="./image.png">';

    const { cancel } = hydrateLocalImages(container, documentRef, source);
    cancel();
    resolveRead?.("data:image/png;base64,x");
    await Promise.resolve();

    expect(container.querySelector("img")?.hasAttribute("src")).toBe(false);
  });

  it("文書単位のdata URL予算を超える画像をDOMへ保持しない", async () => {
    invokeMock.mockResolvedValue("data:image/png;base64,1234567890");
    const container = document.createElement("div");
    container.innerHTML = '<img src="./one.png"><img src="./two.png"><img src="./three.png">';

    hydrateLocalImages(container, documentRef, source, { maxDataUrlChars: 40 });

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    await vi.waitFor(() => {
      const hydrated = [...container.querySelectorAll("img")].filter((img) =>
        img.hasAttribute("src")
      );
      expect(hydrated.length).toBeLessThanOrEqual(1);
    });
  });

  it("HTML出力では同じdata URLを書き出す要素ごとに予算を消費する", async () => {
    const dataUrl = "data:image/png;base64,1234567890";
    invokeMock.mockResolvedValue(dataUrl);
    const template = document.createElement("template");
    template.innerHTML = '<img src="same.png"><img src="same.png">';
    const { done } = hydrateLocalImages(template.content, documentRef, source, {
      maxDataUrlChars: dataUrl.length,
      forExport: true,
    });
    await done;
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(template.content.querySelector("img[src]")).toBeNull();
  });

  it("HTML出力には画像として識別できないファイルのデータを含めない", async () => {
    invokeMock.mockResolvedValue("data:application/octet-stream;base64,AA==");
    const template = document.createElement("template");
    template.innerHTML = '<img src="file.txt" alt="Label">';
    await hydrateLocalImages(template.content, documentRef, source, { forExport: true }).done;
    expect(template.content.querySelector("img")?.outerHTML).toBe('<img alt="Label">');
  });

  it("大文字のURLスキームもローカル画像として解決しない", async () => {
    const template = document.createElement("template");
    template.innerHTML =
      '<img src="HTTPS://example.invalid/image.png"><img src="DATA:image/png;base64,AA==">';
    await hydrateLocalImages(template.content, documentRef, source, { forExport: true }).done;
    expect(invokeMock).not.toHaveBeenCalled();
    expect(template.content.querySelectorAll("img[src]")).toHaveLength(2);
  });
});
