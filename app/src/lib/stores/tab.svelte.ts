import { createPaneScopedStore, workspaceStore, MAX_WORKSPACE_TABS } from "./workspace.svelte";
import { documentWatch, releaseUnusedWatch } from "$lib/document-resources";
import type { ScrollPositions } from "./session-ui-state.svelte";
import { contentStore } from "$lib/stores/content.svelte";
import type { Tab } from "$lib/types";
import { nativeDocumentIdentity, nativePathsEqual } from "$lib/document-sources";
import { sessionUiStateStore } from "$lib/stores/session-ui-state.svelte";

const MAX_RECENTLY_CLOSED_TABS = 10;

export interface ClosedTabEntry {
  tab: Tab;
  index: number;
  paneId?: string;
  scrollPositions?: ScrollPositions;
}

function copyTab(tab: Tab): Tab {
  return {
    ...tab,
    document: tab.document ? { ...tab.document } : undefined,
    source: tab.source
      ? { ...tab.source, capabilities: { ...tab.source.capabilities } }
      : undefined,
  };
}

export function representsSameDocument(left: Tab, right: Tab): boolean {
  if (left.path === right.path) return true;
  if (!left.document || !left.source || !right.document || !right.source) return false;
  const leftNative = nativeDocumentIdentity(left.source, left.document);
  if (leftNative !== null) {
    return leftNative === nativeDocumentIdentity(right.source, right.document);
  }
  return (
    left.source.kind === "zip" &&
    right.source.kind === "zip" &&
    nativePathsEqual(left.source.nativePath, right.source.nativePath) &&
    left.document.path === right.document.path
  );
}

const workspacePendingCloses = new Set<Promise<void>>();

export function createTabStore(paneId?: string) {
  let tabs = $state<Tab[]>([]);
  let activeTabId = $state<string | null>(null);
  const closed = paneId ? workspaceClosed : { entries: [] as ClosedTabEntry[] };
  function allTabs(): Tab[] {
    return paneId ? allWorkspaceTabs() : tabs;
  }
  const closingIds = new Set<string>();
  const pendingCloseOperations = paneId ? workspacePendingCloses : new Set<Promise<void>>();

  function rememberClosed(tab: Tab, index: number) {
    closed.entries = [
      ...closed.entries.slice(-(MAX_RECENTLY_CLOSED_TABS - 1)),
      { tab: copyTab(tab), index, paneId, scrollPositions: sessionUiStateStore.snapshot(tab.id) },
    ];
  }

  function closeTab(id: string): boolean {
    const target = tabs.find((tab) => tab.id === id);
    if (!target || target.pinned) return false;
    const index = tabs.findIndex((tab) => tab.id === id);
    tabs = tabs.filter((tab) => tab.id !== id);
    sessionUiStateStore.deleteTab(id);
    if (activeTabId === id) {
      activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    }
    if (paneId && tabs.length === 0) workspaceStore.removePane(paneId);
    return true;
  }

  async function performCloseAndUnwatch(id: string): Promise<void> {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab || tab.pinned || closingIds.has(id)) return;
    closingIds.add(id);
    const index = tabs.findIndex((candidate) => candidate.id === id);
    try {
      rememberClosed(tab, index);
      if (!closeTab(id)) return;
      if (!allTabs().some((candidate) => candidate.path === tab.path))
        contentStore.delete(tab.path);
      if (tab.document && tab.source) {
        const watch = documentWatch(tab.source, tab.document);
        if (watch) await releaseUnusedWatch(watch, allTabs);
      }
    } finally {
      closingIds.delete(id);
    }
  }

  function closeAndUnwatch(id: string): Promise<void> {
    const operation = performCloseAndUnwatch(id);
    pendingCloseOperations.add(operation);
    void operation.then(
      () => pendingCloseOperations.delete(operation),
      () => pendingCloseOperations.delete(operation)
    );
    return operation;
  }

  return {
    get tabs() {
      return tabs;
    },
    get activeTabId() {
      return activeTabId;
    },
    get canReopenClosedTab() {
      return closed.entries.length > 0;
    },
    addOrActivate(tab: Tab) {
      closed.entries = closed.entries.filter((entry) => !representsSameDocument(entry.tab, tab));
      const existing = tabs.find((t) => representsSameDocument(t, tab));
      if (existing) {
        activeTabId = existing.id;
      } else {
        if (allTabs().length >= MAX_WORKSPACE_TABS) return;
        if (tab.pinned) {
          const firstUnpinned = tabs.findIndex((candidate) => !candidate.pinned);
          const index = firstUnpinned === -1 ? tabs.length : firstUnpinned;
          tabs = [...tabs.slice(0, index), tab, ...tabs.slice(index)];
        } else {
          tabs = [...tabs, tab];
        }
        activeTabId = tab.id;
      }
    },
    close: closeTab,
    detach(id: string) {
      const tab = tabs.find((candidate) => candidate.id === id);
      const index = tabs.findIndex((candidate) => candidate.id === id);
      tabs = tabs.filter((candidate) => candidate.id !== id);
      if (activeTabId === id) activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
      return tab;
    },
    setActive(id: string, invalidate = true) {
      if (!tabs.some((tab) => tab.id === id)) return;
      if (invalidate && paneId) workspaceStore.beginRequest(paneId);
      activeTabId = id;
    },
    togglePin(id: string) {
      if (closingIds.has(id)) return;
      const tab = tabs.find((candidate) => candidate.id === id);
      if (!tab) return;
      const next = tabs.filter((candidate) => candidate.id !== id);
      const updated = { ...tab, pinned: !tab.pinned };
      const firstUnpinned = next.findIndex((candidate) => !candidate.pinned);
      const index = firstUnpinned === -1 ? next.length : firstUnpinned;
      next.splice(index, 0, updated);
      tabs = next;
    },
    moveRelative(id: string, targetId: string, position: "before" | "after") {
      if (id === targetId) return;
      const tab = tabs.find((candidate) => candidate.id === id);
      const target = tabs.find((candidate) => candidate.id === targetId);
      if (!tab || !target || !!tab.pinned !== !!target.pinned) return;
      const next = tabs.filter((candidate) => candidate.id !== id);
      const targetIndex = next.findIndex((candidate) => candidate.id === targetId);
      next.splice(targetIndex + (position === "after" ? 1 : 0), 0, tab);
      tabs = next;
    },
    moveToIndex(id: string, requestedIndex: number) {
      const tab = tabs.find((candidate) => candidate.id === id);
      if (!tab || !Number.isInteger(requestedIndex)) return;
      const next = tabs.filter((candidate) => candidate.id !== id);
      const pinnedCount = next.filter((candidate) => candidate.pinned).length;
      const min = tab.pinned ? 0 : pinnedCount;
      const max = tab.pinned ? pinnedCount : next.length;
      const index = Math.max(min, Math.min(requestedIndex, max));
      next.splice(index, 0, tab);
      tabs = next;
    },
    updateTab(id: string, updates: Partial<Tab>) {
      tabs = tabs.map((t) => (t.id === id ? { ...t, ...updates } : t));
    },
    cycle(direction: 1 | -1) {
      if (paneId) workspaceStore.beginRequest(paneId);
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      const nextIdx = (idx + direction + tabs.length) % tabs.length;
      activeTabId = tabs[nextIdx].id;
    },
    jumpTo(index: number) {
      if (paneId) workspaceStore.beginRequest(paneId);
      const tab = tabs[index];
      if (tab) activeTabId = tab.id;
    },
    takeRecentlyClosed(): ClosedTabEntry | undefined {
      const entry = closed.entries.at(-1);
      if (entry) closed.entries = closed.entries.slice(0, -1);
      return entry;
    },
    clearRecentlyClosed() {
      closed.entries = [];
    },
    closeAndUnwatch,
    async waitForCloseOperations() {
      while (pendingCloseOperations.size > 0) {
        await Promise.allSettled([...pendingCloseOperations]);
      }
    },
    async closeOthers(id: string) {
      const ids = tabs
        .filter((candidate) => candidate.id !== id && !candidate.pinned)
        .map((candidate) => candidate.id)
        .reverse();
      for (const candidateId of ids) await closeAndUnwatch(candidateId);
    },
    async closeToRight(id: string) {
      const index = tabs.findIndex((candidate) => candidate.id === id);
      if (index === -1) return;
      const ids = tabs
        .slice(index + 1)
        .filter((candidate) => !candidate.pinned)
        .map((candidate) => candidate.id)
        .reverse();
      for (const candidateId of ids) await closeAndUnwatch(candidateId);
    },
  };
}

const workspaceClosed = $state({ entries: [] as ClosedTabEntry[] });
const scopedTabs = createPaneScopedStore((id) => createTabStore(id));
function allWorkspaceTabs(): Tab[] {
  return workspaceStore.paneIds.flatMap((id) => scopedTabs.forPane(id).tabs);
}
export const tabStore = new Proxy(scopedTabs as typeof scopedTabs & { readonly allTabs: Tab[] }, {
  get(target, property) {
    if (property === "allTabs") return allWorkspaceTabs();
    if (property === "waitForCloseOperations")
      return async () => {
        while (workspacePendingCloses.size) await Promise.allSettled([...workspacePendingCloses]);
      };
    if (["updateTab", "close", "closeAndUnwatch", "togglePin"].includes(String(property))) {
      return (id: string, ...args: unknown[]) => {
        const owner = workspaceStore.paneIds
          .map((paneId) => scopedTabs.forPane(paneId))
          .find((store) => store.tabs.some((tab) => tab.id === id));
        if (owner) return Reflect.get(owner, property)(id, ...args);
      };
    }
    return Reflect.get(target, property);
  },
});
