import MarkdownIt from "markdown-it";
import { extractFrontmatter } from "$lib/markdown/frontmatter";
import { viewerPlugins } from "$lib/plugins";

export interface MarkdownBlock {
  raw: string;
  start: number;
  end: number;
  kind: string;
}
export type ChangeKind = "equal" | "changed" | "added" | "deleted";
export interface DiffPair {
  left: number | null;
  right: number | null;
  kind: ChangeKind;
}
export const MAX_BLOCKS = 800;
export const MAX_LINES = 4000;

export async function markdownBlocks(
  raw: string,
  renderers: Record<string, boolean> = {}
): Promise<MarkdownBlock[]> {
  const parser = new MarkdownIt({ html: true });
  for (const plugin of viewerPlugins)
    if (renderers[plugin.name] ?? plugin.defaultEnabled) {
      try {
        await plugin.extendMarkdownIt?.(parser);
      } catch (error) {
        console.warn("History syntax extension failed", error);
      }
    }
  const normalized = raw.replace(/\r\n?/g, "\n");
  const { content } = extractFrontmatter(normalized);
  const prefix = normalized.slice(0, normalized.length - content.length);
  const offset = prefix.split("\n").length - 1;
  const lines = content.split("\n");
  const result: MarkdownBlock[] = prefix
    ? [{ raw: prefix, start: 0, end: offset, kind: "frontmatter" }]
    : [];
  if (lines.length + offset > MAX_LINES) throw new Error("Comparison exceeds 4000 lines");
  const covered = new Set<number>();
  let inFootnotes = false;
  for (const token of parser.parse(content, {})) {
    if (token.type === "footnote_block_open") inFootnotes = true;
    if (token.type === "footnote_block_close") inFootnotes = false;
    if (token.level !== (inFootnotes ? 1 : 0) || !token.map || token.type === "inline") continue;
    const [start, end] = token.map;
    for (let line = start; line < end; line++) covered.add(line);
    result.push({
      raw: lines.slice(start, end).join("\n"),
      start: start + offset,
      end: end + offset,
      kind: token.type,
    });
    if (result.length > MAX_BLOCKS) throw new Error("Comparison exceeds 800 blocks");
  }
  // Reference definitions have no rendered element. Keep them visible as source
  // blocks so changes to link/image destinations cannot disappear from the diff.
  for (let start = 0; start < lines.length; start++) {
    if (covered.has(start) || !lines[start].trim()) continue;
    let end = start + 1;
    while (end < lines.length && !covered.has(end) && lines[end].trim()) end++;
    result.push({
      raw: lines.slice(start, end).join("\n"),
      start: start + offset,
      end: end + offset,
      kind: "definition",
    });
    start = end - 1;
  }
  result.sort((a, b) => a.start - b.start);
  if (result.length > MAX_BLOCKS) throw new Error("Comparison exceeds 800 blocks");
  return result;
}

/** Exact matching anchors; changed runs are paired in document order. */
export function compareSequences(
  left: readonly string[],
  right: readonly string[],
  maxCells = 650_000
): DiffPair[] {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  )
    suffix++;
  const n = left.length - prefix - suffix,
    m = right.length - prefix - suffix;
  if ((n + 1) * (m + 1) > maxCells) throw new Error("Comparison is too complex");
  const table = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[at(i, j)] =
        left[i + prefix] === right[j + prefix]
          ? 1 + table[at(i + 1, j + 1)]
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
  const anchors: [number, number][] = Array.from({ length: prefix }, (_, i) => [i, i]);
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (left[i + prefix] === right[j + prefix]) {
      anchors.push([i++ + prefix, j++ + prefix]);
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) i++;
    else j++;
  }
  for (let k = suffix; k > 0; k--) anchors.push([left.length - k, right.length - k]);
  anchors.push([left.length, right.length]);
  const pairs: DiffPair[] = [];
  let a = 0,
    b = 0;
  for (const [x, y] of anchors) {
    while (a < x || b < y) {
      const old = a < x ? a++ : null,
        next = b < y ? b++ : null;
      pairs.push({
        left: old,
        right: next,
        kind: old === null ? "added" : next === null ? "deleted" : "changed",
      });
    }
    if (x < left.length) {
      pairs.push({ left: x, right: y, kind: "equal" });
      a = x + 1;
      b = y + 1;
    }
  }
  return pairs;
}

/** Coordinates use content positions, allowing different paragraph heights. */
export function mapScroll(
  position: number,
  anchors: readonly [number, number][],
  targetMax: number
): number {
  if (!anchors.length) return 0;
  let before = anchors[0],
    after = anchors.at(-1)!;
  for (let i = 1; i < anchors.length; i++)
    if (position <= anchors[i][0]) {
      before = anchors[i - 1];
      after = anchors[i];
      break;
    }
  const ratio =
    after[0] > before[0]
      ? Math.max(0, Math.min(1, (position - before[0]) / (after[0] - before[0])))
      : 0;
  return Math.max(0, Math.min(targetMax, before[1] + ratio * (after[1] - before[1])));
}

export function changedRange(
  left: string,
  right: string
): { left: [number, number]; right: [number, number] } {
  const a = Array.from(left),
    b = Array.from(right);
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - end - 1] === b[b.length - end - 1]
  )
    end++;
  const first = a.slice(0, start).join("").length;
  return {
    left: [first, left.length - a.slice(a.length - end).join("").length],
    right: [first, right.length - b.slice(b.length - end).join("").length],
  };
}

export function markTextRange(root: HTMLElement, [start, end]: [number, number]): void {
  if (start === end) return;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("pre,code,svg,math,.katex,.mermaid-pending,.mermaid-rendered"))
      nodes.push(node);
  }
  let offset = 0;
  for (const node of nodes) {
    const text = node.data,
      from = Math.max(0, start - offset),
      to = Math.min(text.length, end - offset);
    offset += text.length;
    if (to <= from) continue;
    const fragment = document.createDocumentFragment();
    fragment.append(text.slice(0, from));
    const mark = document.createElement("mark");
    mark.className = "history-word-change";
    mark.textContent = text.slice(from, to);
    fragment.append(mark, text.slice(to));
    node.replaceWith(fragment);
  }
}
