<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TocPanel from "$lib/components/TocPanel.svelte";
  import Titlebar from "$lib/components/Titlebar.svelte";
  import WorkspaceView from "$lib/components/WorkspaceView.svelte";
  import { workspaceStore } from "$lib/stores/workspace.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import SettingsPanel from "$lib/components/SettingsPanel.svelte";
  import Lightbox from "$lib/components/Lightbox.svelte";
  import SessionRestoreToast from "$lib/components/SessionRestoreToast.svelte";
  import AboutDialog from "$lib/components/AboutDialog.svelte";
  import WorkspaceLayoutsDialog from "$lib/components/WorkspaceLayoutsDialog.svelte";
  import UpdateNotification from "$lib/components/UpdateNotification.svelte";
  import QuickOpen from "$lib/components/QuickOpen.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import LinkPreviewPopover from "$lib/components/LinkPreviewPopover.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { tabStore } from "$lib/stores/tab.svelte";
  import { explorerStore } from "$lib/stores/explorer.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { lightboxStore } from "$lib/stores/lightbox.svelte";
  import { sessionRestorePromptStore } from "$lib/stores/session-restore-prompt.svelte";
  import { historyStore } from "$lib/stores/history.svelte";
  import { flushSettings, loadSettings } from "$lib/settings-store";
  import { flushRecent, loadRecent } from "$lib/recent-store";
  import { flushTabs, loadTabsOnStartup, saveAndFlushTabs, saveTabs } from "$lib/tabs-store";
  import { warmupHighlighter } from "$lib/markdown/engine";
  import { isMarkdownPath } from "$lib/markdown/extensions";
  import { normalizePath } from "$lib/utils";
  import {
    openLargeMarkdownInSafeModeForE2e,
    openMarkdownFile,
    openSourceMarkdown,
  } from "$lib/actions/file-actions";
  import { watchedDocuments } from "$lib/document-resources";
  import { captureOpenTarget } from "$lib/actions/workspace-actions";
  import { refreshDocumentViews } from "$lib/actions/refresh-document-views";
  import { SerializedTaskQueue } from "$lib/serialized-task-queue";
  import { refreshDirectory, reloadFolderTree } from "$lib/actions/explorer-actions";
  import { authorizeDevPath, authorizePath } from "$lib/actions/security";
  import { comboFromEvent, isPickerCommand, keymap } from "$lib/commands/keymap";
  import { runCommand } from "$lib/commands/registry";
  import { startCustomCss } from "$lib/custom-css/custom-css.svelte";
  import { startLocalFonts } from "$lib/local-fonts/local-fonts.svelte";
  import "$lib/commands/builtin";
  import { TOC_DRAWER_MEDIA_QUERY } from "$lib/responsive-toc";
  import type { DocumentSourceInfo } from "$lib/types";
  import { i18n } from "$lib/i18n/index.svelte";
  import { updateCheckStore } from "$lib/stores/update-check.svelte";
  import { pickerStore } from "$lib/stores/picker.svelte";
  import { linkInspectorStore } from "$lib/stores/links.svelte";
  import { linkPreviewStore } from "$lib/stores/link-preview.svelte";
  import { searchStore } from "$lib/stores/search.svelte";
  import { sessionUiStateStore } from "$lib/stores/session-ui-state.svelte";
  import {
    LINK_GRAPH_OPEN_DOCUMENT_EVENT,
    handleLinkGraphOpenRequest,
    type LinkGraphDocumentOpenRequest,
    type LinkGraphWindowContext,
    type LinkGraphWindowContextUpdate,
    type LinkGraphWindowSnapshot,
  } from "$lib/link-graph-window";

  // タブ復元完了前に空状態でtabs.jsonを上書きしないためのガード
  let hydrated = $state(false);
  let unlistenDragDrop: UnlistenFn | undefined;
  let unlistenCliArgs: UnlistenFn | undefined;
  let stopCustomCss: (() => void) | undefined;
  let stopLocalFonts: (() => void) | undefined;
  let unlistenCloseRequested: UnlistenFn | undefined;
  let unlistenLinkGraphOpenDocument: UnlistenFn | undefined;
  let linkGraphThemeObserver: MutationObserver | undefined;
  let linkGraphSessionReady = $state(false);
  let linkGraphSessionId = "";
  let linkGraphSequence = 0;
  let latestLinkGraphSnapshot: LinkGraphWindowSnapshot = {
    contextVersion: 0,
    context: null,
  };
  let closing = false;
  let reloading = false;
  let destroyed = false;
  let cliProcessingReady = false;
  let cliWakePending = false;
  let cliDrainChain = Promise.resolve();
  let compactToc = $state(false);
  let mediaCompactToc = $state(false);
  let contentWidth = $state(0);
  $effect(() => {
    compactToc =
      mediaCompactToc ||
      (workspaceStore.paneIds.length === 2 &&
        contentWidth > 0 &&
        contentWidth -
          (settingsStore.settings.sidebarVisible ? settingsStore.settings.sidebarWidth : 0) -
          (settingsStore.settings.tocVisible ? settingsStore.settings.tocWidth : 0) <
          850);
  });
  let tocMediaQuery: MediaQueryList | undefined;

  function syncTocLayout(event: MediaQueryList | MediaQueryListEvent) {
    mediaCompactToc = event.matches;
  }

  function currentLinkGraphContext(): LinkGraphWindowContext | null {
    const active = tabStore.tabs.find((tab) => tab.id === tabStore.activeTabId);
    if (!active?.document || !active.source) return null;
    return {
      document: active.document,
      paneId: workspaceStore.activePaneId,
      sourceGeneration: active.source.generation ?? 0,
      revision: linkInspectorStore.revision,
      showHiddenFiles: settingsStore.settings.showHiddenFiles,
      respectGitignore: settingsStore.settings.respectGitignore,
      includeWikiLinks: settingsStore.settings.renderers["wiki-links"] === true,
      locale: i18n.locale,
      dark: document.documentElement.classList.contains("dark"),
    };
  }

  function publishLinkGraphContext(): void {
    if (!linkGraphSessionReady) return;
    const update: LinkGraphWindowContextUpdate = {
      sessionId: linkGraphSessionId,
      sequence: ++linkGraphSequence,
      context: currentLinkGraphContext(),
    };
    void invoke<LinkGraphWindowSnapshot>("update_link_graph_window_context", { update })
      .then((snapshot) => {
        if (
          update.sessionId === linkGraphSessionId &&
          snapshot.contextVersion > latestLinkGraphSnapshot.contextVersion
        ) {
          latestLinkGraphSnapshot = snapshot;
        }
      })
      .catch((error) => {
        console.error("リンクグラフの表示対象を更新できませんでした:", error);
      });
  }

  async function reloadAfterSaving(): Promise<void> {
    if (reloading) return;
    reloading = true;
    await Promise.all([
      hydrated && !sessionRestorePromptStore.visible ? saveAndFlushTabs() : flushTabs(),
      flushRecent(),
      flushSettings(),
    ]);
    window.location.reload();
  }

  // DnDとCLI引数の共通処理。CLI listenerを起動初期化より先に登録できるよう、
  // onMountの外に置いている。
  async function processPaths(paths: string[]) {
    if (!paths || paths.length === 0) return;
    let folderOpened = false;
    const openTarget = captureOpenTarget();

    for (const rawPath of paths.slice(0, 32)) {
      const path = normalizePath(rawPath);
      try {
        const stat = await invoke<{ is_dir: boolean; is_file: boolean }>("stat_path", { path });
        if (!openTarget.valid()) return;
        if (!stat) continue;

        if (stat.is_dir && !folderOpened) {
          const { openFolder } = await import("$lib/actions/dialog-actions");
          if (!(await openFolder(path))) continue;
          sessionRestorePromptStore.hide();
          folderOpened = true;
        } else if (stat.is_file) {
          if (isMarkdownPath(path)) {
            if (!(await authorizePath(path))) continue;
            await openMarkdownFile(path, openTarget);
            sessionRestorePromptStore.hide();
          } else if (path.toLowerCase().endsWith(".zip") && !folderOpened) {
            const { openArchive } = await import("$lib/actions/dialog-actions");
            if (!(await openArchive(path))) continue;
            folderOpened = true;
          }
        }
      } catch (err) {
        console.error("パスの処理に失敗:", err);
      }
    }
  }

  /**
   * 起動初期化中は通知だけ記録し、タブ復元等の完了後にRust側キューを回収する。
   * 通知が重なってもget_cli_argsとprocessPathsを常に直列実行する。
   */
  function scheduleCliDrain(): Promise<void> {
    cliWakePending = true;
    if (!cliProcessingReady || sessionRestorePromptStore.restoring || uiStore.gitHistory)
      return cliDrainChain;

    cliDrainChain = cliDrainChain.then(async () => {
      if (!cliWakePending || destroyed || sessionRestorePromptStore.restoring || uiStore.gitHistory)
        return;
      cliWakePending = false;
      try {
        const args = await invoke<string[]>("get_cli_args");
        await processPaths(args);
      } catch (error) {
        console.error("CLI引数の取得に失敗:", error);
      }
    });
    return cliDrainChain;
  }

  // 起動時に設定を読み込む
  onMount(async () => {
    const graphSessionId = crypto.randomUUID();
    linkGraphSessionId = graphSessionId;
    void invoke<LinkGraphWindowSnapshot>("begin_link_graph_window_context_session", {
      sessionId: graphSessionId,
    })
      .then((snapshot) => {
        if (destroyed || linkGraphSessionId !== graphSessionId) return;
        latestLinkGraphSnapshot = snapshot;
        linkGraphSessionReady = true;
        publishLinkGraphContext();
      })
      .catch((error) => {
        console.error("リンクグラフの同期を開始できませんでした:", error);
      });

    tocMediaQuery = window.matchMedia(TOC_DRAWER_MEDIA_QUERY);
    syncTocLayout(tocMediaQuery);
    tocMediaQuery.addEventListener("change", syncTocLayout);

    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (sessionRestorePromptStore.restoring) return;
        if (closing) return;
        closing = true;
        await Promise.all([
          hydrated && !sessionRestorePromptStore.visible ? saveAndFlushTabs() : flushTabs(),
          flushRecent(),
          flushSettings(),
        ]);
        await invoke("close_link_graph_window").catch(() => {});
        unlistenCloseRequested?.();
        unlistenCloseRequested = undefined;
        await getCurrentWindow().close();
      })
      .then((unlisten) => {
        if (destroyed) unlisten();
        else unlistenCloseRequested = unlisten;
      });

    void listen<LinkGraphDocumentOpenRequest>(LINK_GRAPH_OPEN_DOCUMENT_EVENT, (event) => {
      if (uiStore.layoutsOpen || uiStore.gitHistory || sessionRestorePromptStore.restoring) return;
      const currentSnapshot = {
        ...latestLinkGraphSnapshot,
        context: currentLinkGraphContext(),
      };
      const active = tabStore.tabs.find((tab) => tab.id === tabStore.activeTabId);
      if (!active?.source) return;
      void handleLinkGraphOpenRequest(
        event.payload,
        currentSnapshot,
        active.source,
        openSourceMarkdown,
        async (error, target) => {
          const { message } = await import("@tauri-apps/plugin-dialog");
          await message(i18n.m.dialog.openFileFailed(target.path, error), {
            title: i18n.m.common.error,
            kind: "error",
          });
        }
      );
    }).then((unlisten) => {
      if (destroyed) unlisten();
      else unlistenLinkGraphOpenDocument = unlisten;
    });
    linkGraphThemeObserver = new MutationObserver(publishLinkGraphContext);
    linkGraphThemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // 引数本体はRust側のキューにあり、このイベントは起床通知に過ぎない。
    // 通知を再読み込み中に取りこぼしても、下の初期回収で復元できる。
    const cliListener = listen("open-cli-args", () => {
      void scheduleCliDrain();
    });

    // ファイル/フォルダ選択でユーザーが数秒操作している間にshikiの初期化を
    // 終わらせておくため、待たずに開始する（初回レンダリングの体感待ちを削減）
    warmupHighlighter();
    const [cliUnlisten, , , sessionResult] = await Promise.all([
      cliListener,
      loadSettings(),
      loadRecent(),
      loadTabsOnStartup(),
    ]);
    if (destroyed) {
      cliUnlisten();
      return;
    }
    unlistenCliArgs = cliUnlisten;
    if (sessionResult.promptRestore) sessionRestorePromptStore.show();
    const stopFonts = await startLocalFonts();
    if (destroyed) {
      stopFonts();
      return;
    }
    stopLocalFonts = stopFonts;
    const stopCss = await startCustomCss();
    if (destroyed) {
      stopCss();
      return;
    }
    stopCustomCss = stopCss;
    hydrated = true;
    if (settingsStore.settings.checkForUpdatesOnStartup) {
      void updateCheckStore.check({ silent: true });
    }

    // ドラッグ＆ドロップ対応
    void listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      if (uiStore.layoutsOpen || uiStore.gitHistory || sessionRestorePromptStore.restoring) return;
      await processPaths(event.payload.paths);
    }).then((un) => {
      if (destroyed) un();
      else unlistenDragDrop = un;
    });

    // 初回引数と、listener登録前/初期化中に保留されたCLI引数をまとめて処理する。
    cliProcessingReady = true;
    await scheduleCliDrain();

    if (import.meta.env.DEV) {
      (
        window as unknown as {
          __e2e: {
            openMarkdownFile: (path: string) => Promise<void>;
            openLargeMarkdownInSafeMode: (path: string) => Promise<void>;
            openArchive: (path: string) => Promise<void>;
            openArchiveEntry: (documentPath: string) => Promise<void>;
            showUpdateAvailable: () => void;
            resetSession: () => Promise<void>;
            flushSession: () => Promise<void>;
            getState: () => unknown;
          };
        }
      ).__e2e = {
        openMarkdownFile: async (path: string) => {
          await authorizeDevPath(path);
          await openMarkdownFile(path);
        },
        openLargeMarkdownInSafeMode: async (path: string) => {
          await authorizeDevPath(path);
          await openLargeMarkdownInSafeModeForE2e(path);
        },
        openArchive: async (path: string) => {
          await authorizeDevPath(path);
          const { openArchive } = await import("$lib/actions/dialog-actions");
          await openArchive(path);
        },
        openArchiveEntry: async (documentPath: string) => {
          const source = explorerStore.source;
          if (!source || source.kind !== "zip") throw new Error("ZIP Explorerが開かれていません");
          await openSourceMarkdown({ sourceId: source.id, path: documentPath }, source);
        },
        showUpdateAvailable: () => {
          updateCheckStore.setResultForE2e({
            currentVersion: "0.1.0",
            latestVersion: "9.9.9",
            updateAvailable: true,
            releaseUrl: "https://example.invalid/hiranoa/releases/9.9.9",
          });
        },
        resetSession: async () => {
          const source = explorerStore.source;
          for (const tab of [...tabStore.allTabs].reverse()) await tabStore.closeAndUnwatch(tab.id);
          explorerStore.clear();
          if (source) {
            await invoke("unwatch_path", { path: source.nativePath }).catch(() => {});
            await invoke("unregister_source", { sourceId: source.id }).catch(() => {});
          }
          searchStore.restoreSessionState(null);
          sessionUiStateStore.clear();
        },
        flushSession: saveAndFlushTabs,
        getState: () => {
          const activeTab = tabStore.tabs.find((tab) => tab.id === tabStore.activeTabId);
          return {
            hydrated,
            activeTab: activeTab
              ? {
                  path: activeTab.path,
                  title: activeTab.title,
                  renderMode: activeTab.renderMode ?? "full",
                }
              : null,
            search: searchStore.sessionState,
            scroll: activeTab ? sessionUiStateStore.snapshot(activeTab.id) : {},
          };
        },
      };
    }
  });

  onDestroy(() => {
    destroyed = true;
    cliProcessingReady = false;
    tocMediaQuery?.removeEventListener("change", syncTocLayout);
    if (unlistenDragDrop) unlistenDragDrop();
    if (unlistenCliArgs) unlistenCliArgs();
    stopCustomCss?.();
    stopLocalFonts?.();
    unlistenCloseRequested?.();
    unlistenLinkGraphOpenDocument?.();
    linkGraphThemeObserver?.disconnect();
    if (hydrated && !sessionRestorePromptStore.visible) void saveTabs();
    void Promise.all([flushTabs(), flushRecent(), flushSettings()]);
  });

  // タブの追加/削除/切替/ピン留め変更のたびに自動保存する（呼び忘れを防ぐため
  // 各操作箇所で明示的に呼ぶのではなく、リアクティブな監視に一本化している）。
  // セッション復元の確認トースト表示中は、まだ何も開いていない空状態で
  // tabs.jsonを上書きしてしまわないよう保存を止める
  $effect(() => {
    if (!hydrated || sessionRestorePromptStore.visible || sessionRestorePromptStore.restoring)
      return;
    for (const id of workspaceStore.paneIds) {
      void tabStore.forPane(id).tabs;
      void tabStore.forPane(id).activeTabId;
      void searchStore.forPane(id).sessionState;
    }
    void workspaceStore.activePaneId;
    void workspaceStore.splitRatio;
    void explorerStore.rootPath;
    void explorerStore.expandedDirs;
    void searchStore.open;
    void searchStore.query;
    void searchStore.useRegex;
    void sessionUiStateStore.version;
    void saveTabs();
  });

  // 表示ファイルの切替をナビゲーション履歴に記録する（リンク・タブ・エクスプローラー等、
  // 手段を問わず一元捕捉。tabs.json自動保存と同じ発想）。戻る/進む自体による切替は
  // historyStore.record内の連続重複チェックで無視される。
  // record内で履歴ストアのentries/indexを読むため、untrackしないとそれらが
  // このeffectの依存になり、step()によるindex変化で再発火して重複記録される
  $effect(() => {
    for (const id of workspaceStore.paneIds) {
      const tabs = tabStore.forPane(id);
      const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
      if (active) untrack(() => historyStore.forPane(id).record(active.path));
    }
  });

  $effect(() => {
    void workspaceStore.activePaneId;
    void tabStore.activeTabId;
    void tabStore.tabs;
    void linkInspectorStore.revision;
    void settingsStore.settings.showHiddenFiles;
    void settingsStore.settings.respectGitignore;
    void settingsStore.settings.renderers["wiki-links"];
    void settingsStore.settings.theme;
    void i18n.locale;
    publishLinkGraphContext();
  });

  // マウスの戻る/進むボタン（XButton1/2）で履歴を移動する
  $effect(() => {
    function handleMouseUp(e: MouseEvent) {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      runCommand(e.button === 3 ? "nav.back" : "nav.forward");
    }

    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  });

  // グローバルキーボードショートカット
  $effect(() => {
    if (!sessionRestorePromptStore.restoring && !uiStore.gitHistory && hydrated && cliWakePending) {
      untrack(() => {
        void scheduleCliDrain();
      });
    }
  });

  $effect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (uiStore.layoutsOpen || uiStore.gitHistory) {
        if (uiStore.gitHistory && keymap[comboFromEvent(e) ?? ""]) e.preventDefault();
        if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r"))
          e.preventDefault();
        return;
      }
      const target = e.target as HTMLElement;
      const reloadShortcut =
        e.key === "F5" ||
        (!e.altKey && !e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r");
      if (reloadShortcut) {
        e.preventDefault();
        void reloadAfterSaving();
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const commandId = keymap[combo];
      if (!commandId) return;
      if (
        target.matches("input, textarea, [contenteditable='true']") &&
        !isPickerCommand(commandId)
      ) {
        return;
      }

      e.preventDefault();
      runCommand(commandId);
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });

  // ファイル監視イベントのセットアップ
  $effect(() => {
    const unlistenFns: UnlistenFn[] = [];
    const zipReloadQueue = new SerializedTaskQueue<string>();
    let disposed = false;

    function keepListener(promise: Promise<UnlistenFn>): void {
      void promise.then((unlisten) => {
        if (disposed) unlisten();
        else unlistenFns.push(unlisten);
      });
    }

    keepListener(
      listen<string>("file-changed", async (event) => {
        linkInspectorStore.invalidate();
        linkPreviewStore.invalidateAll();
        const changedPath = event.payload;
        try {
          const { archives: zipSources, nativeTabs } = watchedDocuments(
            changedPath,
            tabStore.allTabs,
            explorerStore.source
          );
          if (zipSources.size > 0) {
            await Promise.all(
              [...zipSources.values()].map((source) =>
                zipReloadQueue.enqueue(source.id, async () => {
                  let refreshedSource: DocumentSourceInfo;
                  try {
                    refreshedSource = await invoke<DocumentSourceInfo>("reload_zip_source", {
                      sourceId: source.id,
                    });
                  } catch {
                    // アトミック保存の途中で一時的に不完全なZIPが見える場合だけ、短く1回再試行する。
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    try {
                      refreshedSource = await invoke<DocumentSourceInfo>("reload_zip_source", {
                        sourceId: source.id,
                      });
                    } catch (error) {
                      alert(i18n.m.dialog.archiveReloadFailed(source.nativePath, error));
                      return;
                    }
                  }
                  explorerStore.updateSource(refreshedSource);
                  for (const candidate of tabStore.allTabs.filter(
                    (tab) => tab.source?.id === source.id
                  )) {
                    tabStore.updateTab(candidate.id, { source: refreshedSource });
                  }
                  if (explorerStore.source?.id === source.id) await reloadFolderTree();
                  await refreshDocumentViews(
                    tabStore.allTabs.filter((candidate) => candidate.source?.id === source.id),
                    true
                  );
                })
              )
            );
            return;
          }
          await refreshDocumentViews(nativeTabs);
        } catch {
          // 読み込み失敗時は無視
        }
      })
    );

    keepListener(
      listen<string>("file-deleted", (event) => {
        linkInspectorStore.invalidate();
        linkPreviewStore.invalidateAll();
        const deletedPath = event.payload;
        const { archives, nativeTabs } = watchedDocuments(
          deletedPath,
          tabStore.allTabs,
          explorerStore.source
        );
        const matchingTabs = archives.size
          ? tabStore.allTabs.filter((tab) => tab.source && archives.has(tab.source.id))
          : nativeTabs;
        for (const tab of matchingTabs) {
          tabStore.updateTab(tab.id, { status: "deleted" });
        }
      })
    );

    // エクスプローラー表示中レベルのファイル増減（explorer-watch）
    keepListener(
      listen<string>("directory-changed", (event) => {
        linkInspectorStore.invalidate();
        linkPreviewStore.invalidateAll();
        void refreshDirectory(event.payload);
      })
    );

    keepListener(
      listen<string>("menu-action", (event) => {
        if (uiStore.layoutsOpen || uiStore.gitHistory || sessionRestorePromptStore.restoring)
          return;
        runCommand(event.payload);
      })
    );

    return () => {
      disposed = true;
      unlistenFns.forEach((fn) => fn());
    };
  });
</script>

<div class="print-expand flex h-screen flex-col overflow-hidden bg-background text-foreground">
  <Titlebar />
  <div bind:clientWidth={contentWidth} class="print-expand relative flex min-h-0 flex-1">
    {#if settingsStore.settings.sidebarVisible}
      <Sidebar />
    {/if}

    <WorkspaceView />

    <TocPanel compact={compactToc} />
  </div>

  <StatusBar />
</div>

{#if uiStore.settingsPanelOpen}
  <SettingsPanel onclose={() => uiStore.closeSettings()} />
{/if}

{#if uiStore.aboutDialogOpen}
  <AboutDialog onclose={() => uiStore.closeAbout()} />
{/if}

{#if uiStore.layoutsOpen}
  <WorkspaceLayoutsDialog onclose={() => uiStore.closeLayouts()} />
{/if}

{#if uiStore.gitHistory}
  {#await import("$lib/components/GitHistoryView.svelte") then module}
    <module.default
      document={uiStore.gitHistory.document}
      title={uiStore.gitHistory.title}
      onclose={() => uiStore.closeGitHistory()}
    />
  {/await}
{/if}

{#if lightboxStore.open}
  <Lightbox />
{/if}

{#if pickerStore.mode === "quickOpen"}
  <QuickOpen />
{:else if pickerStore.mode === "commandPalette"}
  <CommandPalette />
{/if}

<SessionRestoreToast />
<UpdateNotification />
<LinkPreviewPopover />
