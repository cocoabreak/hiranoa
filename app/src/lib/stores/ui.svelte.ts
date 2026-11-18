import type { DocumentRef } from "$lib/types";

function createUiStore() {
  let gitHistory = $state<{ document: DocumentRef; title: string } | null>(null);
  let settingsPanelOpen = $state(false);
  let aboutDialogOpen = $state(false);
  let layoutsOpen = $state(false);
  let sidebarActiveTab = $state<"explorer" | "search" | "links">("explorer");

  return {
    get gitHistory() {
      return gitHistory;
    },
    openGitHistory(document: DocumentRef, title: string) {
      gitHistory = { document: { ...document }, title };
    },
    closeGitHistory() {
      gitHistory = null;
    },
    get layoutsOpen() {
      return layoutsOpen;
    },
    openLayouts() {
      layoutsOpen = true;
    },
    closeLayouts() {
      layoutsOpen = false;
    },
    get settingsPanelOpen() {
      return settingsPanelOpen;
    },
    get aboutDialogOpen() {
      return aboutDialogOpen;
    },
    get sidebarActiveTab() {
      return sidebarActiveTab;
    },
    openSettings() {
      settingsPanelOpen = true;
    },
    closeSettings() {
      settingsPanelOpen = false;
    },
    openAbout() {
      aboutDialogOpen = true;
    },
    closeAbout() {
      aboutDialogOpen = false;
    },
    setSidebarActiveTab(tab: "explorer" | "search" | "links") {
      sidebarActiveTab = tab;
    },
  };
}

export const uiStore = createUiStore();
