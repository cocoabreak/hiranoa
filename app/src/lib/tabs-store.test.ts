import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("$lib/actions/dialog-actions", () => ({
  openArchive: vi.fn(),
  openFolder: vi.fn(),
}));
vi.mock("$lib/actions/security", () => ({
  authorizeArchivePath: vi.fn(),
  authorizePath: vi.fn(),
}));
vi.mock("$lib/actions/file-actions", () => ({
  openMarkdownFile: vi.fn(),
  openSourceMarkdown: vi.fn(),
}));
vi.mock("$lib/actions/explorer-actions", () => ({
  restoreExpandedDirectories: vi.fn(),
  sanitizeExpandedDirectories: (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
}));

import { invoke } from "@tauri-apps/api/core";
import { openFolder } from "$lib/actions/dialog-actions";
import { authorizePath } from "$lib/actions/security";
import { openMarkdownFile } from "$lib/actions/file-actions";
import { restoreExpandedDirectories } from "$lib/actions/explorer-actions";
import {
  loadTabsOnStartup,
  discardSavedTabs,
  flushTabs,
  restoredActiveTabId,
  restoreSavedTabs,
  saveAndFlushTabs,
  saveTabs,
} from "$lib/tabs-store";
import { workspaceStore } from "$lib/stores/workspace.svelte";
import { tabStore } from "$lib/stores/tab.svelte";
import { explorerStore } from "$lib/stores/explorer.svelte";
import { searchStore } from "$lib/stores/search.svelte";
import { sessionUiStateStore } from "$lib/stores/session-ui-state.svelte";

const mockedInvoke = vi.mocked(invoke);
const mockedAuthorizePath = vi.mocked(authorizePath);
const mockedOpenMarkdownFile = vi.mocked(openMarkdownFile);
const mockedOpenFolder = vi.mocked(openFolder);

beforeEach(() => {
  vi.clearAllMocks();
  for (const tab of [...tabStore.allTabs]) {
    if (tab.pinned) tabStore.togglePin(tab.id);
    tabStore.close(tab.id);
  }
  explorerStore.clear();
  sessionUiStateStore.clear();
  searchStore.restoreSessionState(null);
  mockedInvoke.mockResolvedValue(undefined);
});

describe("restoredActiveTabId", () => {
  it("先行タブの復元失敗後も保存時activeIndexに対応するタブを選ぶ", () => {
    const restored = new Map([
      [1, "tab-b"],
      [2, "tab-c"],
    ]);

    expect(restoredActiveTabId(restored, 1)).toBe("tab-b");
    expect(restoredActiveTabId(restored, 0)).toBeNull();
  });
});

describe("tabs session persistence", () => {
  it("スクロール・Explorer展開・検索を同じpayloadへ保存する", async () => {
    tabStore.addOrActivate({ id: "tab-a", path: "D:/notes/a.md", title: "a.md" });
    sessionUiStateStore.restoreScrollPositions("tab-a", { rendered: 320 });
    explorerStore.setRoot("D:/notes", [], undefined);
    explorerStore.expandDir("docs");
    searchStore.restoreSessionState({ open: true, query: "needle", useRegex: true });

    const saving = saveTabs();
    await flushTabs();
    await saving;

    expect(mockedInvoke).toHaveBeenCalledWith("save_app_state", {
      kind: "tabs",
      value: expect.objectContaining({
        expandedDirs: ["docs"],
        schemaVersion: 2,
        workspace: expect.objectContaining({
          panes: [
            expect.objectContaining({
              search: { open: true, query: "needle", useRegex: true },
              tabs: [expect.objectContaining({ scrollPositions: { rendered: 320 } })],
            }),
          ],
        }),
      }),
    });
  });

  it("復元したタブIDへスクロールを結び直し、Explorerと検索を復元する", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "load_app_state") {
        return {
          tabs: [
            {
              path: "D:/notes/a.md",
              pinned: false,
              scrollPositions: { rendered: 480 },
            },
          ],
          activeIndex: 0,
          expandedDirs: ["docs"],
          search: { open: true, query: "restored", useRegex: false },
        };
      }
      return undefined;
    });
    mockedAuthorizePath.mockResolvedValue(true);
    mockedOpenMarkdownFile.mockImplementation(async (path) => {
      tabStore.addOrActivate({ id: "new-tab-id", path, title: "a.md" });
      return true;
    });

    await restoreSavedTabs();

    expect(tabStore.activeTabId).toBe("new-tab-id");
    expect(sessionUiStateStore.getScroll("new-tab-id", "rendered")).toBe(480);
    expect(restoreExpandedDirectories).toHaveBeenCalledWith(["docs"]);
    expect(searchStore.sessionState).toEqual({
      open: true,
      query: "restored",
      useRegex: false,
    });
  });

  it("現行explorerフィールドからネイティブフォルダーを復元する", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "load_app_state") {
        return {
          tabs: [],
          activeIndex: null,
          explorer: { kind: "native", nativePath: "D:/notes" },
        };
      }
      return undefined;
    });
    mockedOpenFolder.mockResolvedValue(true);

    await restoreSavedTabs();

    expect(mockedOpenFolder).toHaveBeenCalledWith("D:/notes");
  });

  it("破棄時に追加UI状態も空の値で保存する", async () => {
    await discardSavedTabs();

    expect(mockedInvoke).toHaveBeenCalledWith("save_app_state", {
      kind: "tabs",
      value: {
        tabs: [],
        activeIndex: null,
        explorer: null,
        expandedDirs: [],
        search: { open: false, query: "", useRegex: false },
      },
    });
  });

  it("スクロール保存通知のデバウンス中でも終了用flushは最新位置を保存する", async () => {
    tabStore.addOrActivate({ id: "tab-a", path: "D:/notes/a.md", title: "a.md" });
    sessionUiStateStore.setScroll("tab-a", "rendered", 640);

    await saveAndFlushTabs();

    expect(mockedInvoke).toHaveBeenCalledWith("save_app_state", {
      kind: "tabs",
      value: expect.objectContaining({
        workspace: expect.objectContaining({
          panes: [
            expect.objectContaining({
              tabs: [expect.objectContaining({ scrollPositions: { rendered: 640 } })],
            }),
          ],
        }),
      }),
    });
  });
});

describe("split session restoration", () => {
  it("非同期読込と最終ペイン比率の確定後に保存位置を復元する", async () => {
    const restorePositions = vi.spyOn(sessionUiStateStore, "restoreScrollPositions");
    mockedInvoke.mockResolvedValue({
      schemaVersion: 2,
      workspace: {
        panes: [
          { tabs: [{ path: "D:/notes/a.md", pinned: false, scrollPositions: { rendered: 5000 } }] },
          { tabs: [{ path: "D:/notes/b.md", pinned: false, scrollPositions: { source: 8000 } }] },
        ],
        activePaneIndex: 0,
        splitRatio: 0.7,
      },
    });
    mockedAuthorizePath.mockResolvedValue(true);
    mockedOpenMarkdownFile.mockImplementation(async (path, target) => {
      expect(restorePositions).not.toHaveBeenCalled();
      tabStore.forPane(target!.paneId!).addOrActivate({ id: path, path, title: path });
      return true;
    });
    await restoreSavedTabs();
    expect(workspaceStore.splitRatio).toBe(0.7);
    expect(restorePositions).toHaveBeenCalledWith("D:/notes/a.md", { rendered: 5000 });
    expect(restorePositions).toHaveBeenCalledWith("D:/notes/b.md", { source: 8000 });
    restorePositions.mockRestore();
  });
  it("左側の全ファイルが失敗しても右側だけを残す", async () => {
    mockedInvoke.mockResolvedValue({
      schemaVersion: 2,
      workspace: {
        panes: [
          { tabs: [{ path: "D:/notes/missing.md", pinned: false }], activeIndex: 0 },
          {
            tabs: [{ path: "D:/notes/right.md", pinned: false, viewMode: "source" }],
            activeIndex: 0,
            search: { open: false, query: "right", useRegex: false },
          },
        ],
        activePaneIndex: 1,
        splitRatio: 0.6,
      },
    });
    mockedAuthorizePath.mockResolvedValue(true);
    mockedOpenMarkdownFile.mockImplementation(async (path, target) => {
      if (path.includes("missing")) return false;
      tabStore.forPane(target!.paneId!).addOrActivate({ id: "right", path, title: "right.md" });
      return true;
    });
    await restoreSavedTabs();
    expect(workspaceStore.paneIds).toHaveLength(1);
    expect(tabStore.tabs[0]).toMatchObject({ id: "right", viewMode: "source" });
    expect(searchStore.query).toBe("right");
  });
  it("左右の同じ文書を別の表示として復元する", async () => {
    mockedInvoke.mockResolvedValue({
      schemaVersion: 2,
      workspace: {
        panes: [
          { tabs: [{ path: "D:/notes/a.md", pinned: false }], activeIndex: 0 },
          { tabs: [{ path: "D:/notes/a.md", pinned: false, viewMode: "source" }], activeIndex: 0 },
        ],
        activePaneIndex: 0,
        splitRatio: 0.4,
      },
    });
    mockedAuthorizePath.mockResolvedValue(true);
    let next = 0;
    mockedOpenMarkdownFile.mockImplementation(async (path, target) => {
      tabStore
        .forPane(target!.paneId!)
        .addOrActivate({ id: "view-" + next++, path, title: "a.md" });
      return true;
    });
    await restoreSavedTabs();
    expect(workspaceStore.paneIds).toHaveLength(2);
    expect(tabStore.allTabs).toHaveLength(2);
    expect(tabStore.allTabs.map((tab) => tab.viewMode)).toEqual(["rendered", "source"]);
    expect(workspaceStore.splitRatio).toBe(0.4);
  });
});

describe("restore save guard", () => {
  it("復元途中は明示flushでも空や部分状態を保存しない", async () => {
    let finish!: (value: unknown) => void;
    mockedInvoke.mockImplementation((command) =>
      command === "load_app_state"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(undefined)
    );
    const restoring = restoreSavedTabs();
    await saveAndFlushTabs();
    expect(
      mockedInvoke.mock.calls.filter(([command]) => command === "save_app_state")
    ).toHaveLength(0);
    finish({ tabs: [] });
    await restoring;
  });
  it("リロードでも将来版セッションは確認前に破棄しない", async () => {
    mockedInvoke.mockImplementation(async (command) =>
      command === "is_fresh_launch" ? false : { schemaVersion: 3 }
    );
    expect(await loadTabsOnStartup()).toEqual({ promptRestore: true });
    expect(mockedAuthorizePath).not.toHaveBeenCalled();
    expect(
      mockedInvoke.mock.calls.filter(([command]) => command === "save_app_state")
    ).toHaveLength(0);
  });
});
