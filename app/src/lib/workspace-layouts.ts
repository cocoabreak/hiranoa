import { invoke } from "@tauri-apps/api/core";
import { normalizeSession, type PersistedSession } from "$lib/session-schema";
import type { Settings } from "$lib/stores/settings.svelte";

export const MAX_LAYOUTS = 20;
export const MAX_LAYOUT_NAME = 80;
export const MAX_LAYOUT_BYTES = 1024 * 1024;
export type LayoutAppearance = Pick<
  Settings,
  "sidebarVisible" | "tocVisible" | "sidebarWidth" | "tocWidth" | "tocRatio" | "contentZoom"
>;
export interface WorkspaceLayout {
  id: string;
  name: string;
  session: PersistedSession;
  appearance: LayoutAppearance;
}
export interface LayoutCollection {
  schemaVersion: 1;
  layouts: WorkspaceLayout[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid layout data");
  return value as Record<string, unknown>;
}
function keys(data: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    throw new Error("Unknown layout field");
}
function source(value: unknown) {
  const data = record(value);
  keys(data, ["kind", "nativePath"]);
  if (
    (data.kind !== "native" && data.kind !== "zip") ||
    typeof data.nativePath !== "string" ||
    !data.nativePath ||
    data.nativePath.length > 32768
  )
    throw new Error("Invalid layout source");
}
function index(value: unknown, count: number) {
  if (value === null || value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    (count ? value < 0 || value >= count : value !== -1)
  )
    throw new Error("Invalid active index");
}
export function layoutName(value: string): string {
  const name = value.trim();
  if (
    !name ||
    name.length > MAX_LAYOUT_NAME ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("Invalid layout name");
  return name;
}
export function captureAppearance(settings: Settings): LayoutAppearance {
  return {
    sidebarVisible: settings.sidebarVisible,
    tocVisible: settings.tocVisible,
    sidebarWidth: settings.sidebarWidth,
    tocWidth: settings.tocWidth,
    tocRatio: settings.tocRatio,
    contentZoom: settings.contentZoom,
  };
}
export function validateLayouts(value: unknown): LayoutCollection {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_LAYOUT_BYTES)
    throw new Error("Layout storage limit exceeded");
  const data = record(value);
  if (!Object.keys(data).length) return { schemaVersion: 1, layouts: [] };
  keys(data, ["schemaVersion", "layouts"]);
  if (data.schemaVersion !== 1 || !Array.isArray(data.layouts) || data.layouts.length > MAX_LAYOUTS)
    throw new Error("Unsupported layout data");
  const ids = new Set<string>(),
    names = new Set<string>();
  const layouts = data.layouts.map((value): WorkspaceLayout => {
    const item = record(value);
    keys(item, ["id", "name", "session", "appearance"]);
    if (
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 80 ||
      ids.has(item.id) ||
      typeof item.name !== "string"
    )
      throw new Error("Invalid layout identity");
    const name = layoutName(item.name);
    if (names.has(name)) throw new Error("Duplicate layout name");
    ids.add(item.id);
    names.add(name);
    const rawSession = record(item.session);
    keys(rawSession, ["schemaVersion", "workspace", "explorer", "expandedDirs"]);
    const workspace = record(rawSession.workspace);
    keys(workspace, ["panes", "activePaneIndex", "splitRatio"]);
    if (
      rawSession.schemaVersion !== 2 ||
      !Array.isArray(workspace.panes) ||
      workspace.panes.length < 1 ||
      workspace.panes.length > 2
    )
      throw new Error("Invalid layout session");
    if (
      typeof workspace.activePaneIndex !== "number" ||
      !Number.isInteger(workspace.activePaneIndex) ||
      workspace.activePaneIndex < 0 ||
      workspace.activePaneIndex >= workspace.panes.length ||
      typeof workspace.splitRatio !== "number" ||
      !Number.isFinite(workspace.splitRatio) ||
      workspace.splitRatio < 0.2 ||
      workspace.splitRatio > 0.8
    )
      throw new Error("Invalid layout workspace");
    if (rawSession.explorer !== undefined && rawSession.explorer !== null)
      source(rawSession.explorer);
    if (
      rawSession.expandedDirs !== undefined &&
      (!Array.isArray(rawSession.expandedDirs) ||
        rawSession.expandedDirs.length > 64 ||
        rawSession.expandedDirs.some((path) => typeof path !== "string" || path.length > 32768))
    )
      throw new Error("Invalid expanded directories");
    let count = 0;
    for (const value of workspace.panes) {
      const pane = record(value);
      keys(pane, ["tabs", "activeIndex", "search"]);
      if (!Array.isArray(pane.tabs)) throw new Error("Invalid layout tabs");
      index(pane.activeIndex, pane.tabs.length);
      if (pane.search !== undefined) {
        const search = record(pane.search);
        keys(search, ["open", "query", "useRegex"]);
        if (
          typeof search.open !== "boolean" ||
          typeof search.useRegex !== "boolean" ||
          typeof search.query !== "string" ||
          search.query.length > 10000
        )
          throw new Error("Invalid layout search");
      }
      count += pane.tabs.length;
      for (const value of pane.tabs) {
        const tab = record(value);
        keys(tab, ["path", "pinned", "source", "documentPath", "scrollPositions", "viewMode"]);
        if (
          typeof tab.pinned !== "boolean" ||
          (tab.viewMode !== undefined && tab.viewMode !== "source" && tab.viewMode !== "rendered")
        )
          throw new Error("Invalid layout tab");
        if (typeof tab.path !== "string" || !tab.path || tab.path.length > 32768)
          throw new Error("Invalid layout path");
        if (tab.source !== undefined) {
          source(tab.source);
          if (typeof tab.documentPath !== "string" || tab.documentPath.length > 32768)
            throw new Error("Invalid layout document path");
        }
        if (tab.scrollPositions !== undefined) {
          const positions = record(tab.scrollPositions);
          keys(positions, ["rendered", "source", "safe"]);
          if (
            Object.values(positions).some(
              (position) =>
                typeof position !== "number" || !Number.isFinite(position) || position < 0
            )
          )
            throw new Error("Invalid layout position");
        }
      }
    }
    if (count > 100) throw new Error("Too many layout tabs");
    const appearance = record(item.appearance);
    keys(appearance, [
      "sidebarVisible",
      "tocVisible",
      "sidebarWidth",
      "tocWidth",
      "tocRatio",
      "contentZoom",
    ]);
    for (const key of ["sidebarVisible", "tocVisible"])
      if (typeof appearance[key] !== "boolean") throw new Error("Invalid visibility");
    for (const [key, min, max] of [
      ["sidebarWidth", 160, 480],
      ["tocWidth", 160, 480],
      ["tocRatio", 0.2, 0.8],
      ["contentZoom", 50, 200],
    ] as const) {
      const number = appearance[key];
      if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max)
        throw new Error("Invalid layout appearance");
    }
    return {
      id: item.id,
      name,
      session: normalizeSession(rawSession),
      appearance: appearance as unknown as LayoutAppearance,
    };
  });
  return { schemaVersion: 1, layouts };
}

export async function loadLayouts(): Promise<LayoutCollection> {
  return validateLayouts(await invoke("load_app_state", { kind: "layouts" }));
}
export async function persistLayouts(layouts: WorkspaceLayout[]): Promise<LayoutCollection> {
  const value = validateLayouts({ schemaVersion: 1, layouts });
  await invoke("save_app_state", { kind: "layouts", value });
  return value;
}
