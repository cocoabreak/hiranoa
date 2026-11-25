import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  ensureWatch,
  withRegisteredArchive,
  releaseArchive,
  releaseUnusedWatch,
  retainWatch,
  watchedDocuments,
} from "./document-resources";
import { explorerStore } from "./stores/explorer.svelte";
import type { DocumentSourceInfo, Tab } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

describe("document watches", () => {
  it("releases a POSIX file while a differently cased name is being opened", async () => {
    const release = retainWatch({ path: "/notes/a.md" });
    try {
      await releaseUnusedWatch({ path: "/notes/A.md" }, () => []);
      expect(invoke).toHaveBeenCalledWith("unwatch_path", { path: "/notes/A.md" });
      await ensureWatch({ path: "/notes/a.md" }, () => []);
      expect(invoke).toHaveBeenCalledWith("watch_path", { path: "/notes/a.md" });
    } finally {
      release();
    }
  });

  it("orders archive registration after an in-flight release and cleans up a failed open", async () => {
    let finishUnwatch!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishUnwatch = resolve;
    });
    const path = "C:/queue.zip";
    const oldSource: DocumentSourceInfo = {
      id: "old",
      kind: "zip",
      nativePath: path,
      label: "archive",
      capabilities: {
        watch: "container",
        externalEditor: false,
        respectGitignore: false,
        fullTextSearch: true,
        wikiLinks: true,
      },
    };
    const newSource = { ...oldSource, id: "new" };
    const ipc = vi.mocked(invoke);
    ipc.mockClear();
    ipc.mockImplementationOnce(() => pending as never);
    const closing = releaseArchive(oldSource, () => []);
    await vi.waitFor(() => expect(ipc).toHaveBeenCalledWith("unwatch_path", { path }));
    ipc.mockResolvedValueOnce(undefined).mockResolvedValueOnce(newSource);
    const alias = "C:/./queue.zip";
    const opening = withRegisteredArchive(
      alias,
      () => [],
      async () => {
        throw new Error("cannot list entries");
      }
    );
    const failed = expect(opening).rejects.toThrow("cannot list entries");
    finishUnwatch();
    await Promise.all([closing, failed]);
    expect(ipc.mock.calls).toEqual([
      ["unwatch_path", { path }],
      ["unregister_source", { sourceId: "old" }],
      ["register_zip_source", { archivePath: alias }],
      ["unwatch_path", { path }],
      ["unregister_source", { sourceId: "new" }],
    ]);
  });

  it("keeps a shared archive until both Explorer and its last tab release it", async () => {
    vi.mocked(invoke).mockClear();
    const source: DocumentSourceInfo = {
      id: "archive",
      kind: "zip",
      nativePath: "C:/notes.zip",
      label: "Notes",
      capabilities: {
        watch: "container",
        externalEditor: false,
        respectGitignore: false,
        fullTextSearch: true,
        wikiLinks: true,
      },
    };
    const tab: Tab = {
      id: "1",
      title: "a",
      source,
      path: "archive:a.md",
      document: { sourceId: source.id, path: "a.md" },
    };
    explorerStore.setRoot(source.nativePath, [], source);
    try {
      expect([...watchedDocuments("c:/NOTES.zip", [tab], source).archives.keys()]).toEqual([
        source.id,
      ]);
      await releaseArchive(source, () => []);
      expect(invoke).not.toHaveBeenCalled();
      await releaseArchive({ ...source, id: "stale" }, () => []);
      expect(invoke).toHaveBeenCalledWith("unregister_source", { sourceId: "stale" });
      explorerStore.clear();
      await releaseArchive(source, () => [tab]);
      expect(invoke).not.toHaveBeenCalledWith("unwatch_path", expect.anything());
      await releaseArchive(source, () => []);
      expect(invoke).toHaveBeenCalledWith("unwatch_path", { path: source.nativePath });
      expect(invoke).toHaveBeenCalledWith("unregister_source", { sourceId: source.id });
    } finally {
      explorerStore.clear();
    }
  });
});
