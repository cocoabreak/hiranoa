import { contentStore } from "$lib/stores/content.svelte";
import { tabStore, representsSameDocument } from "$lib/stores/tab.svelte";
import { workspaceStore, MAX_WORKSPACE_TABS } from "$lib/stores/workspace.svelte";
import { sessionUiStateStore } from "$lib/stores/session-ui-state.svelte";
import { documentAnchorStore } from "$lib/stores/document-anchor.svelte";

export interface OpenTarget {
  readonly paneId?: string;
  valid(): boolean;
  commit(): string | undefined;
}

export function captureOpenTarget(paneId = workspaceStore.activePaneId): OpenTarget {
  const request = workspaceStore.beginRequest(paneId);
  return { paneId, valid: request.valid, commit: () => (request.valid() ? paneId : undefined) };
}

export function captureOtherTarget(origin = workspaceStore.activePaneId): OpenTarget {
  const other = workspaceStore.otherPane(origin);
  const request = workspaceStore.beginRequest(other ?? origin);
  const version = workspaceStore.layoutVersion;
  const reserved = crypto.randomUUID();
  let committed: string | undefined;
  let committedValid: (() => boolean) | undefined;
  const valid = () =>
    committedValid ? committedValid() : request.valid() && workspaceStore.layoutVersion === version;
  return {
    get paneId() {
      return committed ?? other;
    },
    valid,
    commit() {
      if (!valid()) return;
      const target = other ?? workspaceStore.addPane(reserved);
      committed = target;
      if (target) committedValid = workspaceStore.beginRequest(target).valid;
      if (target) workspaceStore.activate(target);
      return target;
    },
  };
}

export function navigateOpenedAnchor(target: OpenTarget, anchor: string): void {
  const id = target.paneId;
  if (!id || !workspaceStore.hasPane(id) || !target.valid()) return;
  const tabs = tabStore.forPane(id);
  const document = tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.document;
  if (document) documentAnchorStore.forPane(id).navigate(document, anchor);
}

export function splitView(): void {
  if (workspaceStore.paneIds.length === 2 || tabStore.allTabs.length >= MAX_WORKSPACE_TABS) return;
  const active = tabStore.tabs.find((tab) => tab.id === tabStore.activeTabId);
  if (!active) return;
  const target = workspaceStore.addPane();
  if (!target) return;
  const copy = { ...active, id: crypto.randomUUID() };
  tabStore.forPane(target).addOrActivate(copy);
  sessionUiStateStore.restoreScrollPositions(copy.id, sessionUiStateStore.snapshot(active.id));
  workspaceStore.activate(target);
}

export function copyTabToOther(paneId: string, tabId: string): void {
  const other = workspaceStore.otherPane(paneId);
  if (!other) return;
  const tab = tabStore.forPane(paneId).tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;
  const target = tabStore.forPane(other);
  const existing = target.tabs.find((candidate) => representsSameDocument(candidate, tab));
  if (existing) {
    if (tab.pinned && !existing.pinned) target.togglePin(existing.id);
    target.setActive(existing.id);
  } else {
    if (tabStore.allTabs.length >= MAX_WORKSPACE_TABS) return;
    const copy = { ...tab, id: crypto.randomUUID() };
    target.addOrActivate(copy);
    sessionUiStateStore.restoreScrollPositions(copy.id, sessionUiStateStore.snapshot(tabId));
  }
  workspaceStore.activate(other);
}

/** Transfer without releasing content, watcher ownership, or the source registry. */
export function moveTabToOther(paneId: string, tabId: string): void {
  const other = workspaceStore.otherPane(paneId);
  if (!other) return;
  const source = tabStore.forPane(paneId);
  const target = tabStore.forPane(other);
  const tab = source.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;
  const duplicate = target.tabs.find((candidate) => representsSameDocument(candidate, tab));
  source.detach(tabId);
  if (duplicate) {
    target.updateTab(duplicate.id, { viewMode: tab.viewMode, renderMode: tab.renderMode });
    if (tab.pinned && !duplicate.pinned) target.togglePin(duplicate.id);
    sessionUiStateStore.restoreScrollPositions(duplicate.id, sessionUiStateStore.snapshot(tabId));
    sessionUiStateStore.deleteTab(tabId);
    if (
      duplicate.path !== tab.path &&
      !tabStore.allTabs.some((candidate) => candidate.path === tab.path)
    )
      contentStore.delete(tab.path);
    target.setActive(duplicate.id);
  } else target.addOrActivate(tab);
  if (!source.tabs.length) workspaceStore.removePane(paneId);
  workspaceStore.activate(other);
}

export function unsplitView(): void {
  const active = workspaceStore.activePaneId;
  const other = workspaceStore.otherPane(active);
  if (!other) return;
  const target = tabStore.forPane(active);
  const source = tabStore.forPane(other);
  const activeTabId = target.activeTabId;
  for (const tab of [...source.tabs]) {
    source.detach(tab.id);
    const duplicate = target.tabs.find((candidate) => representsSameDocument(candidate, tab));
    if (duplicate) {
      if (tab.pinned && !duplicate.pinned) target.togglePin(duplicate.id);
      sessionUiStateStore.deleteTab(tab.id);
      if (
        duplicate.path !== tab.path &&
        !tabStore.allTabs.some((candidate) => candidate.path === tab.path)
      )
        contentStore.delete(tab.path);
    } else target.addOrActivate(tab);
  }
  if (activeTabId) target.setActive(activeTabId);
  workspaceStore.removePane(other);
}

export function focusOtherPane(): void {
  const other = workspaceStore.otherPane(workspaceStore.activePaneId);
  if (other) {
    workspaceStore.activate(other);
    workspaceStore.root(other)?.focus({ preventScroll: true });
  }
}
