const INITIAL_PANE_ID = "primary";
export const MAX_WORKSPACE_TABS = 100;

export function createWorkspaceStore() {
  let paneIds = $state<string[]>([INITIAL_PANE_ID]);
  let activePaneId = $state(INITIAL_PANE_ID);
  let splitRatio = $state(0.5);
  let layoutVersion = $state(0);
  const disposeListeners = new Set<(id: string) => void>();
  const roots = new Map<string, HTMLElement>();
  const requests = new Map<string, number>();
  return {
    get paneIds() {
      return paneIds;
    },
    get activePaneId() {
      return activePaneId;
    },
    get splitRatio() {
      return splitRatio;
    },
    get layoutVersion() {
      return layoutVersion;
    },
    hasPane(id: string) {
      return paneIds.includes(id);
    },
    invalidateLayout() {
      layoutVersion++;
      for (const id of paneIds) requests.set(id, (requests.get(id) ?? 0) + 1);
    },
    reset() {
      const previous = paneIds;
      paneIds = [crypto.randomUUID()];
      activePaneId = paneIds[0];
      splitRatio = 0.5;
      layoutVersion++;
      roots.clear();
      requests.clear();
      for (const id of previous) for (const listener of disposeListeners) listener(id);
    },
    activate(id: string) {
      if (paneIds.includes(id)) activePaneId = id;
    },
    setRatio(value: number) {
      if (Number.isFinite(value)) splitRatio = Math.max(0.2, Math.min(0.8, value));
    },
    addPane(id = crypto.randomUUID()): string | undefined {
      if (paneIds.length === 2) return;
      paneIds = [...paneIds, id];
      splitRatio = 0.5;
      layoutVersion++;
      return id;
    },
    removePane(id: string) {
      if (paneIds.length < 2 || !paneIds.includes(id)) return;
      paneIds = paneIds.filter((candidate) => candidate !== id);
      if (activePaneId === id) activePaneId = paneIds[0];
      roots.delete(id);
      requests.delete(id);
      layoutVersion++;
      for (const listener of disposeListeners) listener(id);
    },
    otherPane(id: string) {
      return paneIds.find((candidate) => candidate !== id);
    },
    onDispose(listener: (id: string) => void) {
      disposeListeners.add(listener);
      return () => disposeListeners.delete(listener);
    },
    setRoot(id: string, root: HTMLElement | undefined) {
      if (root) roots.set(id, root);
      else roots.delete(id);
    },
    root(id = activePaneId) {
      return roots.get(id);
    },
    beginRequest(id = activePaneId) {
      const generation = (requests.get(id) ?? 0) + 1;
      requests.set(id, generation);
      return { paneId: id, valid: () => paneIds.includes(id) && requests.get(id) === generation };
    },
  };
}

export const workspaceStore = createWorkspaceStore();

/** Shared panels use the active facade; mounted viewers retain a fixed instance. */
export function createPaneScopedStore<T extends object>(factory: (id: string) => T) {
  const instances = new Map<string, T>();
  function forPane(id: string): T {
    let instance = instances.get(id);
    if (!instance) {
      instance = factory(id);
      instances.set(id, instance);
    }
    return instance;
  }
  workspaceStore.onDispose((id) => instances.delete(id));
  return new Proxy({} as T & { forPane: typeof forPane }, {
    get(_target, property) {
      if (property === "forPane") return forPane;
      return Reflect.get(forPane(workspaceStore.activePaneId), property);
    },
  });
}
