import { sessionRestorePromptStore } from "$lib/stores/session-restore-prompt.svelte";
import { workspaceStore } from "$lib/stores/workspace.svelte";
import { captureOpenTarget } from "$lib/actions/workspace-actions";
import { normalizeSession, type PersistedSession } from "$lib/session-schema";
import { invoke } from "@tauri-apps/api/core";
import { tabStore } from "$lib/stores/tab.svelte";
import { explorerStore } from "$lib/stores/explorer.svelte";
import { openArchive, openFolder } from "$lib/actions/dialog-actions";
import {
  restoreExpandedDirectories,
  sanitizeExpandedDirectories,
} from "$lib/actions/explorer-actions";
import { authorizeArchivePath, authorizePath } from "$lib/actions/security";
import { openMarkdownFile, openSourceMarkdown } from "$lib/actions/file-actions";
import { nativeDocumentPath, registerNativeSource } from "$lib/document-sources";
import { withRegisteredArchive } from "$lib/document-resources";
import type { DocumentSourceInfo } from "$lib/types";
import { LatestSaveQueue } from "$lib/state-save-queue";
import { sessionUiStateStore } from "$lib/stores/session-ui-state.svelte";
import { searchStore } from "$lib/stores/search.svelte";

const tabsSaveQueue = new LatestSaveQueue<PersistedSession>(
  (value) => invoke("save_app_state", { kind: "tabs", value }),
  200
);

async function loadSession(): Promise<PersistedSession> {
  return normalizeSession(await invoke<unknown>("load_app_state", { kind: "tabs" }));
}

export function restoredActiveTabId(
  restoredTabIds: ReadonlyMap<number, string>,
  activeIndex: number | null
): string | null {
  return activeIndex === null ? null : (restoredTabIds.get(activeIndex) ?? null);
}

/** 保存済みのタブ一覧・アクティブタブ・エクスプローラーのルートフォルダを実際に開き直す */
export async function restoreSavedTabs(): Promise<void> {
  if (sessionRestorePromptStore.restoring) return;
  sessionRestorePromptStore.beginRestore();
  try {
    await restoreSessionSnapshot(await loadSession());
  } catch (e) {
    console.warn("タブの復元に失敗しました:", e);
  } finally {
    sessionRestorePromptStore.endRestore();
  }
}

/** Caller owns the restore/save guard. Documents use the normal authorization path. */
export async function restoreSessionSnapshot(session: PersistedSession): Promise<void> {
  if (!session.workspace) return;
  const sourceCache = new Map<string, DocumentSourceInfo>();
  const restoredPanes = new Map<number, string>();
  const positions: { id: string; value: unknown }[] = [];

  if (session.explorer) {
    const opened =
      session.explorer.kind === "zip"
        ? await openArchive(session.explorer.nativePath).catch(() => false)
        : await openFolder(session.explorer.nativePath).catch(() => false);
    if (opened) {
      const source = explorerStore.source;
      if (source) {
        sourceCache.set(`${session.explorer.kind}:${session.explorer.nativePath}`, source);
      }
    }
  }

  for (const [paneIndex, savedPane] of session.workspace.panes.entries()) {
    const paneId = paneIndex === 0 ? workspaceStore.paneIds[0] : workspaceStore.addPane();
    if (!paneId) continue;
    const tabs = tabStore.forPane(paneId);
    const restoredTabIds = new Map<number, string>();
    for (const [
      savedIndex,
      { path, pinned, source: persistedSource, documentPath, scrollPositions, viewMode },
    ] of savedPane.tabs.entries()) {
      try {
        if (!path) continue;
        if (!persistedSource || documentPath === undefined) {
          if (!(await authorizePath(path))) continue;
          if (!(await openMarkdownFile(path, captureOpenTarget(paneId)))) continue;
        } else {
          const cacheKey = `${persistedSource.kind}:${persistedSource.nativePath}`;
          const open = async (source: DocumentSourceInfo) => {
            const opened = await openSourceMarkdown(
              { sourceId: source.id, path: documentPath },
              source,
              undefined,
              captureOpenTarget(paneId)
            );
            if (opened) sourceCache.set(cacheKey, source);
            return opened;
          };
          const source = sourceCache.get(cacheKey);
          if (!source) {
            const accessPath =
              persistedSource.kind === "native"
                ? nativeDocumentPath(
                    {
                      id: "restore",
                      label: "",
                      nativePath: persistedSource.nativePath,
                      kind: "native",
                      capabilities: {
                        watch: "entries",
                        externalEditor: true,
                        respectGitignore: true,
                        fullTextSearch: true,
                        wikiLinks: true,
                      },
                    },
                    { sourceId: "restore", path: documentPath }
                  )
                : persistedSource.nativePath;
            if (
              !accessPath ||
              !(persistedSource.kind === "zip"
                ? await authorizeArchivePath(accessPath)
                : await authorizePath(accessPath))
            )
              continue;
            const opened =
              persistedSource.kind === "native"
                ? await open(await registerNativeSource(persistedSource.nativePath))
                : await withRegisteredArchive(
                    persistedSource.nativePath,
                    () => tabStore.allTabs,
                    open
                  );
            if (!opened) continue;
          } else if (!(await open(source))) continue;
        }
        const restored = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
        if (restored) {
          restoredTabIds.set(savedIndex, restored.id);
          tabs.updateTab(restored.id, { viewMode });
          positions.push({ id: restored.id, value: scrollPositions });
          if (pinned !== !!restored.pinned) tabs.togglePin(restored.id);
        }
      } catch {
        continue;
      }
    }

    const restoredId = restoredActiveTabId(restoredTabIds, savedPane.activeIndex ?? null);
    if (restoredId) tabs.setActive(restoredId);
    searchStore.forPane(paneId).restoreSessionState(savedPane.search);
    if (tabs.tabs.length) restoredPanes.set(paneIndex, paneId);
    else workspaceStore.removePane(paneId);
  }
  for (const id of [...workspaceStore.paneIds]) {
    if (!tabStore.forPane(id).tabs.length) workspaceStore.removePane(id);
  }
  const activePane =
    restoredPanes.get(session.workspace.activePaneIndex) ?? restoredPanes.values().next().value;
  if (activePane) workspaceStore.activate(activePane);
  workspaceStore.setRatio(session.workspace.splitRatio);

  await restoreExpandedDirectories(session.expandedDirs);
  // Restore after the final pane geometry and all asynchronous document loads settle.
  for (const { id, value } of positions) sessionUiStateStore.restoreScrollPositions(id, value);
}

/** 保存済みタブを使わない場合に呼ぶ。tabs.jsonの内容を即座に破棄する */
export async function discardSavedTabs(): Promise<void> {
  try {
    void tabsSaveQueue.enqueue({
      tabs: [],
      activeIndex: null,
      explorer: null,
      expandedDirs: [],
      search: { open: false, query: "", useRegex: false },
    });
    await tabsSaveQueue.flush();
  } catch (e) {
    console.warn("保存済みタブの破棄に失敗しました:", e);
  }
}

/**
 * 起動時に呼ぶ。Ctrl+R/F5によるリロード（Rustプロセスは継続）の場合は
 * 従来通り即座に復元する。アプリの実際の起動（プロセスの初回起動）の場合は
 * 自動復元せず、保存済みタブがあるかどうかだけを返す
 * （呼び出し側でユーザーに復元するか確認する）。
 */
export async function loadTabsOnStartup(): Promise<{ promptRestore: boolean }> {
  let freshLaunch: boolean;
  try {
    freshLaunch = await invoke<boolean>("is_fresh_launch");
  } catch {
    freshLaunch = false; // 判定できない場合は従来通り即復元する
  }

  if (!freshLaunch) {
    if ((await loadSession().catch(() => ({}) as PersistedSession)).schemaVersion === -1)
      return { promptRestore: true };
    await restoreSavedTabs();
    return { promptRestore: false };
  }

  try {
    const session = await loadSession();
    return {
      promptRestore:
        session.schemaVersion === -1 ||
        !!session.workspace?.panes.some((pane) => pane.tabs.length > 0) ||
        !!session.explorer,
    };
  } catch {
    return { promptRestore: false };
  }
}

/** 現在開いているタブ一覧・アクティブタブ・エクスプローラーのルートフォルダをディスクに保存する */
export async function saveTabs(): Promise<void> {
  if (sessionRestorePromptStore.restoring) return;
  try {
    await tabsSaveQueue.enqueue(captureSessionSnapshot());
  } catch (e) {
    console.warn("タブの保存に失敗しました:", e);
  }
}

export function captureSessionSnapshot(): PersistedSession {
  return {
    schemaVersion: 2,
    workspace: {
      panes: workspaceStore.paneIds.map((id) => {
        const tabs = tabStore.forPane(id);
        return {
          tabs: tabs.tabs.map((t) => ({
            path: t.displayPath ?? t.path,
            pinned: !!t.pinned,
            source: t.source ? { kind: t.source.kind, nativePath: t.source.nativePath } : undefined,
            documentPath: t.document?.path,
            scrollPositions: sessionUiStateStore.snapshot(t.id),
            viewMode: t.viewMode ?? "rendered",
          })),
          activeIndex: tabs.tabs.findIndex((t) => t.id === tabs.activeTabId),
          search: searchStore.forPane(id).sessionState,
        };
      }),
      activePaneIndex: workspaceStore.paneIds.indexOf(workspaceStore.activePaneId),
      splitRatio: workspaceStore.splitRatio,
    },
    explorer: explorerStore.source
      ? { kind: explorerStore.source.kind, nativePath: explorerStore.source.nativePath }
      : null,
    expandedDirs: sanitizeExpandedDirectories([...explorerStore.expandedDirs]),
  };
}

export async function flushTabs(): Promise<void> {
  try {
    await tabsSaveQueue.flush();
  } catch (error) {
    console.warn("タブの保存flushに失敗しました:", error);
  }
}

/** 終了時にリアクティブな保存通知を待たず、最新snapshotを確実に永続化する。 */
export async function saveAndFlushTabs(): Promise<void> {
  const saving = saveTabs();
  await flushTabs();
  await saving;
}
