import { describe, it, expect } from "vitest";
import { indexText, locate, parseExport, serializeExport, type Annotation } from "./annotations";

function page(html: string) {
  const main = document.createElement("main");
  main.innerHTML = html;
  return { main, index: indexText(main) };
}

describe("reading annotations", () => {
  const original = page("<h1>設定</h1><p>反映は<strong>翌日</strong>からです。</p>");
  const range = document.createRange();
  range.selectNodeContents(original.main.querySelector("strong")!);
  const anchor = original.index.capture(range, "a".repeat(64))!;
  it("recovers a selection after paragraphs are inserted or formatting changes", () => {
    const { index } = page("<h1>設定</h1><p>新しい段落</p><p>反映は翌日からです。</p>");
    const position = locate(index, anchor, "b".repeat(64))!;
    expect(index.range(position, anchor.quote.length)?.toString()).toBe("翌日");
  });
  it("keeps changed, ambiguous and out-of-section quotes unresolved", () => {
    for (const html of [
      "<h1>設定</h1><p>反映は即時です。</p>",
      "<h1>設定</h1><p>反映は翌日からです。</p><p>反映は翌日からです。</p>",
      "<h1>別件</h1><p>反映は翌日からです。</p>",
      "<h1>設定</h1><p>以前は反映は翌日からです。</p>",
    ]) {
      expect(locate(page(html).index, anchor, "new")).toBeNull();
    }
  });
  it("keeps an originally ambiguous quote pending when only the other copy survives", () => {
    const { main, index } = page("<p>要確認。</p><p>要確認。</p>");
    const range = document.createRange();
    range.selectNodeContents(main.querySelector("p")!);
    const duplicate = index.capture(range, "old")!;
    expect(locate(index, duplicate, "old")).toBe(0);
    expect(locate(page("<p>確認済み。</p><p>要確認。</p>").index, duplicate, "new")).toBeNull();
  });
  it("keeps a quote pending when its lookup budget is exhausted", () => {
    expect(locate(original.index, anchor, "new", { characters: 0, candidates: 1 })).toBeNull();
  });
  it("keeps original quotes and memos across export and rejects unknown formats", () => {
    const note: Annotation = {
      ...anchor,
      id: "abbe4ab0-62e9-4784-98ee-662378ba38e0",
      created: "2026-01-01T00:00:00.000Z",
      memo: "確認する",
      color: "yellow",
    };
    expect(parseExport(serializeExport([note]))).toEqual([note]);
    expect(() => parseExport('{"schemaVersion":2,"annotations":[]}')).toThrow();
    expect(() =>
      parseExport(JSON.stringify({ schemaVersion: 1, annotations: [{ ...note, quote: "" }] }))
    ).toThrow();
  });
});
