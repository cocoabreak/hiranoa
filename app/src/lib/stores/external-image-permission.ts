import type { ExternalImagePolicy } from "./settings.svelte";

const listeners = new Set<() => void>();
export function subscribeExternalImageApprovals(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const approvedDocumentPaths = new Set<string>();

export function approveExternalImagesForDocument(path: string): void {
  if (path) {
    approvedDocumentPaths.add(path);
    for (const listener of listeners) listener();
  }
}

export function areExternalImagesApprovedForDocument(path: string): boolean {
  return path !== "" && approvedDocumentPaths.has(path);
}

export function mayLoadExternalImages(policy: ExternalImagePolicy, path: string): boolean {
  return policy === "allow" || (policy === "ask" && areExternalImagesApprovedForDocument(path));
}

/** テスト用。許可は永続化せず、実アプリではプロセス終了時に破棄される。 */
export function clearExternalImageApprovals(): void {
  approvedDocumentPaths.clear();
}
