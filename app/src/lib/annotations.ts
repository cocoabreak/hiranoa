import { nativeComparisonPath, nativeDocumentIdentity } from "$lib/document-sources";
import type { DocumentRef, DocumentSourceInfo } from "$lib/types";

export const colors = ["yellow", "blue", "pink"] as const;
export type Color = (typeof colors)[number];
const contextLength = 32;
export const maxQuote = 8192;
export const maxNotes = 1000;
export const maxFileBytes = 8 * 1024 * 1024;
export interface Anchor {
  quote: string;
  before: string;
  after: string;
  heading: string;
  unique: boolean;
  start: number;
  revision: string;
}
export interface Annotation extends Anchor {
  id: string;
  color: Color;
  memo: string;
  created: string;
}

export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
}

export function documentLocation(source: DocumentSourceInfo, document: DocumentRef) {
  const native = nativeDocumentIdentity(source, document);
  return digest(
    JSON.stringify(
      native === null
        ? ["zip", nativeComparisonPath(source.nativePath), document.path]
        : ["native", native]
    )
  );
}

// Keep generated controls and diagrams out of the reading text. Block boundaries
// are explicit so inline formatting changes do not break a quote.
const excluded = "button,svg,math,script,style,.katex,[hidden],[aria-hidden=true],textarea,select";
const blocks = "p,li,h1,h2,h3,h4,h5,h6,pre,td,th,blockquote,div";
export function indexText(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const entries: { node: Text; start: number; end: number }[] = [];
  const headings: { start: number; name: string }[] = [];
  let text = "";
  let previousBlock: Element | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (!parent || parent.closest(excluded) || !node.length) continue;
    const block = parent.closest(blocks);
    if (!node.data.trim() && (parent === root || block !== previousBlock)) continue;
    if (previousBlock && block !== previousBlock) text += "\n";
    if (block !== previousBlock && block?.matches("h1,h2,h3,h4,h5,h6")) {
      headings.push({ start: text.length, name: (block.textContent ?? "").trim().slice(0, 128) });
    }
    const start = text.length;
    text += node.data;
    entries.push({ node, start, end: text.length });
    previousBlock = block;
  }
  function headingAt(start: number) {
    let low = 0,
      high = headings.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (headings[mid].start <= start) low = mid + 1;
      else high = mid;
    }
    return headings[low - 1]?.name ?? "";
  }
  function entryAt(offset: number) {
    let low = 0,
      high = entries.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (entries[mid].end <= offset) low = mid + 1;
      else high = mid;
    }
    return entries[low];
  }
  return {
    text,
    headingAt,
    capture(range: Range, revision: string): Anchor | null {
      if (!root.contains(range.commonAncestorContainer) || range.collapsed) return null;
      const selected = entries.filter(({ node }) => range.intersectsNode(node));
      const first = selected[0],
        last = selected.at(-1);
      if (!first || !last) return null;
      const start = first.start + (range.startContainer === first.node ? range.startOffset : 0);
      const end =
        last.start + (range.endContainer === last.node ? range.endOffset : last.node.length);
      const quote = text.slice(start, end);
      if (!quote.trim() || quote.length > maxQuote) return null;
      const anchor = {
        quote,
        unique: true,
        heading: headingAt(start),
        before:
          text
            .slice(Math.max(0, start - contextLength), start)
            .split("\n")
            .at(-1) ?? "",
        after: text.slice(end, end + contextLength).split("\n")[0],
        start,
        revision,
      };
      anchor.unique = locate({ text, headingAt }, anchor, null) === start;
      return anchor;
    },
    range(start: number, length: number) {
      const first = entryAt(start);
      const end = start + length;
      const last = entryAt(end - 1);
      if (!first || !last || first.start > start || last.start >= end) return null;
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      return range;
    },
  };
}

// Beyond this limit leave an annotation for manual review. One budget is
// shared by all annotations during a repaint, including imported sets.
export function matchBudget() {
  return { characters: 64 * 1024 * 1024, candidates: 8192 };
}

export function locate(
  index: Pick<ReturnType<typeof indexText>, "text" | "headingAt">,
  anchor: Anchor,
  revision: string | null,
  budget = matchBudget()
): number | null {
  const { text, headingAt } = index;
  const { quote, before, after, start } = anchor;
  const needle = before + quote + after;
  const matches = (i: number) => {
    const left = i - before.length,
      right = i + quote.length + after.length;
    return (
      left >= 0 &&
      headingAt(i) === anchor.heading &&
      text.startsWith(needle, left) &&
      (before.length === contextLength || left === 0 || text[left - 1] === "\n") &&
      (after.length === contextLength || right === text.length || text[right] === "\n")
    );
  };
  if (anchor.revision === revision && matches(start)) return start;
  if (!anchor.unique || budget.characters < text.length || budget.candidates <= 0) return null;
  budget.characters -= text.length;
  let found: number | null = null;
  for (let offset = text.indexOf(needle); offset >= 0; offset = text.indexOf(needle, offset + 1)) {
    if (--budget.candidates < 0) return null;
    const i = offset + before.length;
    if (!matches(i)) continue;
    if (found !== null) return null;
    found = i;
  }
  return found;
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function parseNote(value: unknown): Annotation {
  if (!value || typeof value !== "object") throw Error("annotation");
  const n = value as Annotation;
  if (
    typeof n.id !== "string" ||
    !uuid.test(n.id) ||
    !colors.includes(n.color) ||
    typeof n.quote !== "string" ||
    !n.quote.trim() ||
    n.quote.length > maxQuote ||
    typeof n.before !== "string" ||
    n.before.length > contextLength ||
    typeof n.after !== "string" ||
    n.after.length > contextLength ||
    typeof n.heading !== "string" ||
    n.heading.length > 128 ||
    typeof n.unique !== "boolean" ||
    !Number.isSafeInteger(n.start) ||
    n.start < 0 ||
    typeof n.revision !== "string" ||
    !/^[0-9a-f]{64}$/.test(n.revision) ||
    typeof n.memo !== "string" ||
    n.memo.length > 4096 ||
    typeof n.created !== "string" ||
    n.created.length !== 24 ||
    !Number.isFinite(Date.parse(n.created))
  )
    throw Error("annotation");
  const { id, quote, before, after, heading, unique, start, revision, color, memo, created } = n;
  return { id, quote, before, after, heading, unique, start, revision, color, memo, created };
}

export function parseExport(json: string): Annotation[] {
  const file = JSON.parse(json);
  if (
    file?.schemaVersion !== 1 ||
    !Array.isArray(file.annotations) ||
    file.annotations.length > maxNotes
  )
    throw Error("annotation file");
  return file.annotations.map(parseNote);
}

export function serializeExport(annotations: Annotation[]): string {
  const contents = JSON.stringify({ schemaVersion: 1, annotations }, null, 2);
  if (new Blob([contents]).size > maxFileBytes) throw Error("annotation file size");
  return contents;
}
