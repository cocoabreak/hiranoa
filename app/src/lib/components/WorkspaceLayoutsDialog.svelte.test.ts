import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceLayoutsDialog from "./WorkspaceLayoutsDialog.svelte";
import {
  loadLayouts,
  persistLayouts,
  captureAppearance,
  type WorkspaceLayout,
} from "$lib/workspace-layouts";
import { applyLayout, captureLayout } from "$lib/actions/layout-actions";
import { settingsStore } from "$lib/stores/settings.svelte";
import { i18n } from "$lib/i18n/index.svelte";

vi.mock("$lib/workspace-layouts", async (original) => ({
  ...(await original<typeof import("$lib/workspace-layouts")>()),
  loadLayouts: vi.fn(),
  persistLayouts: vi.fn(),
}));
vi.mock("$lib/actions/layout-actions", () => ({ applyLayout: vi.fn(), captureLayout: vi.fn() }));
const item: WorkspaceLayout = {
  id: "a",
  name: "Review",
  appearance: captureAppearance(settingsStore.settings),
  session: {
    schemaVersion: 2,
    workspace: { panes: [{ tabs: [] }], activePaneIndex: 0, splitRatio: 0.5 },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  i18n.setLocale("en");
  vi.mocked(loadLayouts).mockResolvedValue({ schemaVersion: 1, layouts: [item] });
  vi.mocked(persistLayouts).mockImplementation(async (layouts) => ({ schemaVersion: 1, layouts }));
});

describe("WorkspaceLayoutsDialog", () => {
  it("requires confirmation, locks while applying and reports skipped documents", async () => {
    const close = vi.fn();
    render(WorkspaceLayoutsDialog, { onclose: close });
    await screen.findByText("Review");
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(applyLayout).not.toHaveBeenCalled();
    let finish!: (value: { restored: number; skipped: number }) => void;
    vi.mocked(applyLayout).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await fireEvent.click(screen.getAllByRole("button", { name: "Apply" }).at(-1)!);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    finish({ restored: 1, skipped: 2 });
    await screen.findByText("Restored 1, skipped 2.");
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });
  it("keeps the saved list unchanged when persistence fails", async () => {
    render(WorkspaceLayoutsDialog, { onclose: vi.fn() });
    await screen.findByText("Review");
    vi.mocked(persistLayouts).mockRejectedValueOnce(new Error("disk full"));
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Operation failed"));
    expect(screen.getAllByText("Review")).toHaveLength(2);
  });
  it("disables saving when the existing collection is unsupported", async () => {
    vi.mocked(loadLayouts).mockRejectedValueOnce(new Error("unsupported"));
    render(WorkspaceLayoutsDialog, { onclose: vi.fn() });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Cannot read saved layouts")
    );
    expect(screen.getByRole("textbox", { name: "Layout name" })).toBeDisabled();
    expect(persistLayouts).not.toHaveBeenCalled();
  });
  it("saves a named snapshot and supports rename and deletion", async () => {
    vi.mocked(loadLayouts).mockResolvedValueOnce({ schemaVersion: 1, layouts: [] });
    vi.mocked(captureLayout).mockReturnValue(item);
    render(WorkspaceLayoutsDialog, { onclose: vi.fn() });
    await screen.findByText("No saved layouts.");
    await fireEvent.input(screen.getByRole("textbox", { name: "Layout name" }), {
      target: { value: "Review" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save current layout" }));
    await screen.findByText("Layout saved.");
    await fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await fireEvent.input(screen.getAllByRole("textbox", { name: "Layout name" }).at(-1)!, {
      target: { value: "Research" },
    });
    await fireEvent.click(screen.getAllByRole("button", { name: "Rename" }).at(-1)!);
    await screen.findByText("Research");
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    await screen.findByText("No saved layouts.");
  });
});
