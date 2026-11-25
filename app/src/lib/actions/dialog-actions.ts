import { captureOpenTarget } from "./workspace-actions";
import { workspaceStore } from "$lib/stores/workspace.svelte";
import { withRegisteredArchive, releaseArchive, ensureWatch } from "$lib/document-resources";
import { invoke } from "@tauri-apps/api/core";
import { explorerStore } from "$lib/stores/explorer.svelte";
import { settingsStore } from "$lib/stores/settings.svelte";
import { recentStore } from "$lib/stores/recent.svelte";
import { saveRecent } from "$lib/recent-store";
import { openMarkdownFile } from "$lib/actions/file-actions";
import { syncDirWatches } from "$lib/actions/explorer-actions";
import { authorizeArchivePath, authorizeFolderPath } from "$lib/actions/security";
import { sessionRestorePromptStore } from "$lib/stores/session-restore-prompt.svelte";
import { tabStore } from "$lib/stores/tab.svelte";
import { i18n } from "$lib/i18n/index.svelte";
import { listSourceEntries, registerNativeSource, rootDocument } from "$lib/document-sources";
/** ファイル選択ダイアログを開き、選択されたMarkdownファイルをタブで開く */
export async function openFileDialog(): Promise<void> {
  const target = captureOpenTarget();
  let selectedPath = "";
  try {
    const path = await invoke<string | null>("pick_markdown_file");
    if (!path) return;
    selectedPath = path;
    await openMarkdownFile(path, target);
    // 明示的にファイルを開いたら、前回セッションの復元プロンプトは閉じる
    sessionRestorePromptStore.hide();
  } catch (err) {
    alert(i18n.m.dialog.openFileFailed(selectedPath, err));
  }
}

/** 指定パスをエクスプローラーのルートとして開く */
export async function openFolder(path: string): Promise<boolean> {
  const version = workspaceStore.layoutVersion;
  if (!(await authorizeFolderPath(path))) return false;
  // ルート直下1階層のみ読み込む。サブフォルダは展開時に遅延取得する
  const source = await registerNativeSource(path);
  const tree = await listSourceEntries(
    rootDocument(source),
    settingsStore.settings.respectGitignore
  );
  if (version !== workspaceStore.layoutVersion) return false;
  const previousSource = explorerStore.source;
  explorerStore.setRoot(path, tree, source);
  await releaseArchive(previousSource, () => tabStore.allTabs);
  // 表示中レベル（この時点ではルートのみ）のファイル増減監視を張り直す
  await syncDirWatches();
  if (!settingsStore.settings.sidebarVisible) {
    settingsStore.toggleSidebar();
  }
  recentStore.addFolder(path);
  void saveRecent();
  return true;
}

/** ZIPを読み取り専用ドキュメントソースとしてExplorerへ開く */
export async function openArchive(path: string): Promise<boolean> {
  const version = workspaceStore.layoutVersion;
  if (!(await authorizeArchivePath(path))) return false;
  const opened = await withRegisteredArchive(
    path,
    () => tabStore.allTabs,
    async (source) => {
      const tree = await listSourceEntries(rootDocument(source), false);
      if (version !== workspaceStore.layoutVersion) return false;
      for (const tab of tabStore.allTabs) {
        if (tab.source?.id === source.id) tabStore.updateTab(tab.id, { source });
      }
      const previousSource = explorerStore.source;
      explorerStore.setRoot(path, tree, source);
      if (previousSource?.id !== source.id)
        await releaseArchive(previousSource, () => tabStore.allTabs);
      await ensureWatch({ path: source.nativePath, archive: source }, () => tabStore.allTabs).catch(
        () => {}
      );
      return true;
    }
  );
  if (!opened) return false;
  await syncDirWatches();
  if (!settingsStore.settings.sidebarVisible) settingsStore.toggleSidebar();
  sessionRestorePromptStore.hide();
  recentStore.addArchive(path);
  void saveRecent();
  return true;
}

export async function openArchiveDialog(): Promise<void> {
  const version = workspaceStore.layoutVersion;
  let selectedPath = "";
  try {
    const path = await invoke<string | null>("pick_zip_file");
    if (!path || version !== workspaceStore.layoutVersion) return;
    selectedPath = path;
    await openArchive(path);
  } catch (err) {
    alert(i18n.m.dialog.openArchiveFailed(selectedPath, err));
  }
}

/** フォルダ選択ダイアログを開き、選択されたフォルダをエクスプローラーのルートにする */
export async function openFolderDialog(): Promise<void> {
  const version = workspaceStore.layoutVersion;
  let selectedPath = "";
  try {
    const path = await invoke<string | null>("pick_folder");
    if (!path || version !== workspaceStore.layoutVersion) return;
    selectedPath = path;
    if (!(await openFolder(path))) return;
    // 明示的にフォルダを開いたら、前回セッションの復元プロンプトは閉じる
    sessionRestorePromptStore.hide();
  } catch (err) {
    alert(i18n.m.dialog.openFolderFailed(selectedPath, err));
  }
}
