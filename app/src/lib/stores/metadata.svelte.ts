import { invoke } from "@tauri-apps/api/core";
import { settingsStore } from "$lib/stores/settings.svelte";
import {
  metadataDocument,
  metadataSources,
  MAX_SOURCES_PER_DOCUMENT,
  type MetadataCandidate,
  type MetadataDocument,
  type MetadataSource,
  type SourceStatus,
} from "$lib/metadata";
import type { DocumentSourceInfo } from "$lib/types";

interface CandidateResponse {
  documents: MetadataCandidate[];
  sourceGeneration: number;
  truncated: boolean;
  failed: number;
}
interface TargetResponse {
  path: string;
  target: string | null;
  status: SourceStatus;
}
interface Request {
  source: DocumentSourceInfo;
  scope: string;
  id: number;
  hidden: boolean;
  gitignore: boolean;
  refresh: boolean;
}
const MAX_TARGETS = 2048;
const MAX_TARGET_BYTES = 512 * 1024;

interface MetadataSnapshot {
  documents: MetadataDocument[];
  sources: MetadataSource[];
  partial: boolean;
  failed: number;
}

class MetadataCatalog {
  private entries = new Map<string, Promise<MetadataSnapshot>>();
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<
    (scope: string, snapshot: MetadataSnapshot | null, error?: unknown) => void
  >();
  subscribe(listener: (scope: string, snapshot: MetadataSnapshot | null, error?: unknown) => void) {
    this.listeners.add(listener);
  }
  enqueue<T>(build: () => Promise<T>): Promise<T> {
    const result = this.queue.then(build, build);
    this.queue = result.catch(() => {});
    return result;
  }

  read(request: Request, build: () => Promise<MetadataSnapshot>): Promise<MetadataSnapshot> {
    const cached = this.entries.get(request.scope);
    if (cached && !request.refresh) return cached;
    // Serialize native/ZIP scans across consumers; keep at most two Source snapshots.
    const result = this.enqueue(build);
    this.entries.set(request.scope, result);
    while (this.entries.size > 2) this.entries.delete(this.entries.keys().next().value!);
    void result.then(
      (snapshot) => {
        if (this.entries.get(request.scope) === result)
          for (const listener of this.listeners) listener(request.scope, snapshot);
      },
      (error: unknown) => {
        if (this.entries.get(request.scope) !== result) return;
        this.entries.delete(request.scope);
        for (const listener of this.listeners) listener(request.scope, null, error);
      }
    );
    return result;
  }
}

export class MetadataStore {
  constructor(private readonly catalog = new MetadataCatalog()) {
    this.catalog.subscribe((scope, snapshot, error) => {
      if (scope !== this.activeScope || this.requestedScope !== null) return;
      if (snapshot) this.applySnapshot(snapshot, scope);
      else {
        this.documents = [];
        this.sources = [];
        this.error = String(error);
        this.scope = null;
      }
    });
  }
  documents = $state<MetadataDocument[]>([]);
  sources = $state<MetadataSource[]>([]);
  isLoading = $state(false);
  error = $state<string | null>(null);
  partial = $state(false);
  failed = $state(0);
  sourceId = $state<string | null>(null);
  version = $state(0);
  private scope: string | null = null;
  private activeScope: string | null = null;
  private requestedScope: string | null = null;
  private requestId = 0;
  private queued: Request | null = null;
  private runner: Promise<void> | null = null;

  async sourcesFor(
    document: MetadataDocument,
    sourceId: string
  ): Promise<{ items: MetadataSource[]; partial: boolean; invalid: boolean }> {
    const edges = metadataSources(document, sourceId);
    const raw = document.data.sources;
    const partial = Array.isArray(raw) && raw.length > MAX_SOURCES_PER_DOCUMENT;
    const invalid =
      document.invalid ||
      (raw !== undefined &&
        (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")));
    const indexed =
      this.sourceId === sourceId ? this.sources.filter((edge) => edge.from === document.path) : [];
    if (
      edges.length === indexed.length &&
      edges.every((edge, index) => edge.raw === indexed[index].raw)
    )
      return { items: indexed, partial, invalid };
    const paths = [
      ...new Set(
        edges.flatMap((edge) =>
          edge.path && new TextEncoder().encode(edge.path).length <= 4096 ? [edge.path] : []
        )
      ),
    ];
    if (!paths.length) return { items: edges, partial, invalid };
    // Current documents remain navigable even when hidden, ignored, or outside the catalog limit.
    const targets = await this.catalog.enqueue(() =>
      invoke<TargetResponse[]>("inspect_source_metadata_targets", { sourceId, paths })
    );
    const byPath = new Map(targets.map((target) => [target.path, target]));
    const items = edges.map((edge) => {
      const target = edge.path ? byPath.get(edge.path) : undefined;
      return target ? { ...edge, path: target.target ?? edge.path, status: target.status } : edge;
    });
    return { items, partial, invalid };
  }

  clear() {
    this.requestId++;
    this.queued = null;
    this.scope = this.requestedScope = null;
    this.activeScope = null;
    this.sourceId = null;
    this.documents = [];
    this.sources = [];
    this.partial = false;
    this.failed = 0;
    this.error = null;
    this.isLoading = false;
  }

  load(source: DocumentSourceInfo, revision: number, refresh = false): Promise<void> {
    const hidden = settingsStore.settings.showHiddenFiles;
    const gitignore = settingsStore.settings.respectGitignore;
    const scope = JSON.stringify([source.id, source.generation ?? 0, hidden, gitignore, revision]);
    if (!refresh && (this.scope === scope || this.requestedScope === scope))
      return this.runner ?? Promise.resolve();
    this.requestedScope = scope;
    this.activeScope = scope;
    this.queued = { source, scope, id: ++this.requestId, hidden, gitignore, refresh };
    this.sourceId = source.id;
    this.documents = [];
    this.sources = [];
    this.partial = false;
    this.failed = 0;
    this.error = null;
    this.isLoading = true;
    if (!this.runner) {
      this.runner = this.runQueue().finally(() => {
        this.runner = null;
      });
    }
    return this.runner;
  }

  private async runQueue(): Promise<void> {
    while (this.queued) {
      const request = this.queued;
      this.queued = null;
      await this.execute(request);
    }
  }

  private async execute(request: Request): Promise<void> {
    try {
      const snapshot = await this.catalog.read(request, async () => {
        const response = await invoke<CandidateResponse>("get_source_metadata_candidates", {
          sourceId: request.source.id,
          showHiddenFiles: request.hidden,
          respectGitignore: request.gitignore,
        });
        if (response.sourceGeneration !== (request.source.generation ?? 0))
          throw new Error("Source changed; refresh");
        const documents: MetadataDocument[] = [];
        for (let offset = 0; offset < response.documents.length; offset += 32) {
          documents.push(...response.documents.slice(offset, offset + 32).map(metadataDocument));
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        let partial = response.truncated;
        let failed = response.failed;
        const sources: MetadataSource[] = [];
        for (const document of documents) {
          failed += Number(document.invalid);
          const raw = document.data.sources;
          if (
            raw !== undefined &&
            (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string"))
          )
            failed++;
          if (Array.isArray(raw) && raw.length > MAX_SOURCES_PER_DOCUMENT) partial = true;
          if (sources.length >= 4096) {
            partial ||= Array.isArray(raw) && raw.length > 0;
            continue;
          }
          const edges = metadataSources(document, request.source.id);
          const remaining = 4096 - sources.length;
          sources.push(...edges.slice(0, remaining));
          partial ||= edges.length > remaining;
        }
        const paths: string[] = [];
        const seen = new Set<string>();
        let bytes = 0;
        for (const source of sources) {
          if (!source.path || seen.has(source.path)) continue;
          const size = new TextEncoder().encode(source.path).length;
          if (paths.length >= MAX_TARGETS || bytes + size > MAX_TARGET_BYTES || size > 4096) {
            partial = true;
            continue;
          }
          seen.add(source.path);
          paths.push(source.path);
          bytes += size;
        }
        const targets = paths.length
          ? await invoke<TargetResponse[]>("inspect_source_metadata_targets", {
              sourceId: request.source.id,
              paths,
            })
          : [];
        const byPath = new Map(targets.map((target) => [target.path, target]));
        for (const source of sources) {
          const target = source.path ? byPath.get(source.path) : undefined;
          if (target) {
            source.status = target.status;
            source.path = target.target ?? source.path;
          }
        }
        return { documents, sources, partial: partial || failed > 0, failed };
      });
      if (request.id !== this.requestId) return;
      this.applySnapshot(snapshot, request.scope);
    } catch (error) {
      if (request.id === this.requestId) {
        this.error = String(error);
        this.scope = null;
      }
    } finally {
      if (request.id === this.requestId) {
        this.isLoading = false;
        this.requestedScope = null;
      }
    }
  }
  private applySnapshot(snapshot: MetadataSnapshot, scope: string): void {
    this.documents = snapshot.documents;
    this.sources = snapshot.sources;
    this.partial = snapshot.partial;
    this.failed = snapshot.failed;
    this.error = null;
    this.scope = scope;
    this.version++;
  }
}

const sharedCatalog = new MetadataCatalog();
export const metadataStore = new MetadataStore(sharedCatalog);
export const sourceMetadataStore = new MetadataStore(sharedCatalog);
