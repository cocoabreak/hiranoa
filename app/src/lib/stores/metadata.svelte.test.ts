import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataStore, metadataStore, sourceMetadataStore } from "./metadata.svelte";
import type { DocumentSourceInfo } from "$lib/types";
import { metadataDocument } from "$lib/metadata";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const source: DocumentSourceInfo = {
  id: "one",
  kind: "native",
  nativePath: "D:/notes",
  label: "notes",
  generation: 1,
  capabilities: {
    watch: "entries",
    externalEditor: true,
    respectGitignore: true,
    fullTextSearch: true,
    wikiLinks: true,
  },
};
const response = (path: string, yaml: string | null = null) => ({
  documents: [{ path, yaml, heading: "Title", incomplete: false }],
  sourceGeneration: 1,
  truncated: false,
  failed: 0,
});

describe("MetadataStore", () => {
  beforeEach(() => vi.clearAllMocks());
  it("reports truncated and invalid current-document sources outside the catalog", async () => {
    const store = new MetadataStore();
    invokeMock.mockResolvedValue([{ path: "a.md", target: "a.md", status: "ready" }]);
    const base = { path: ".hidden.md", title: "Hidden", description: "", invalid: false };
    const many = await store.sourcesFor(
      { ...base, data: { sources: Array(65).fill("a.md") } },
      source.id
    );
    expect(many.items).toHaveLength(64);
    expect(many.partial).toBe(true);
    const invalid = await store.sourcesFor({ ...base, data: { sources: "a.md" } }, source.id);
    expect(invalid.invalid).toBe(true);
    expect(invalid.items).toEqual([]);
  });
  it("propagates explicit refreshes and errors to the other view of the same catalog", async () => {
    invokeMock.mockResolvedValueOnce(response("old.md"));
    await Promise.all([metadataStore.load(source, 1234), sourceMetadataStore.load(source, 1234)]);
    invokeMock.mockResolvedValueOnce(response("new.md"));
    await sourceMetadataStore.load(source, 1234, true);
    expect(metadataStore.documents.map((document) => document.path)).toEqual(["new.md"]);
    const calls = invokeMock.mock.calls.length;
    await metadataStore.load(source, 1234);
    expect(invokeMock).toHaveBeenCalledTimes(calls);
    invokeMock.mockRejectedValueOnce(new Error("read failed"));
    await sourceMetadataStore.load(source, 1234, true);
    expect(metadataStore.documents).toEqual([]);
    expect(metadataStore.error).toContain("read failed");
    invokeMock.mockResolvedValueOnce(response("recovered.md"));
    await sourceMetadataStore.load(source, 1234, true);
    expect(metadataStore.error).toBeNull();
    expect(metadataStore.documents[0].path).toBe("recovered.md");
    metadataStore.clear();
    sourceMetadataStore.clear();
  });
  it("resolves current-document sources even when the document is excluded from the catalog", async () => {
    const store = new MetadataStore();
    invokeMock.mockResolvedValueOnce(response("visible.md"));
    await store.load(source, 0);
    invokeMock.mockResolvedValueOnce([
      { path: "original.md", target: "original.md", status: "ready" },
    ]);
    const edges = await store.sourcesFor(
      metadataDocument({
        path: ".hidden.md",
        yaml: "sources: [original.md]",
        heading: null,
        incomplete: false,
      }),
      source.id
    );
    expect(edges.items[0]).toMatchObject({
      from: ".hidden.md",
      path: "original.md",
      status: "ready",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("inspect_source_metadata_targets", {
      sourceId: source.id,
      paths: ["original.md"],
    });
    expect(store.documents.map((document) => document.path)).toEqual(["visible.md"]);
  });
  it("shares the same catalog between search and source views", async () => {
    invokeMock.mockResolvedValue(response("shared.md"));
    await Promise.all([metadataStore.load(source, 999), sourceMetadataStore.load(source, 999)]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(metadataStore.documents[0].path).toBe("shared.md");
    expect(sourceMetadataStore.documents[0].path).toBe("shared.md");
    metadataStore.clear();
    sourceMetadataStore.clear();
  });
  it("shares an index within a scope, resolves sources, and rebuilds after invalidation", async () => {
    const store = new MetadataStore();
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(
        command === "get_source_metadata_candidates"
          ? response("a.md", "sources: [b.md]")
          : [{ path: "b.md", target: "b.md", status: "ready" }]
      )
    );
    await store.load(source, 0);
    expect(store.sources[0]).toMatchObject({ from: "a.md", path: "b.md", status: "ready" });
    await store.load(source, 0);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await store.load(source, 1);
    expect(invokeMock).toHaveBeenCalledTimes(4);
  });
  it("serializes loads and discards a response after switching sources", async () => {
    const store = new MetadataStore();
    let resolve!: (value: ReturnType<typeof response>) => void;
    invokeMock
      .mockReturnValueOnce(new Promise((r) => (resolve = r)))
      .mockResolvedValueOnce(response("new.md"));
    const first = store.load(source, 0);
    const next = store.load({ ...source, id: "two" }, 0);
    resolve(response("old.md"));
    await Promise.all([first, next]);
    expect(store.sourceId).toBe("two");
    expect(store.documents.map((d) => d.path)).toEqual(["new.md"]);
  });
  it("reports partial results and parse failures without treating them as empty success", async () => {
    const store = new MetadataStore();
    invokeMock.mockResolvedValue({ ...response("bad.md", "x: ["), truncated: true, failed: 2 });
    await store.load(source, 0);
    expect(store.partial).toBe(true);
    expect(store.failed).toBe(3);
    expect(store.documents[0].invalid).toBe(true);
  });
  it("does not publish a mismatched generation or retain previous results on errors", async () => {
    const store = new MetadataStore();
    invokeMock.mockResolvedValueOnce(response("a.md"));
    await store.load(source, 0);
    invokeMock.mockResolvedValueOnce({ ...response("stale.md"), sourceGeneration: 0 });
    await store.load(source, 1);
    expect(store.error).toBeTruthy();
    expect(store.documents).toEqual([]);
    expect(store.isLoading).toBe(false);
  });
});
