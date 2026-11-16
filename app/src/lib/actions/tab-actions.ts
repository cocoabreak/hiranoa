import { workspaceStore } from "$lib/stores/workspace.svelte";
import { sessionUiStateStore } from "$lib/stores/session-ui-state.svelte";
import { captureOpenTarget, type OpenTarget } from "./workspace-actions";
import { openMarkdownFile, openSourceMarkdown } from "$lib/actions/file-actions";
import { nativePathsEqual, registerZipSource } from "$lib/document-sources";
import { explorerStore } from "$lib/stores/explorer.svelte";
import { tabStore, type ClosedTabEntry } from "$lib/stores/tab.svelte";
import type { DocumentRef, DocumentSourceInfo } from "$lib/types";

function liveZipSource(entry: ClosedTabEntry): DocumentSourceInfo | undefined {
  const source = entry.tab.source;
  if (!source || source.kind !== "zip") return source;
  if (explorerStore.source?.id === source.id) return source;
  if (tabStore.allTabs.some((tab) => tab.source?.id === source.id)) return source;
  if (
    explorerStore.source?.kind === "zip" &&
    nativePathsEqual(explorerStore.source.nativePath, source.nativePath)
  ) {
    return explorerStore.source;
  }
  return undefined;
}

async function reopenSourceDocument(entry: ClosedTabEntry, target: OpenTarget): Promise<boolean> {
  const savedSource = entry.tab.source;
  const savedDocument = entry.tab.document;
  if (!savedSource || !savedDocument) {
    return openMarkdownFile(entry.tab.displayPath ?? entry.tab.path, target);
  }

  let source = savedSource;
  let document: DocumentRef = savedDocument;
  if (savedSource.kind === "zip") {
    source = liveZipSource(entry) ?? (await registerZipSource(savedSource.nativePath));
    document = { ...savedDocument, sourceId: source.id };
  }
  return openSourceMarkdown(document, source, undefined, target);
}

/** 直近に閉じたタブを、保存済みコンテンツではなく通常の安全な読み込み経路で開き直す。 */
export async function reopenRecentlyClosedTab(): Promise<boolean> {
  await tabStore.waitForCloseOperations();
  const entry = tabStore.takeRecentlyClosed();
  if (!entry) return false;
  const paneId =
    entry.paneId && workspaceStore.hasPane(entry.paneId)
      ? entry.paneId
      : workspaceStore.activePaneId;
  const tabs = tabStore.forPane(paneId);
  const target = captureOpenTarget(paneId);
  const existingIds = new Set(tabs.tabs.map((tab) => tab.id));

  try {
    if (!(await reopenSourceDocument(entry, target))) return false;
    const restored = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
    if (restored && !existingIds.has(restored.id)) {
      tabs.updateTab(restored.id, { viewMode: entry.tab.viewMode });
      sessionUiStateStore.restoreScrollPositions(restored.id, entry.scrollPositions);
      tabs.moveToIndex(restored.id, entry.index);
    }
    workspaceStore.activate(paneId);
    return true;
  } catch (error) {
    console.warn("閉じたタブを再度開けませんでした:", error);
    return false;
  }
}
