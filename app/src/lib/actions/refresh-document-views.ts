import { readSourceMarkdown } from "./file-actions";
import { tabStore } from "$lib/stores/tab.svelte";
import { contentStore } from "$lib/stores/content.svelte";
import { nativeDocumentIdentity } from "$lib/document-sources";
import type { Tab } from "$lib/types";

const generations = new Map<string, number>();
let nextGeneration = 0;

/** One read per document, even when several independent views refer to it. */
export async function refreshDocumentViews(tabs: Tab[], markDeleted = false): Promise<void> {
  const groups = new Map<string, Tab[]>();
  for (const tab of tabs) {
    if (!tab.source || !tab.document) continue;
    const identity = nativeDocumentIdentity(tab.source, tab.document) ?? tab.path;
    groups.set(identity, [...(groups.get(identity) ?? []), tab]);
  }
  for (const [identity, group] of groups) {
    const generation = ++nextGeneration;
    generations.set(identity, generation);
    const tab = group.find((tab) => tab.renderMode !== "safe") ?? group[0];
    if (!tab.document) continue;
    try {
      const loaded = await readSourceMarkdown(tab.document, tab.path, {
        currentMode: tab.renderMode ?? "full",
        reason: "watch",
      });
      if (!loaded || generations.get(identity) !== generation) continue;
      for (const candidate of group) {
        const current = tabStore.allTabs.find((entry) => entry.id === candidate.id);
        if (
          !current ||
          current.path !== candidate.path ||
          current.renderMode !== candidate.renderMode ||
          current.source?.generation !== candidate.source?.generation
        )
          continue;
        contentStore.set(candidate.path, {
          raw: loaded.raw,
          safeOutline: loaded.safeOutline,
          safeOutlineTruncated: loaded.safeOutlineTruncated,
        });
        tabStore.updateTab(current.id, {
          status: "ok",
          renderMode: loaded.renderMode === "safe" ? "safe" : current.renderMode,
        });
      }
    } catch {
      if (generations.get(identity) !== generation) continue;
      if (markDeleted)
        for (const candidate of group) tabStore.updateTab(candidate.id, { status: "deleted" });
    } finally {
      if (generations.get(identity) === generation) generations.delete(identity);
    }
  }
}
