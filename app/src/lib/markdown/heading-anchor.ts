// @ts-expect-error markdown-it-emojiはデータsubpathの型定義を公開していない。
import emojiDefinitions from "markdown-it-emoji/lib/data/full.mjs";
// @ts-expect-error markdown-it-emojiはデータsubpathの型定義を公開していない。
import emojiShortcuts from "markdown-it-emoji/lib/data/shortcuts.mjs";

const knownEmojiNames = new Set(Object.keys(emojiDefinitions as Record<string, string>));
const emojiShortcodePattern = /:([a-z0-9_+-]+):/gi;
const emojiShortcutPattern = new RegExp(
  Object.entries(emojiShortcuts as Record<string, string | string[]>)
    .filter(([name]) => knownEmojiNames.has(name))
    .flatMap(([, aliases]) => (Array.isArray(aliases) ? aliases : [aliases]))
    .sort((left, right) => right.length - left.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "g"
);
const emojiShortcutBoundary = /[\p{Z}\p{P}\p{Cc}]/u;

function stripRenderedEmojiShortcuts(value: string): string {
  return value.replace(emojiShortcutPattern, (match, offset: number, source: string) => {
    const before = offset > 0 ? source[offset - 1] : "";
    const after = offset + match.length < source.length ? source[offset + match.length] : "";
    if (
      (before && !emojiShortcutBoundary.test(before)) ||
      (after && !emojiShortcutBoundary.test(after))
    ) {
      return match;
    }
    return "";
  });
}

/** 通常テキストでemojiプラグインが展開する既知ショートコードを、DOM textContent相当に除去する。 */
function stripRenderedEmojiShortcodes(value: string): string {
  return stripRenderedEmojiShortcuts(
    value.replace(emojiShortcodePattern, (match, name: string) =>
      knownEmojiNames.has(name) ? "" : match
    )
  );
}

/** インラインコード内ではemoji展開されないため、slug化前に区切りのコロンだけを外す。 */
export function headingInlineCodeText(value: string): string {
  return value
    .replace(emojiShortcodePattern, "$1")
    .replace(emojiShortcutPattern, (match) => match.replace(/[^\p{L}\p{N}\s-]/gu, ""));
}

/**
 * 見出し文字列をHiranoa内で共通利用するUnicode対応slugへ正規化する。
 * 空文字列のフォールバックと重複サフィックスは呼び出し側で扱う。
 */
export function headingSlug(value: string): string {
  return stripRenderedEmojiShortcodes(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function decodeHeadingAnchor(value: string): string {
  const withoutHash = value.replace(/^#/, "");
  try {
    return decodeURIComponent(withoutHash);
  } catch {
    return withoutHash;
  }
}

export function headingBaseId(text: string, index: number): string {
  const slug = headingSlug(text);
  return slug ? Array.from(slug).slice(0, 60).join("") : `heading-${index}`;
}

/** Allocate IDs in document order, remembering the next suffix for each base. */
export function createHeadingIdAllocator(): (base: string) => string {
  const usedIds = new Set<string>();
  const nextSuffixes = new Map<string, number>();

  return (base) => {
    let id = base;
    if (usedIds.has(base)) {
      let suffix = nextSuffixes.get(base) ?? 1;
      do {
        id = `${base}-${suffix++}`;
      } while (usedIds.has(id));
      nextSuffixes.set(base, suffix);
    }
    usedIds.add(id);
    return id;
  };
}

/** 実遷移と受動検証で共有する、見出しID・代替ID・正規化テキストの照合。 */
export function headingReferenceMatches(
  anchor: string,
  headingId: string,
  headingText: string
): boolean {
  const decoded = decodeHeadingAnchor(anchor);
  if (headingId === decoded) return true;
  const alternate = decoded.startsWith("_") ? decoded.slice(1) : `_${decoded}`;
  if (headingId === alternate) return true;
  return headingSlug(headingText) === headingSlug(decoded.replace(/^_+/, ""));
}
