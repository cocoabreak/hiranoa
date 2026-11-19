import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import { showViewerContextMenu } from "$lib/actions/context-menu";
import { createMarkdownRenderSession } from "$lib/markdown/engine";
import { contentStore } from "$lib/stores/content.svelte";
import { tabStore } from "$lib/stores/tab.svelte";
import { workspaceStore } from "$lib/stores/workspace.svelte";
import MarkdownViewer from "./MarkdownViewer.svelte";

vi.mock("$lib/markdown/engine", () => ({ createMarkdownRenderSession: vi.fn() }));
vi.mock("$lib/actions/context-menu", () => ({ showViewerContextMenu: vi.fn() }));

it("描画エラーをマークアップにせずテキストで表示する", async () => {
  const markup = "<strong>Rendering failed</strong>";
  vi.mocked(createMarkdownRenderSession).mockReturnValue({
    render: vi.fn().mockRejectedValue(new Error(markup)),
    cancel: vi.fn(),
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const path = "preview.md";
  const paneId = workspaceStore.activePaneId;
  const tabs = tabStore.forPane(paneId);
  tabs.addOrActivate({ id: path, path, title: path });
  contentStore.set(path, { raw: "# Preview", safeOutline: [], safeOutlineTruncated: false });

  try {
    render(MarkdownViewer, { paneId });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(markup);
    expect(alert.childElementCount).toBe(0);
    await fireEvent.contextMenu(alert);
    expect(showViewerContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ renderedHtml: null })
    );
  } finally {
    cleanup();
    tabs.close(path);
    contentStore.delete(path);
    consoleError.mockRestore();
  }
});
