import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkPreviewStore, type LinkPreviewReadResponse } from "$lib/stores/link-preview.svelte";
import { setupLinkPreviewTrigger } from "./link-preview";

describe("setupLinkPreviewTrigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("片側の購読解除で他方のプレビューを閉じない", () => {
    const store = new LinkPreviewStore();
    const left = document.createElement("main");
    const right = document.createElement("main");
    left.className = right.className = "markdown-body";
    const origin = document.createElement("a");
    const previous = document.createElement("a");
    left.append(previous);
    right.append(origin);
    const cleanup = setupLinkPreviewTrigger(left, {
      current: { sourceId: "source", path: "a.md" },
      sourceGeneration: 1,
      store,
    });
    store.beginPending(
      "previous",
      () => ({ top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1 }),
      previous
    );
    store.beginMissing(
      "pending",
      () => ({ top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1 }),
      450,
      origin
    );
    cleanup();
    expect(store.status).toBe("waiting");
    store.closeFrom(right);
    expect(store.status).toBe("idle");
  });

  it("他方のリンクへフォーカス後、元のリンクを離れても新しいプレビューを閉じない", async () => {
    const store = new LinkPreviewStore(async () => ({
      status: "ready",
      rawPrefix: "# Right",
      byteSize: 7,
      truncated: false,
      sourceGeneration: 1,
    }));
    const left = document.createElement("main");
    const right = document.createElement("main");
    left.className = right.className = "markdown-body";
    document.body.append(left, right);
    left.innerHTML = '<a href="left.md">left</a>';
    right.innerHTML = '<a href="right.md">right</a>';
    const context = { current: { sourceId: "source", path: "a.md" }, sourceGeneration: 1, store };
    const cleanLeft = setupLinkPreviewTrigger(left, context);
    const cleanRight = setupLinkPreviewTrigger(right, context);
    left.querySelector("a")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    right.querySelector("a")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    left.querySelector("a")!.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(store.status).toBe("ready");
    expect(store.path).toBe("right.md");
    cleanLeft();
    cleanRight();
    store.close();
    left.remove();
    right.remove();
  });

  it("同一Source内Markdownリンクを遅延読込する", async () => {
    const reader = vi.fn(async (): Promise<LinkPreviewReadResponse> => ({
      status: "ready",
      rawPrefix: "# Target\nBody",
      byteSize: 13,
      truncated: false,
      sourceGeneration: 1,
    }));
    const store = new LinkPreviewStore(reader);
    const container = document.createElement("div");
    container.innerHTML = '<a href="guide/target.md#Details">target</a>';
    document.body.append(container);
    const cleanup = setupLinkPreviewTrigger(container, {
      current: { sourceId: "source", path: "index.md" },
      sourceGeneration: 1,
      store,
    });
    const anchor = container.querySelector("a")!;
    anchor.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(450);
    expect(reader).toHaveBeenCalledWith(
      { sourceId: "source", path: "index.md" },
      { sourceId: "source", path: "guide/target.md" }
    );
    cleanup();
    container.remove();
  });

  it("偽造wiki-link classと絶対パスは読込対象にしない", async () => {
    const reader = vi.fn<() => Promise<LinkPreviewReadResponse>>();
    const store = new LinkPreviewStore(reader);
    const container = document.createElement("div");
    container.innerHTML =
      '<a class="wiki-link" href="secret.md">fake</a><a href="C:/secret.md">absolute</a>';
    document.body.append(container);
    const cleanup = setupLinkPreviewTrigger(container, {
      current: { sourceId: "source", path: "index.md" },
      sourceGeneration: 1,
      store,
    });
    for (const anchor of container.querySelectorAll("a")) {
      anchor.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(reader).not.toHaveBeenCalled();
    cleanup();
    container.remove();
  });

  it("フォーカスでは即時表示しEscapeとcleanupで安全に閉じる", async () => {
    const reader = vi.fn(async (): Promise<LinkPreviewReadResponse> => ({
      status: "ready",
      rawPrefix: "# Target\nBody",
      byteSize: 13,
      truncated: false,
      sourceGeneration: 1,
    }));
    const store = new LinkPreviewStore(reader);
    const container = document.createElement("div");
    container.innerHTML = '<a href="target.md">target</a>';
    document.body.append(container);
    const cleanup = setupLinkPreviewTrigger(container, {
      current: { sourceId: "source", path: "index.md" },
      sourceGeneration: 1,
      store,
    });
    const anchor = container.querySelector("a")!;

    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(reader).toHaveBeenCalledOnce();
    expect(store.visible).toBe(true);
    anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(store.status).toBe("idle");

    anchor.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    cleanup();
    await vi.runAllTimersAsync();
    expect(reader).toHaveBeenCalledOnce();
    expect(anchor).not.toHaveAttribute("aria-describedby");
    container.remove();
  });
});
