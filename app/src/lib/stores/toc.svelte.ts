import { createPaneScopedStore } from "./workspace.svelte";
import type { TocHeading } from "$lib/types";
import { createHeadingIdAllocator, headingBaseId } from "$lib/markdown/heading-anchor";

export function withReferenceHeadingIds(headings: TocHeading[]): TocHeading[] {
  const allocateId = createHeadingIdAllocator();
  return headings.map((heading, index) => ({
    ...heading,
    referenceId: allocateId(headingBaseId(heading.anchorText ?? heading.text, index)),
  }));
}

function createTocStore() {
  let headings = $state<TocHeading[]>([]);
  let activeId = $state<string | null>(null);
  let truncated = $state(false);

  return {
    get headings() {
      return headings;
    },
    get activeId() {
      return activeId;
    },
    get truncated() {
      return truncated;
    },
    setHeadings(h: TocHeading[]) {
      headings = h;
      truncated = false;
    },
    setSafeOutline(h: TocHeading[], isTruncated: boolean) {
      headings = withReferenceHeadingIds(h);
      truncated = isTruncated;
    },
    setActiveId(id: string | null) {
      activeId = id;
    },
  };
}

export const tocStore = createPaneScopedStore(createTocStore);
