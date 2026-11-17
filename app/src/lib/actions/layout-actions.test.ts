import { beforeEach, describe, expect, it, vi } from "vitest";
import { tabStore } from "$lib/stores/tab.svelte";
import { workspaceStore } from "$lib/stores/workspace.svelte";
import { sessionRestorePromptStore } from "$lib/stores/session-restore-prompt.svelte";
import { settingsStore } from "$lib/stores/settings.svelte";
import { captureLayout, applyLayout } from "./layout-actions";
import { restoreSessionSnapshot, saveAndFlushTabs, flushTabs } from "$lib/tabs-store";
import { captureOpenTarget } from "./workspace-actions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/actions/explorer-actions", () => ({
  closeFolder: vi.fn().mockResolvedValue(undefined),
  sanitizeExpandedDirectories: (value: unknown) => value,
}));
vi.mock("$lib/settings-store", () => ({ saveSettings: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/tabs-store", async (original) => ({
  ...(await original<typeof import("$lib/tabs-store")>()),
  restoreSessionSnapshot: vi.fn(),
  saveAndFlushTabs: vi.fn().mockResolvedValue(undefined),
  flushTabs: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  workspaceStore.reset();
  sessionRestorePromptStore.hide();
  sessionRestorePromptStore.endRestore();
  vi.clearAllMocks();
  vi.mocked(restoreSessionSnapshot).mockResolvedValue(undefined);
});

describe("apply layout", () => {
  it("replaces pinned tabs, invalidates old requests and reports partial restoration", async () => {
    tabStore.addOrActivate({ id: "a", path: "D:/notes/a.md", title: "a", pinned: true });
    tabStore.addOrActivate({ id: "b", path: "D:/notes/b.md", title: "b" });
    const saved = captureLayout("Reading");
    const target = captureOpenTarget();
    const oldPane = workspaceStore.activePaneId;
    vi.mocked(restoreSessionSnapshot).mockImplementation(async () => {
      expect(sessionRestorePromptStore.restoring).toBe(true);
      expect(settingsStore.settings.contentZoom).toBe(saved.appearance.contentZoom);
      expect(tabStore.allTabs).toHaveLength(0);
      tabStore.addOrActivate({ id: "new", path: "D:/notes/a.md", title: "a" });
    });
    settingsStore.setContentZoom(150);
    expect(await applyLayout(saved)).toEqual({ restored: 1, skipped: 1 });
    expect(target.valid()).toBe(false);
    expect(workspaceStore.hasPane(oldPane)).toBe(false);
    expect(settingsStore.settings.contentZoom).toBe(saved.appearance.contentZoom);
    expect(sessionRestorePromptStore.restoring).toBe(false);
    expect(saveAndFlushTabs).toHaveBeenCalledOnce();
  });
  it("rejects concurrent application and releases the guard on failure", async () => {
    const saved = captureLayout("Reading");
    let finish!: () => void;
    vi.mocked(flushTabs).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const applying = applyLayout(saved);
    await expect(applyLayout(saved)).rejects.toThrow();
    finish();
    await applying;
    vi.mocked(restoreSessionSnapshot).mockRejectedValueOnce(new Error("failed"));
    await expect(applyLayout(saved)).rejects.toThrow("failed");
    expect(sessionRestorePromptStore.restoring).toBe(false);
  });
  it("rejects invalid data and an outstanding startup prompt before changing tabs", async () => {
    tabStore.addOrActivate({ id: "a", path: "D:/notes/a.md", title: "a" });
    const saved = captureLayout("Reading");
    saved.appearance.contentZoom = Infinity;
    await expect(applyLayout(saved)).rejects.toThrow();
    expect(tabStore.allTabs).toHaveLength(1);
    sessionRestorePromptStore.show();
    await expect(applyLayout(captureLayout("Reading"))).rejects.toThrow();
    expect(tabStore.allTabs).toHaveLength(1);
  });
});
