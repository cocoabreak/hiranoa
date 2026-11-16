import { parseFrontmatterYaml } from "$lib/markdown/frontmatter";
import { resolveSourceRelativeMarkdownTarget } from "$lib/document-sources";
import type { DocumentRef } from "$lib/types";
import type { MetadataDisplayField } from "$lib/metadata-settings";
export { validateMetadataFields } from "$lib/metadata-settings";
export type { MetadataDisplayField } from "$lib/metadata-settings";

export const MAX_METADATA_RESULTS = 200;
export const MAX_SOURCES_PER_DOCUMENT = 64;
export const MAX_METADATA_KEYS = 200;
export const MAX_METADATA_KEY_BYTES = 16 * 1024;
export interface MetadataCandidate {
  path: string;
  yaml: string | null;
  heading: string | null;
  incomplete: boolean;
}
export interface MetadataDocument {
  path: string;
  title: string;
  description: string;
  data: Record<string, unknown>;
  invalid: boolean;
}

export function metadataKeys(documents: MetadataDocument[]): { items: string[]; partial: boolean } {
  const keys = new Set<string>();
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const document of documents)
    for (const key of Object.keys(document.data)) {
      if (keys.has(key)) continue;
      const size = encoder.encode(key).length;
      if (keys.size >= MAX_METADATA_KEYS || bytes + size > MAX_METADATA_KEY_BYTES)
        return { items: [...keys].sort(), partial: true };
      keys.add(key);
      bytes += size;
    }
  return { items: [...keys].sort(), partial: false };
}
export type SourceStatus =
  "ready" | "external" | "missing" | "outsideSource" | "unsupported" | "unverifiable";
export interface MetadataSource {
  from: string;
  raw: string;
  path: string | null;
  anchor: string | null;
  status: SourceStatus;
}
export interface MetadataFilter {
  key: string;
  operator: "exists" | "equals" | "contains";
  value: string;
}
export function metadataDocument(candidate: MetadataCandidate): MetadataDocument {
  let data: Record<string, unknown> = {};
  let invalid = candidate.incomplete;
  if (candidate.yaml !== null) {
    try {
      data = parseFrontmatterYaml(candidate.yaml);
    } catch {
      invalid = true;
    }
  }
  return {
    path: candidate.path,
    title:
      typeof data.title === "string" && data.title.trim()
        ? data.title
        : candidate.heading || candidate.path.split("/").pop() || candidate.path,
    description: typeof data.description === "string" ? data.description : "",
    data,
    invalid,
  };
}

/** URL lookup ignores fragments/trailing slashes, but preserves queries. No network access. */
export function normalizedSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return null;
  }
}

export function metadataSources(document: MetadataDocument, sourceId: string): MetadataSource[] {
  if (!Array.isArray(document.data.sources)) return [];
  return document.data.sources
    .slice(0, MAX_SOURCES_PER_DOCUMENT)
    .flatMap((entry): MetadataSource[] => {
      if (typeof entry !== "string") return [];
      const raw = entry.trim();
      const external = normalizedSourceUrl(raw);
      const base: MetadataSource = {
        from: document.path,
        raw,
        path: null,
        anchor: null,
        status: "unsupported",
      };
      if (external) return [{ ...base, status: "external" }];
      if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("//") || raw.startsWith("\\\\"))
        return [{ ...base, status: "outsideSource" }];
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || raw.includes("\0")) return [base];
      const resolved = resolveSourceRelativeMarkdownTarget({ sourceId, path: document.path }, raw);
      if (!resolved) return [{ ...base, status: "outsideSource" }];
      return [
        { ...base, path: resolved.document.path, anchor: resolved.anchor, status: "unverifiable" },
      ];
    });
}

function scalarValues(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
      ? [String(entry)]
      : []
  );
}

export function matchesMetadata(
  document: MetadataDocument,
  query: string,
  folder: string,
  filters: MetadataFilter[]
): boolean {
  const scope = folder
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (scope && !document.path.startsWith(`${scope}/`)) return false;
  if (query.trim()) {
    const haystack = [
      document.title,
      document.path,
      document.description,
      ...scalarValues(document.data.tags),
    ]
      .join("\n")
      .toLocaleLowerCase();
    if (
      !query
        .trim()
        .toLocaleLowerCase()
        .split(/\s+/)
        .every((term) => haystack.includes(term))
    )
      return false;
  }
  return filters.slice(0, 8).every((filter) => {
    if (!filter.key.trim()) return true;
    if (!Object.hasOwn(document.data, filter.key)) return false;
    if (filter.operator === "exists") return true;
    const values = scalarValues(document.data[filter.key]);
    const url = filter.key === "sources" ? normalizedSourceUrl(filter.value) : null;
    return values.some((value) =>
      url
        ? normalizedSourceUrl(value) === url
        : filter.operator === "equals"
          ? value === filter.value
          : value.includes(filter.value)
    );
  });
}

export function displayMetadataValue(value: unknown, field?: MetadataDisplayField): string {
  return scalarValues(value)
    .map((entry) => (field && Object.hasOwn(field.values, entry) ? field.values[entry] : entry))
    .join(", ");
}

export function sourceDocument(source: MetadataSource, sourceId: string): DocumentRef | null {
  return source.status === "ready" && source.path !== null ? { sourceId, path: source.path } : null;
}
