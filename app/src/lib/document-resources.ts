import { invoke } from "@tauri-apps/api/core";

const pendingSources = new Map<string, number>();
const pendingPaths = new Map<string, number>();
const queues = new Map<string, Promise<void>>();
const resourceKey = (path: string) => path.replaceAll("\\", "/").toLowerCase();

export function retainPendingPath(path: string): () => void {
  const key = resourceKey(path);
  pendingPaths.set(key, (pendingPaths.get(key) ?? 0) + 1);
  return () => {
    const count = (pendingPaths.get(key) ?? 1) - 1;
    if (count) pendingPaths.set(key, count);
    else pendingPaths.delete(key);
  };
}
export function hasPendingPath(path: string): boolean {
  return pendingPaths.has(resourceKey(path));
}

export function retainPendingSource(sourceId: string): () => void {
  pendingSources.set(sourceId, (pendingSources.get(sourceId) ?? 0) + 1);
  return () => {
    const count = (pendingSources.get(sourceId) ?? 1) - 1;
    if (count) pendingSources.set(sourceId, count);
    else pendingSources.delete(sourceId);
  };
}

export function hasPendingSource(sourceId: string): boolean {
  return pendingSources.has(sourceId);
}

/** Watch and release operations for the same native resource cannot overtake one another. */
export function reconcileDocumentResource(
  path: string,
  used: () => boolean,
  sourceId?: string
): Promise<void> {
  const key = resourceKey(path);
  const operation = (queues.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (used()) {
        await invoke("watch_path", { path });
      } else {
        await invoke("unwatch_path", { path }).catch(() => {});
        if (sourceId && !used()) await invoke("unregister_source", { sourceId }).catch(() => {});
      }
    });
  queues.set(key, operation);
  void operation
    .finally(() => {
      if (queues.get(key) === operation) queues.delete(key);
    })
    .catch(() => {});
  return operation;
}
