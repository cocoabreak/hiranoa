import type { SourceSpec, ViewMode } from "$lib/types";
import { sanitizeScrollPositions, type ScrollPositions } from "$lib/stores/session-ui-state.svelte";
import type { PersistedSearchState } from "$lib/stores/search.svelte";

export interface PersistedTab {
  path: string;
  pinned: boolean;
  source?: SourceSpec;
  documentPath?: string;
  scrollPositions?: ScrollPositions;
  viewMode?: ViewMode;
}
export interface PersistedPane {
  tabs: PersistedTab[];
  activeIndex?: number | null;
  search?: PersistedSearchState;
}
export interface PersistedSession {
  schemaVersion?: number;
  workspace?: { panes: PersistedPane[]; activePaneIndex: number; splitRatio: number };
  tabs?: PersistedTab[];
  activeIndex?: number | null;
  search?: PersistedSearchState;
  explorer?: SourceSpec | null;
  expandedDirs?: string[];
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function source(value: unknown): SourceSpec | undefined {
  const data = object(value);
  return (data.kind === "native" || data.kind === "zip") &&
    typeof data.nativePath === "string" &&
    data.nativePath.length <= 32768
    ? { kind: data.kind, nativePath: data.nativePath }
    : undefined;
}
export function normalizeSession(value: unknown): PersistedSession {
  const data = object(value);
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 1024 * 1024) return {};
  if (data.schemaVersion !== undefined && data.schemaVersion !== 2) return { schemaVersion: -1 };
  const workspace = object(data.workspace);
  const panes = data.schemaVersion === 2 ? workspace.panes : [data];
  if (!Array.isArray(panes) || panes.length < 1 || panes.length > 2) return {};
  let remaining = 100;
  const normalized = panes.map((value): PersistedPane => {
    const pane = object(value);
    const candidates = Array.isArray(pane.tabs) ? pane.tabs.slice(0, remaining) : [];
    remaining -= candidates.length;
    const tabs = candidates.map((value) => {
      const tab = object(value);
      if (typeof tab.path !== "string" || tab.path.length > 32768)
        return { path: "", pinned: false };
      return {
        path: tab.path,
        pinned: tab.pinned === true,
        source: source(tab.source),
        documentPath:
          typeof tab.documentPath === "string" ? tab.documentPath.slice(0, 32768) : undefined,
        scrollPositions: sanitizeScrollPositions(tab.scrollPositions),
        viewMode: tab.viewMode === "source" ? ("source" as const) : ("rendered" as const),
      };
    });
    const search = object(pane.search);
    return {
      tabs,
      activeIndex: Number.isInteger(pane.activeIndex) ? (pane.activeIndex as number) : null,
      search: {
        open: search.open === true,
        query: typeof search.query === "string" ? search.query.slice(0, 10000) : "",
        useRegex: search.useRegex === true,
      },
    };
  });
  return {
    schemaVersion: 2,
    workspace: {
      panes: normalized,
      activePaneIndex: workspace.activePaneIndex === 1 ? 1 : 0,
      splitRatio:
        typeof workspace.splitRatio === "number" && Number.isFinite(workspace.splitRatio)
          ? Math.max(0.2, Math.min(0.8, workspace.splitRatio))
          : 0.5,
    },
    explorer: source(data.explorer),
    expandedDirs: Array.isArray(data.expandedDirs)
      ? data.expandedDirs.filter((value): value is string => typeof value === "string").slice(0, 64)
      : [],
  };
}
