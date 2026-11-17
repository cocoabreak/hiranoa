import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  captureAppearance,
  loadLayouts,
  persistLayouts,
  validateLayouts,
  type WorkspaceLayout,
} from "$lib/workspace-layouts";
import { settingsStore } from "$lib/stores/settings.svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function layout(): WorkspaceLayout {
  return {
    id: "one",
    name: "Review",
    appearance: captureAppearance(settingsStore.settings),
    session: {
      schemaVersion: 2,
      workspace: {
        panes: [
          {
            tabs: [
              {
                path: "D:/notes/a.md",
                pinned: true,
                viewMode: "source",
                scrollPositions: { source: 50 },
              },
            ],
            activeIndex: 0,
          },
        ],
        activePaneIndex: 0,
        splitRatio: 0.5,
      },
      explorer: null,
      expandedDirs: [],
    },
  };
}
const collection = (item = layout()) => ({ schemaVersion: 1, layouts: [item] });

describe("workspace layout schema", () => {
  it("preserves the source mode, pin and position without saving privacy settings", () => {
    const value = validateLayouts(collection());
    expect(value.layouts[0].session.workspace!.panes[0].tabs[0]).toMatchObject({
      pinned: true,
      viewMode: "source",
      scrollPositions: { source: 50 },
    });
    expect(value.layouts[0].appearance).not.toHaveProperty("externalImagePolicy");
    expect(validateLayouts({}).layouts).toEqual([]);
  });
  it("rejects unknown schemas and fields, excessive tabs and duplicate identities", () => {
    expect(() => validateLayouts({ ...collection(), schemaVersion: 2 })).toThrow();
    expect(() => validateLayouts({ ...collection(), layouts: Array(21).fill(layout()) })).toThrow();
    expect(() => validateLayouts({ ...collection(), layouts: [layout(), layout()] })).toThrow();
    const item = layout();
    item.session.workspace!.panes[0].tabs = Array(101).fill(
      item.session.workspace!.panes[0].tabs[0]
    );
    expect(() => validateLayouts(collection(item))).toThrow();
    expect(() =>
      validateLayouts(
        collection({
          ...layout(),
          appearance: { ...layout().appearance, externalImagePolicy: "allow" },
        } as WorkspaceLayout)
      )
    ).toThrow();
  });
  it("rejects malformed sources instead of falling back to opening a native path", () => {
    const item = layout();
    Object.assign(item.session.workspace!.panes[0].tabs[0], {
      source: { kind: "remote", nativePath: "https://example.com" },
      documentPath: "a.md",
    });
    expect(() => validateLayouts(collection(item))).toThrow();
    Object.assign(item.session, { explorer: { kind: "native", nativePath: 1 } });
    expect(() => validateLayouts(collection(item))).toThrow();
  });
  it("rejects invalid positions, ratios, indexes, names and size limits", () => {
    for (const name of [" ", "x".repeat(81), "a\u0000b"])
      expect(() => validateLayouts(collection({ ...layout(), name }))).toThrow();
    for (const splitRatio of [NaN, Infinity, -1, 0.9]) {
      const item = layout();
      item.session.workspace!.splitRatio = splitRatio;
      expect(() => validateLayouts(collection(item))).toThrow();
    }
    const item = layout();
    item.session.workspace!.panes[0].activeIndex = 2;
    expect(() => validateLayouts(collection(item))).toThrow();
    expect(() => validateLayouts({ padding: "x".repeat(1024 * 1024) })).toThrow();
    const positions = layout();
    positions.session.workspace!.panes[0].tabs[0].scrollPositions = { rendered: -1 };
    expect(() => validateLayouts(collection(positions))).toThrow();
  });
  it("propagates load and persistence failures and never saves an unsupported collection", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ schemaVersion: 999, layouts: [] });
    await expect(loadLayouts()).rejects.toThrow();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
    await expect(persistLayouts([layout()])).rejects.toThrow("disk full");
  });
});
