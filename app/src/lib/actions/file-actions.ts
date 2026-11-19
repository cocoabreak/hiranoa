import { captureOpenTarget, type OpenTarget } from "./workspace-actions";
import { MAX_WORKSPACE_TABS, workspaceStore } from "$lib/stores/workspace.svelte";
import {
  retainPendingSource,
  retainPendingPath,
  hasPendingPath,
  hasPendingSource,
  reconcileDocumentResource,
} from "$lib/document-resources";
import { explorerStore } from "$lib/stores/explorer.svelte";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { tabStore } from "$lib/stores/tab.svelte";
import { contentStore } from "$lib/stores/content.svelte";
import { recentStore } from "$lib/stores/recent.svelte";
import { settingsStore } from "$lib/stores/settings.svelte";
import { saveRecent } from "$lib/recent-store";
import { i18n } from "$lib/i18n/index.svelte";
import { basename } from "$lib/utils";
import type { DocumentRef, DocumentSourceInfo } from "$lib/types";
import {
  displayDocumentPath,
  documentKey,
  nativeDocumentIdentity,
  nativeDocumentPath,
  rememberDocument,
  registerNativeDocument,
} from "$lib/document-sources";
import {
  LargeMarkdownApprovalSession,
  type LoadedMarkdown,
  type MarkdownLoadOptions,
  type MarkdownFileContent,
} from "$lib/actions/large-markdown";

const largeMarkdownApprovals = new LargeMarkdownApprovalSession();
type LargeMarkdownConfirm = () => Promise<boolean>;

function confirmLargeMarkdown(result: MarkdownFileContent, name: string): Promise<boolean> {
  return ask(
    i18n.m.dialog.largeMarkdownSafePrompt(name, (result.byteSize / 1024 / 1024).toFixed(1)),
    {
      title: i18n.m.dialog.largeMarkdownTitle,
      kind: "warning",
    }
  );
}

export async function readMarkdownFile(
  path: string,
  options: MarkdownLoadOptions = {},
  confirm?: LargeMarkdownConfirm
): Promise<LoadedMarkdown | undefined> {
  const result = await invoke<MarkdownFileContent>("read_file", { path });
  return largeMarkdownApprovals.load(path, result, options, () =>
    confirm ? confirm() : confirmLargeMarkdown(result, basename(path))
  );
}

export async function readSourceMarkdown(
  document: DocumentRef,
  key: string,
  options: MarkdownLoadOptions = {},
  confirm?: LargeMarkdownConfirm
): Promise<LoadedMarkdown | undefined> {
  const result = await invoke<MarkdownFileContent>("read_source_markdown", { document });
  return largeMarkdownApprovals.load(key, result, options, () =>
    confirm ? confirm() : confirmLargeMarkdown(result, basename(document.path))
  );
}

export async function approveLargeMarkdownFullRender(path: string): Promise<boolean> {
  return largeMarkdownApprovals.approveFull(path, () =>
    ask(i18n.m.dialog.largeMarkdownFullPrompt(basename(path)), {
      title: i18n.m.dialog.largeMarkdownTitle,
      kind: "warning",
    })
  );
}

/**
 * Markdownファイルを開いてタブに追加し、ファイル監視を開始する。
 * この関数自身は信頼ルートの登録を行わない（read_fileはRust側のAllowedRoots配下のみ許可）。
 * 信頼登録は明示的な操作（フォルダ/ファイルを開く、リンク先の信頼確認）でのみ行うことで、
 * 悪意あるリンク経由でopenMarkdownFileが呼ばれても勝手に信頼範囲を広げないようにする。
 */
export async function openMarkdownFile(
  path: string,
  target = captureOpenTarget()
): Promise<boolean> {
  const [source, document] = await registerNativeDocument(path);
  return openSourceMarkdown(document, source, undefined, target);
}

export async function openLargeMarkdownInSafeModeForE2e(path: string): Promise<boolean> {
  if (!import.meta.env.DEV) throw new Error("E2Eフックはdevビルドでのみ利用できます");
  const [source, document] = await registerNativeDocument(path);
  return openSourceMarkdown(document, source, async () => true);
}

export async function openSourceMarkdown(
  document: DocumentRef,
  source: DocumentSourceInfo,
  confirm?: LargeMarkdownConfirm,
  target: OpenTarget = captureOpenTarget()
): Promise<boolean> {
  const release = retainPendingSource(source.id);
  const nativePath = nativeDocumentPath(source, document);
  const watchPath =
    nativePath ?? (source.capabilities.watch === "container" ? source.nativePath : null);
  const releasePath = watchPath ? retainPendingPath(watchPath) : () => {};
  const isUsed = () =>
    nativePath
      ? hasPendingPath(nativePath) ||
        tabStore.allTabs.some(
          (tab) =>
            !!tab.document &&
            !!tab.source &&
            nativeDocumentIdentity(tab.source, tab.document) ===
              nativeDocumentIdentity(source, document)
        )
      : hasPendingSource(source.id) ||
        explorerStore.source?.id === source.id ||
        tabStore.allTabs.some((tab) => tab.source?.id === source.id);
  try {
    const key = documentKey(document);
    const displayPath = displayDocumentPath(source, document);
    const title = basename(document.path);
    let loaded: LoadedMarkdown;
    try {
      const result = await readSourceMarkdown(document, key, {}, confirm);
      if (result === undefined) return false;
      loaded = result;
    } catch (err) {
      throw new Error(`ファイルを開けませんでした: ${displayPath}`, { cause: err });
    }
    if (!target.valid()) return false;
    if (
      tabStore.allTabs.length >= MAX_WORKSPACE_TABS &&
      (!target.paneId ||
        !tabStore
          .forPane(target.paneId)
          .tabs.some(
            (tab) =>
              tab.path === key ||
              (tab.document &&
                tab.source &&
                nativeDocumentIdentity(tab.source, tab.document) !== null &&
                nativeDocumentIdentity(tab.source, tab.document) ===
                  nativeDocumentIdentity(source, document))
          ))
    )
      return false;
    const paneId = target.commit();
    if (!paneId) return false;
    const tabs = tabStore.forPane(paneId);
    const nativeIdentity = nativeDocumentIdentity(source, document);
    const existing = tabs.tabs.find((tab) => {
      if (tab.path === key) return true;
      if (!nativeIdentity || !tab.document || !tab.source) return false;
      return nativeDocumentIdentity(tab.source, tab.document) === nativeIdentity;
    });
    const tabKey = existing?.path ?? key;
    if (!existing || existing.path === key) rememberDocument(document, source);
    contentStore.set(tabKey, {
      raw: loaded.raw,
      safeOutline: loaded.safeOutline,
      safeOutlineTruncated: loaded.safeOutlineTruncated,
    });

    const isNew = !existing;
    if (existing) {
      tabs.updateTab(existing.id, { renderMode: loaded.renderMode, status: "ok" });
      tabs.setActive(existing.id, false);
    } else {
      tabs.addOrActivate({
        id: crypto.randomUUID(),
        path: key,
        document,
        source,
        displayPath,
        title,
        renderMode: loaded.renderMode,
      });
    }

    if (isNew) {
      if (watchPath) await reconcileDocumentResource(watchPath, isUsed);
    }

    if (source.kind === "native") {
      recentStore.addFile(displayPath);
      void saveRecent();
    }
    return (
      target.valid() &&
      workspaceStore.hasPane(paneId) &&
      tabs.tabs.some((tab) => tab.id === tabs.activeTabId && tab.path === tabKey)
    );
  } finally {
    releasePath();
    release();
    if (watchPath && !isUsed())
      await reconcileDocumentResource(
        watchPath,
        isUsed,
        source.kind === "zip" ? source.id : undefined
      );
  }
}

/** 外部のデフォルトエディター（VS Codeなど）でファイルを開く */
export async function openExternalEditor(targetPath?: string): Promise<void> {
  const activeTab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId);
  const activeNativePath =
    activeTab?.document && activeTab.source
      ? nativeDocumentPath(activeTab.source, activeTab.document)
      : null;
  const pathToOpen = targetPath || activeNativePath;
  if (!pathToOpen) {
    if (activeTab?.source && !activeTab.source.capabilities.externalEditor) {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(i18n.m.dialog.externalEditorUnavailable, {
        title: i18n.m.common.error,
        kind: "info",
      });
    }
    return;
  }

  try {
    const cmd = settingsStore.settings.externalEditorCommand.trim();
    if (cmd && !(await invoke<boolean>("authorize_external_editor", { path: cmd }))) return;
    await invoke("open_in_editor", { path: pathToOpen });
  } catch (err) {
    console.error("外部エディターの起動に失敗しました:", err);
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(i18n.m.dialog.externalEditorFailed(err), {
      title: i18n.m.common.error,
      kind: "error",
    });
  }
}
