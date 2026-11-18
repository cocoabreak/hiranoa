import { describe, expect, it } from "vitest";
import {
  changedRange,
  compareSequences,
  mapScroll,
  markdownBlocks,
  markTextRange,
} from "./compare";

describe("history correspondence", () => {
  it("anchors unchanged blocks and distinguishes additions and deletions", () => {
    expect(compareSequences(["A", "B", "C"], ["A", "C", "D"])).toEqual([
      { left: 0, right: 0, kind: "equal" },
      { left: 1, right: null, kind: "deleted" },
      { left: 2, right: 1, kind: "equal" },
      { left: null, right: 2, kind: "added" },
    ]);
    expect(compareSequences(["old"], ["new"])).toEqual([{ left: 0, right: 0, kind: "changed" }]);
    expect(compareSequences([], [])).toEqual([]);
  });
  it("handles repeated blocks without duplicating source indices", () => {
    const pairs = compareSequences(["a", "a", "b", "a"], ["a", "b", "a", "a"]);
    expect(pairs.flatMap((p) => (p.left === null ? [] : [p.left]))).toEqual([0, 1, 2, 3]);
    expect(pairs.flatMap((p) => (p.right === null ? [] : [p.right]))).toEqual([0, 1, 2, 3]);
  });
  it("limits computation while preserving large unchanged inputs", () => {
    expect(() => compareSequences(Array(1000).fill("a"), Array(1000).fill("b"))).toThrow();
    expect(compareSequences(Array(4000).fill("same"), Array(4000).fill("same"))).toHaveLength(4000);
  });
  it("keeps metadata, lists, tables and fences as document blocks", async () => {
    const blocks = await markdownBlocks(
      "---\ntitle: Example\n---\n# Heading\n\n- one\n- two\n\n```mermaid\ngraph TD; A-->B\n```\n"
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "frontmatter",
      "heading_open",
      "bullet_list_open",
      "fence",
    ]);
    expect(blocks[1].start).toBe(3);
    expect(blocks[3].raw).toContain("graph TD");
    await expect(markdownBlocks("a\n".repeat(4001))).rejects.toThrow();
    await expect(markdownBlocks(`---\n${"# comment\n".repeat(4001)}---\ntext`)).rejects.toThrow();
  });
  it("keeps dialect blocks and otherwise invisible reference definitions", async () => {
    const blocks = await markdownBlocks(
      "# H\n\nRead[^x]\n\n[^x]: old note\n\nTerm\n: definition\n\n[ref]: old.md\n"
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading_open",
      "paragraph_open",
      "paragraph_open",
      "dl_open",
      "definition",
    ]);
    expect(blocks[2].raw).toContain("old note");
    expect(blocks[4].raw).toContain("old.md");
  });
  it("maps corresponding content anchors rather than document percentages", () => {
    expect(
      mapScroll(
        150,
        [
          [0, 0],
          [100, 300],
          [200, 400],
        ],
        500
      )
    ).toBe(350);
    expect(
      mapScroll(
        -20,
        [
          [0, 0],
          [100, 300],
        ],
        500
      )
    ).toBe(0);
    expect(
      mapScroll(
        2000,
        [
          [0, 0],
          [100, 300],
        ],
        200
      )
    ).toBe(200);
  });
  it("marks changed text safely across formatting and unicode boundaries", () => {
    const old = "日本語😀30秒",
      next = "日本語😺60秒";
    const range = changedRange(old, next);
    expect(old.slice(...range.left)).toBe("😀3");
    expect(next.slice(...range.right)).toBe("😺6");
    const root = document.createElement("div");
    root.innerHTML = "<p>日本語<strong>😀30</strong>秒</p>";
    markTextRange(root, range.left);
    expect(root.textContent).toBe(old);
    expect(root.querySelector("mark")?.textContent).toBe("😀3");
    expect(root.querySelector("strong")).not.toBeNull();
  });
});
