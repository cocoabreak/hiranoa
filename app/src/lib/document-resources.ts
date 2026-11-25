import { invoke } from "@tauri-apps/api/core";
import { SerializedTaskQueue } from "$lib/serialized-task-queue";
import {
  nativeComparisonPath,
  nativeDocumentPath,
  nativePathsEqual,
  registerZipSource,
} from "$lib/document-sources";
import type { DocumentRef, DocumentSourceInfo, Tab } from "$lib/types";
import { explorerStore } from "$lib/stores/explorer.svelte";

interface DocumentWatch {
  path: string;
  archive?: DocumentSourceInfo;
}

const pendingPaths = new Map<string, number>();
const pendingArchives = new Map<string, number>();
// Registration accepts aliases; only Rust knows the canonical archive path and ID.
const archiveQueueKey = Symbol("archives");
const queue = new SerializedTaskQueue<string | symbol>();

function watchQueueKey(watch: DocumentWatch) {
  return watch.archive ? archiveQueueKey : nativeComparisonPath(watch.path);
}

function retain(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return () => {
    const count = (counts.get(key) ?? 1) - 1;
    if (count) counts.set(key, count);
    else counts.delete(key);
  };
}

export function retainWatch(watch: DocumentWatch): () => void {
  const releasePath = retain(pendingPaths, nativeComparisonPath(watch.path));
  const releaseArchive = watch.archive && retain(pendingArchives, watch.archive.id);
  return () => {
    releasePath();
    releaseArchive?.();
  };
}

export function documentWatch(
  source: DocumentSourceInfo,
  document: DocumentRef
): DocumentWatch | null {
  if (source.kind === "zip") return { path: source.nativePath, archive: source };
  const path = nativeDocumentPath(source, document);
  return path === null ? null : { path };
}

function tabWatchesPath(tab: Tab, path: string): boolean {
  const native = tab.document && tab.source && nativeDocumentPath(tab.source, tab.document);
  return !!native && nativePathsEqual(native, path);
}

export function watchedDocuments(path: string, tabs: Tab[], explorer: DocumentSourceInfo | null) {
  const archives = new Map<string, DocumentSourceInfo>();
  for (const source of [explorer, ...tabs.map((tab) => tab.source)]) {
    if (source?.kind === "zip" && nativePathsEqual(source.nativePath, path))
      archives.set(source.id, source);
  }
  return { archives, nativeTabs: tabs.filter((tab) => tabWatchesPath(tab, path)) };
}

function watchInUse(watch: DocumentWatch, tabs: Tab[]): boolean {
  if (pendingPaths.has(nativeComparisonPath(watch.path))) return true;
  const { archives, nativeTabs } = watchedDocuments(watch.path, tabs, explorerStore.source);
  return archives.size > 0 || nativeTabs.length > 0;
}

function archiveInUse(id: string, tabs: Tab[]): boolean {
  return (
    pendingArchives.has(id) ||
    explorerStore.source?.id === id ||
    tabs.some((tab) => tab.source?.id === id)
  );
}

export function releaseArchive(
  source: DocumentSourceInfo | null,
  tabs: () => Tab[]
): Promise<void> {
  if (source?.kind !== "zip") return Promise.resolve();
  return releaseUnusedWatch({ path: source.nativePath, archive: source }, tabs);
}

/** The queue orders IPC operations on the same native file or ZIP container. */
export function ensureWatch(watch: DocumentWatch, tabs: () => Tab[]): Promise<void> {
  return queue.enqueue(watchQueueKey(watch), async () => {
    if (watchInUse(watch, tabs())) await invoke("watch_path", { path: watch.path });
  });
}

export function releaseUnusedWatch(watch: DocumentWatch, tabs: () => Tab[]): Promise<void> {
  const { path, archive } = watch;
  return queue.enqueue(watchQueueKey(watch), async () => {
    if (!watchInUse(watch, tabs())) await invoke("unwatch_path", { path }).catch(() => {});
    if (archive && !archiveInUse(archive.id, tabs())) {
      await invoke("unregister_source", { sourceId: archive.id }).catch(() => {});
    }
  });
}

// Registration and final release must not overtake each other for the same archive.
export async function withRegisteredArchive<T>(
  path: string,
  tabs: () => Tab[],
  use: (source: DocumentSourceInfo) => Promise<T>
): Promise<T> {
  const { source, release } = await queue.enqueue(archiveQueueKey, async () => {
    const source = await registerZipSource(path);
    return { source, release: retainWatch({ path: source.nativePath, archive: source }) };
  });
  try {
    return await use(source);
  } finally {
    release();
    const watch = { path: source.nativePath, archive: source };
    await releaseUnusedWatch(watch, tabs);
  }
}
