import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import GlobalSearchPanel from "./GlobalSearchPanel.svelte";
import { globalSearchStore } from "$lib/stores/global-search.svelte";
import { i18n } from "$lib/i18n/index.svelte";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("global search focus", () => {
  it("returns to the text input when the existing search command is invoked from metadata mode", async () => {
    render(GlobalSearchPanel);
    await fireEvent.click(screen.getByRole("tab", { name: i18n.m.metadata.search }));
    expect(screen.getByRole("tab", { name: i18n.m.metadata.search })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    globalSearchStore.openSearch();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByPlaceholderText(i18n.m.globalSearch.placeholder)
      )
    );
    expect(screen.getByRole("tab", { name: i18n.m.metadata.textSearch })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});
