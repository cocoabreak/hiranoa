import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import GitHistoryView from "./GitHistoryView.svelte";
import { i18n } from "$lib/i18n/index.svelte";
import type { HistoryInfo } from "$lib/history/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("$lib/history/render", () => ({
  createHistoryRenderer: () => ({
    clear: vi.fn(),
    render: vi.fn(async (root: HTMLElement, _raw: string, blocks: { raw: string }[]) => {
      root.replaceChildren();
      return new Map(
        blocks.map((block, index) => {
          const p = document.createElement("p");
          p.textContent = block.raw;
          root.append(p);
          return [index, p];
        })
      );
    }),
  }),
}));
const history: HistoryInfo = {
  sessionId: "session",
  path: "guide.md",
  commits: [
    { id: "a".repeat(40), summary: "Old version", author: "Test", timestamp: 1 },
    { id: "b".repeat(40), summary: "Older version", author: "Test", timestamp: 0 },
  ],
  truncated: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  i18n.setLocale("en");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("requestAnimationFrame", (cb: (time: number) => void) =>
    window.setTimeout(() => cb(0), 0)
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "open_git_history") return history;
    if (command === "read_git_snapshot")
      return {
        raw: `# Guide\n\n${(args as { revision: string }).revision === "working" ? "60" : "30"} seconds\n`,
        present: true,
      };
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const props = () => ({
  document: { sourceId: "native", path: "guide.md" },
  title: "guide.md",
  onclose: vi.fn(),
});

describe("GitHistoryView", () => {
  it("compares the captured document and switches to source without changing workspace tabs", async () => {
    render(GitHistoryView, props());
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false"));
    expect(invoke).toHaveBeenCalledWith("open_git_history", {
      document: { sourceId: "native", path: "guide.md" },
    });
    expect(document.querySelectorAll(".history-word-change").length).toBeGreaterThan(0);
    await fireEvent.click(screen.getByRole("button", { name: "Source diff" }));
    expect(document.querySelectorAll("[data-source-row]").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Source diff" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
  it("closes a late-arriving backend session after the view is dismissed", async () => {
    let finish!: (value: HistoryInfo) => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const view = render(GitHistoryView, props());
    view.unmount();
    finish(history);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("close_git_history", { sessionId: "session" })
    );
  });
  it("does not show previous snapshots after refreshing fails", async () => {
    render(GitHistoryView, props());
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false"));
    vi.mocked(invoke).mockRejectedValue(new Error("Document changed"));
    await fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Document changed"));
    expect(screen.getByRole("button", { name: "Source diff" })).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "Source diff" }));
    expect(document.querySelectorAll("[data-source-row]")).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Document changed");
  });
  it("preserves access denial and exposes load errors", async () => {
    const p = props();
    vi.mocked(invoke).mockResolvedValueOnce(null);
    render(GitHistoryView, p);
    await waitFor(() => expect(p.onclose).toHaveBeenCalledOnce());
    cleanup();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("No Git repository found"));
    render(GitHistoryView, props());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No Git repository"));
  });
});
