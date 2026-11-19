import { beforeEach, describe, expect, it, vi } from "vitest";
import { tabStore } from "$lib/stores/tab.svelte";
import { workspaceStore } from "$lib/stores/workspace.svelte";
import { contentStore } from "$lib/stores/content.svelte";
import { searchStore } from "$lib/stores/search.svelte";
import { sessionUiStateStore } from "$lib/stores/session-ui-state.svelte";
import {
  captureOpenTarget,
  captureOtherTarget,
  copyTabToOther,
  splitView,
  moveTabToOther,
  unsplitView,
} from "./workspace-actions";
import { openSourceMarkdown } from "./file-actions";
import { invoke } from "@tauri-apps/api/core";
import type { DocumentSourceInfo } from "$lib/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("$lib/recent-store", () => ({ saveRecent: vi.fn() }));

const source: DocumentSourceInfo = {
  id: "notes",
  kind: "native",
  nativePath: "D:/notes",
  label: "notes",
  capabilities: {
    watch: "entries",
    externalEditor: true,
    respectGitignore: true,
    fullTextSearch: true,
    wikiLinks: true,
  },
};
const document = { sourceId: source.id, path: "a.md" };
function add(id: string, path = "notes:a.md") {
  tabStore.addOrActivate({ id, path, title: path, source, document });
}

beforeEach(async () => {
  for (const tab of [...tabStore.allTabs]) {
    if (tab.pinned) tabStore.togglePin(tab.id);
    await tabStore.closeAndUnwatch(tab.id);
  }
  tabStore.clearRecentlyClosed();
  sessionUiStateStore.clear();
  searchStore.restoreSessionState(null);
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue({
    raw: "# A",
    byteSize: 3,
    requiresConfirmation: false,
    safeOutline: [],
    safeOutlineTruncated: false,
  });
});

describe("split workspace", () => {
  it("同じ本文を共有してモードと位置を複製し、検索は新しく始める", () => {
    add("left");
    tabStore.updateTab("left", { viewMode: "source" });
    contentStore.set("notes:a.md", { raw: "# A", safeOutline: [], safeOutlineTruncated: false });
    searchStore.setQuery("left query");
    sessionUiStateStore.restoreScrollPositions("left", { source: 300 });
    const left = workspaceStore.activePaneId;
    splitView();
    expect(workspaceStore.paneIds).toHaveLength(2);
    expect(tabStore.tabs[0].viewMode).toBe("source");
    expect(sessionUiStateStore.snapshot(tabStore.tabs[0].id)).toEqual({ source: 300 });
    expect(searchStore.query).toBe("");
    searchStore.setQuery("right query");
    expect(searchStore.forPane(left).query).toBe("left query");
    expect(tabStore.allTabs).toHaveLength(2);
  });

  it("分割解除は操作中の表示を残し、重複タブのpinだけ統合する", () => {
    add("left");
    tabStore.togglePin("left");
    splitView();
    const rightId = tabStore.activeTabId!;
    tabStore.updateTab(rightId, { viewMode: "source" });
    tabStore.togglePin(rightId);
    sessionUiStateStore.restoreScrollPositions(rightId, { source: 720 });
    unsplitView();
    expect(workspaceStore.paneIds).toHaveLength(1);
    expect(tabStore.tabs).toHaveLength(1);
    expect(tabStore.tabs[0]).toMatchObject({ id: rightId, viewMode: "source", pinned: true });
    expect(sessionUiStateStore.snapshot(rightId)).toEqual({ source: 720 });
  });

  it("タブ移動は既存の表示へモードと位置を引き継ぎ、本文を解放しない", () => {
    add("left");
    contentStore.set("notes:a.md", { raw: "shared", safeOutline: [], safeOutlineTruncated: false });
    const left = workspaceStore.activePaneId;
    splitView();
    tabStore.forPane(left).updateTab("left", { viewMode: "source" });
    sessionUiStateStore.restoreScrollPositions("left", { source: 220 });
    moveTabToOther(left, "left");
    expect(workspaceStore.paneIds).toHaveLength(1);
    expect(tabStore.tabs[0].viewMode).toBe("source");
    expect(sessionUiStateStore.snapshot(tabStore.tabs[0].id)).toEqual({ source: 220 });
    expect(contentStore.get("notes:a.md")?.raw).toBe("shared");
  });

  it("片側を閉じても本文・監視を残し、閉じた履歴はペイン破棄後も残る", async () => {
    add("left");
    contentStore.set("notes:a.md", { raw: "shared", safeOutline: [], safeOutlineTruncated: false });
    splitView();
    await tabStore.closeAndUnwatch(tabStore.activeTabId!);
    expect(contentStore.get("notes:a.md")?.raw).toBe("shared");
    expect(invoke).not.toHaveBeenCalledWith("unwatch_path", expect.anything());
    expect(tabStore.canReopenClosedTab).toBe(true);
    await tabStore.closeAndUnwatch("left");
    expect(contentStore.get("notes:a.md")).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("unwatch_path", { path: "D:/notes/a.md" });
  });

  it("読込要求は対象ペインを固定し、新しい要求と破棄されたペインを検出する", () => {
    add("left");
    const left = workspaceStore.activePaneId;
    const old = captureOpenTarget(left);
    splitView();
    expect(old.valid()).toBe(true);
    captureOpenTarget(left);
    expect(old.valid()).toBe(false);
    const right = captureOpenTarget();
    workspaceStore.removePane(workspaceStore.activePaneId);
    expect(right.valid()).toBe(false);
  });

  it("読込が失敗または競合したときは空の反対側ペインを作らない", async () => {
    add("left");
    const target = captureOtherTarget();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("missing"));
    await expect(openSourceMarkdown(document, source, undefined, target)).rejects.toThrow();
    expect(workspaceStore.paneIds).toHaveLength(1);
    const stale = captureOtherTarget();
    splitView();
    expect(stale.commit()).toBeUndefined();
    expect(workspaceStore.paneIds).toHaveLength(2);
  });

  it("開き直したネイティブ文書は同じタブで新しいソースと本文を参照する", async () => {
    add("existing");
    contentStore.set("notes:a.md", { raw: "# Old", safeOutline: [], safeOutlineTruncated: false });
    const reopenedSource = { ...source, id: "reopened", nativePath: "d:/NOTES" };
    const reopened = { ...document, sourceId: reopenedSource.id };

    expect(await openSourceMarkdown(reopened, reopenedSource)).toBe(true);
    expect(tabStore.tabs).toHaveLength(1);
    expect(tabStore.tabs[0]).toMatchObject({
      id: "existing",
      path: "reopened:a.md",
      document: reopened,
      source: reopenedSource,
    });
    expect(contentStore.get("reopened:a.md")?.raw).toBe("# A");
    expect(contentStore.get("notes:a.md")).toBeUndefined();
  });

  it("読込中に操作対象を変えても開始時のペインへだけ結果を適用する", async () => {
    add("left");
    const left = workspaceStore.activePaneId;
    splitView();
    const right = workspaceStore.activePaneId;
    workspaceStore.activate(left);
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) =>
      command === "read_source_markdown"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(undefined)
    );
    const pending = openSourceMarkdown({ sourceId: source.id, path: "b.md" }, source);
    workspaceStore.activate(right);
    finish({
      raw: "# B",
      byteSize: 3,
      requiresConfirmation: false,
      safeOutline: [],
      safeOutlineTruncated: false,
    });
    expect(await pending).toBe(true);
    expect(tabStore.forPane(left).tabs).toHaveLength(2);
    expect(tabStore.forPane(right).tabs).toHaveLength(1);
    expect(workspaceStore.activePaneId).toBe(right);
  });

  it("読み込み待ちのペインが消えたら他方へ結果を流さない", async () => {
    add("left");
    splitView();
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) =>
      command === "read_source_markdown"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(undefined)
    );
    const pending = openSourceMarkdown({ sourceId: source.id, path: "b.md" }, source);
    workspaceStore.removePane(workspaceStore.activePaneId);
    finish({
      raw: "# B",
      byteSize: 3,
      requiresConfirmation: false,
      safeOutline: [],
      safeOutlineTruncated: false,
    });
    expect(await pending).toBe(false);
    expect(tabStore.allTabs).toHaveLength(1);
  });
});

describe("copy to existing pane", () => {
  it("既存表示の位置を維持してピン留めだけを統合する", () => {
    add("left");
    const left = workspaceStore.activePaneId;
    splitView();
    const right = workspaceStore.activePaneId;
    const rightId = tabStore.activeTabId!;
    sessionUiStateStore.restoreScrollPositions(rightId, { rendered: 123 });
    tabStore.forPane(left).togglePin("left");
    copyTabToOther(left, "left");
    expect(tabStore.forPane(right).tabs).toHaveLength(1);
    expect(tabStore.forPane(right).tabs[0].pinned).toBe(true);
    expect(sessionUiStateStore.snapshot(rightId)).toEqual({ rendered: 123 });
  });
});
