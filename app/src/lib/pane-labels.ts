import { i18n } from "$lib/i18n/index.svelte";
import { workspaceStore } from "$lib/stores/workspace.svelte";

export function openOtherPaneLabel(paneId = workspaceStore.activePaneId): string {
  const m = i18n.m.split;
  if (workspaceStore.paneIds.length === 1) return m.splitOpenRight;
  return paneId === workspaceStore.paneIds[0] ? m.openRight : m.openLeft;
}

export function moveOtherPaneLabel(paneId = workspaceStore.activePaneId): string {
  return paneId === workspaceStore.paneIds[0] ? i18n.m.split.moveRight : i18n.m.split.moveLeft;
}
