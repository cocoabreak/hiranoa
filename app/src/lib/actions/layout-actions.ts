import {
  captureSessionSnapshot,
  flushTabs,
  restoreSessionSnapshot,
  saveAndFlushTabs,
} from "$lib/tabs-store";
import { captureAppearance, validateLayouts, type WorkspaceLayout } from "$lib/workspace-layouts";
import { sessionRestorePromptStore } from "$lib/stores/session-restore-prompt.svelte";
import { workspaceStore } from "$lib/stores/workspace.svelte";
import { tabStore } from "$lib/stores/tab.svelte";
import { settingsStore } from "$lib/stores/settings.svelte";
import { closeFolder } from "$lib/actions/explorer-actions";
import { saveSettings } from "$lib/settings-store";

export function captureLayout(name: string): WorkspaceLayout {
  return validateLayouts({
    schemaVersion: 1,
    layouts: [
      {
        id: crypto.randomUUID(),
        name,
        session: captureSessionSnapshot(),
        appearance: captureAppearance(settingsStore.settings),
      },
    ],
  }).layouts[0];
}

export async function applyLayout(
  input: WorkspaceLayout
): Promise<{ restored: number; skipped: number }> {
  if (sessionRestorePromptStore.visible || sessionRestorePromptStore.restoring)
    throw new Error("Session restore in progress");
  const layout = validateLayouts({ schemaVersion: 1, layouts: [input] }).layouts[0];
  sessionRestorePromptStore.beginRestore();
  try {
    workspaceStore.invalidateLayout();
    await flushTabs();
    await tabStore.waitForCloseOperations();
    for (const tab of [...tabStore.allTabs]) {
      if (tab.pinned) tabStore.togglePin(tab.id);
      await tabStore.closeAndUnwatch(tab.id);
    }
    await closeFolder();
    workspaceStore.reset();
    tabStore.clearRecentlyClosed();
    const appearance = layout.appearance;
    settingsStore.setSidebarVisible(appearance.sidebarVisible);
    if (settingsStore.settings.tocVisible !== appearance.tocVisible) settingsStore.toggleToc();
    settingsStore.setSidebarWidth(appearance.sidebarWidth);
    settingsStore.setTocWidth(appearance.tocWidth);
    settingsStore.setTocRatio(appearance.tocRatio);
    settingsStore.setContentZoom(appearance.contentZoom);
    await restoreSessionSnapshot(layout.session);
    await saveSettings();
    const requested = layout.session.workspace!.panes.reduce(
      (sum, pane) => sum + pane.tabs.length,
      0
    );
    return {
      restored: tabStore.allTabs.length,
      skipped: Math.max(0, requested - tabStore.allTabs.length),
    };
  } finally {
    sessionRestorePromptStore.endRestore();
    await saveAndFlushTabs();
  }
}
