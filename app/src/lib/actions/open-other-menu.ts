import { openOtherPaneLabel } from "$lib/pane-labels";
import { workspaceStore } from "$lib/stores/workspace.svelte";
import { tabStore } from "$lib/stores/tab.svelte";

export async function showOpenOtherMenu(event: MouseEvent, open: () => unknown): Promise<void> {
  event.preventDefault();
  const paneId = workspaceStore.activePaneId;
  const tabs = tabStore.forPane(paneId);
  const activeTabId = tabs.activeTabId;
  const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
  const menu = await Menu.new({
    items: [
      await MenuItem.new({
        text: openOtherPaneLabel(paneId),
        action: () => {
          if (
            workspaceStore.activePaneId === paneId &&
            tabs.activeTabId === activeTabId &&
            workspaceStore.hasPane(paneId)
          )
            return open();
        },
      }),
    ],
  });
  await menu.popup();
}
