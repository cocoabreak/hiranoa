import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceStore } from "$lib/stores/workspace.svelte";
import { tocStore } from "$lib/stores/toc.svelte";
import TOCView from "./TOCView.svelte";

afterEach(() => {
  workspaceStore.setRoot(workspaceStore.activePaneId, undefined);
  tocStore.setHeadings([]);
  tocStore.setActiveId(null);
});

describe("TOCView", () => {
  it("見出し選択後にonselectを呼び出す", async () => {
    const onselect = vi.fn();
    const target = document.createElement("div");
    target.id = "section-one";
    target.scrollIntoView = vi.fn();
    const root = document.createElement("main");
    root.append(target);
    document.body.append(root);
    workspaceStore.setRoot(workspaceStore.activePaneId, root);
    tocStore.setHeadings([{ id: target.id, text: "Section one", level: 1 }]);

    render(TOCView, { onselect });
    await fireEvent.click(screen.getByRole("button", { name: "Section one" }));

    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });
    expect(tocStore.activeId).toBe(target.id);
    expect(onselect).toHaveBeenCalledOnce();
  });
});
