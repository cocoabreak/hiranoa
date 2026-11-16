<script lang="ts">
  import { openOtherPaneLabel } from "$lib/pane-labels";

  import { captureOpenTarget, captureOtherTarget } from "$lib/actions/workspace-actions";
  import { explorerStore } from "$lib/stores/explorer.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { openSourceMarkdown } from "$lib/actions/file-actions";
  import { openExternalEditor } from "$lib/actions/file-actions";
  import { toggleDirectory } from "$lib/actions/explorer-actions";
  import FileTree from "./FileTree.svelte";
  import type { FileEntry } from "$lib/types";
  import { i18n } from "$lib/i18n/index.svelte";
  import { nativeDocumentPath } from "$lib/document-sources";

  const m = $derived(i18n.m);

  let { entries, depth }: { entries: FileEntry[]; depth: number } = $props();

  import { Menu, MenuItem } from "@tauri-apps/api/menu";

  async function handleFileClick(entry: FileEntry, other = false) {
    const target = other ? captureOtherTarget() : captureOpenTarget();
    try {
      const source = explorerStore.source;
      if (!source) throw new Error("ドキュメントソースが見つかりません");
      await openSourceMarkdown(entry.document, source, undefined, target);
    } catch (err) {
      alert(m.dialog.openFileFailed(entry.path, err));
    }
  }

  async function handleContextMenu(e: MouseEvent, entry: FileEntry) {
    const source = explorerStore.source;
    if (!source) return;
    const path = nativeDocumentPath(source, entry.document);
    e.preventDefault();
    try {
      const menu = await Menu.new({
        items: [
          await MenuItem.new({
            text: openOtherPaneLabel(),
            action: () => {
              const target = captureOtherTarget();
              void openSourceMarkdown(entry.document, source, undefined, target);
            },
          }),
          ...(path && source.capabilities.externalEditor
            ? [
                await MenuItem.new({
                  text: m.contextMenu.openExternalEditor,
                  action: () => openExternalEditor(path),
                }),
              ]
            : []),
        ],
      });
      await menu.popup();
    } catch (err) {
      console.error("コンテキストメニューの表示に失敗しました:", err);
    }
  }

  // 表示対象ファイルの絞り込み（拡張子・gitignore）はRust側のread_directoryで行う
  const visible = $derived(
    entries.filter((e) => !(e.isHidden && !settingsStore.settings.showHiddenFiles))
  );
</script>

{#each visible as entry (entry.path)}
  {#if entry.isDir}
    <div>
      <button
        class="flex w-full items-center gap-1 rounded py-0.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
        style="padding-left: {depth * 12 + 8}px; padding-right: 8px"
        onclick={() => toggleDirectory(entry)}
      >
        <span class="shrink-0 text-muted-foreground">
          {explorerStore.expandedDirs.has(entry.path) ? "▾" : "▸"}
        </span>
        <span class="truncate">{entry.name}</span>
      </button>
      {#if explorerStore.expandedDirs.has(entry.path)}
        {#if entry.children}
          <FileTree entries={entry.children} depth={depth + 1} />
        {:else if explorerStore.loadingDirs.has(entry.path)}
          <p
            class="py-0.5 text-xs text-muted-foreground"
            style="padding-left: {(depth + 1) * 12 + 22}px"
          >
            {m.common.loading}
          </p>
        {/if}
      {/if}
    </div>
  {:else}
    <button
      class="flex w-full items-center rounded py-0.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
      style="padding-left: {depth * 12 + 22}px; padding-right: 8px"
      onclick={(event) => handleFileClick(entry, event.shiftKey)}
      oncontextmenu={(e) => handleContextMenu(e, entry)}
    >
      <span class="truncate">{entry.name}</span>
    </button>
  {/if}
{/each}
