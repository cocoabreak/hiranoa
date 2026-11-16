import { JSON_SCHEMA, load } from "js-yaml";

export const MAX_FRONTMATTER_BYTES = 16 * 1024;
const MAX_NODES = 512;
const MAX_STRING_LENGTH = 2048;

/** Shared by rendering, previews and the read-only metadata index. */
export function parseFrontmatterYaml(yaml: string): Record<string, unknown> {
  if (new TextEncoder().encode(yaml).length > MAX_FRONTMATTER_BYTES) throw new Error("size");
  const value = load(yaml, { schema: JSON_SCHEMA, maxAliases: 0, maxDepth: 8 });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mapping");
  let nodes = 0;
  function validate(entry: unknown, depth: number): void {
    if (++nodes > MAX_NODES || depth > 8) throw new Error("nodes");
    if (typeof entry === "string" && entry.length > MAX_STRING_LENGTH) throw new Error("string");
    if (typeof entry === "number" && !Number.isFinite(entry)) throw new Error("number");
    if (entry && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        if (key.length > MAX_STRING_LENGTH) throw new Error("key");
        validate(child, depth + 1);
      }
    }
  }
  validate(value, 0);
  return value as Record<string, unknown>;
}

export interface FrontmatterResult {
  data: Record<string, unknown> | null;
  content: string; // frontmatterブロックを取り除いた残りのMarkdown
  invalid?: boolean;
}

// ファイル先頭の --- ... --- ブロックのみを対象とする（本文中の水平線とは区別するため
// 文字列の先頭からのみマッチさせる）
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function extractFrontmatter(raw: string): FrontmatterResult {
  const match = raw.slice(0, MAX_FRONTMATTER_BYTES + 16).match(FRONTMATTER_PATTERN);
  if (!match)
    return {
      data: null,
      content: raw,
      ...(raw.startsWith("---\n") || raw.startsWith("---\r\n") ? { invalid: true } : {}),
    };

  try {
    const parsed = parseFrontmatterYaml(match[1]);
    // マッピング（オブジェクト）として解析できた場合のみメタデータとして扱う
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, content: raw.slice(match[0].length) };
    }
    return { data: null, content: raw };
  } catch {
    return { data: null, content: raw, invalid: true };
  }
}
