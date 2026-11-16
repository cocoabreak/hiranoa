import { createPaneScopedStore } from "./workspace.svelte";
import { documentKey } from "$lib/document-sources";
import type { DocumentRef } from "$lib/types";

function createDocumentAnchorStore() {
  let pending = $state<{ key: string; anchor: string; id: number } | null>(null);
  let nextId = 0;
  return {
    get pending() {
      return pending;
    },
    navigate(document: DocumentRef, anchor: string) {
      pending = { key: documentKey(document), anchor, id: ++nextId };
    },
    consume(id: number) {
      if (pending?.id === id) pending = null;
    },
  };
}
export const documentAnchorStore = createPaneScopedStore(createDocumentAnchorStore);
