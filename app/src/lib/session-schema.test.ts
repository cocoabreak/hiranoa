import { describe, expect, it } from "vitest";
import { normalizeSession } from "./session-schema";

describe("workspace session input", () => {
  it("現行形式を1ペインへ移行して危険なrenderModeを引き継がない", () => {
    const session = normalizeSession({
      tabs: [
        {
          path: "D:/notes/a.md",
          pinned: true,
          renderMode: "full",
          viewMode: "source",
          scrollPositions: { rendered: -1, source: 80 },
        },
      ],
      activeIndex: 0,
      search: { open: true, query: "needle", useRegex: false },
    });
    expect(session.workspace?.panes[0]).toMatchObject({
      activeIndex: 0,
      tabs: [
        {
          path: "D:/notes/a.md",
          pinned: true,
          viewMode: "source",
          scrollPositions: { source: 80 },
        },
      ],
    });
    expect(session.workspace?.panes[0].tabs[0]).not.toHaveProperty("renderMode");
  });
  it("将来版・3ペイン・過剰なデータからファイルを開かない", () => {
    expect(
      normalizeSession({
        schemaVersion: 3,
        workspace: { panes: [{ tabs: [{ path: "D:/notes/a.md" }] }] },
      }).workspace
    ).toBeUndefined();
    expect(
      normalizeSession({ schemaVersion: 2, workspace: { panes: [{}, {}, {}] } }).workspace
    ).toBeUndefined();
    expect(normalizeSession({ tabs: [], extra: "a".repeat(1024 * 1024) })).toEqual({});
  });
  it("2ペイン合計100タブ・比率・検索文字数の制限を維持する", () => {
    const tabs = Array.from({ length: 60 }, () => ({ path: "D:/notes/a.md" }));
    const session = normalizeSession({
      schemaVersion: 2,
      workspace: {
        panes: [{ tabs }, { tabs, search: { query: "a".repeat(20000) } }],
        splitRatio: 0.99,
        activePaneIndex: 1,
      },
    });
    expect(session.workspace?.panes.map((pane) => pane.tabs.length)).toEqual([60, 40]);
    expect(session.workspace?.splitRatio).toBe(0.8);
    expect(session.workspace?.panes[1].search?.query).toHaveLength(10000);
  });
});
