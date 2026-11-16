<script lang="ts">
  import { workspaceStore } from "$lib/stores/workspace.svelte";
  import { tocStore } from "$lib/stores/toc.svelte";
  import { frontmatterStore } from "$lib/stores/frontmatter.svelte";
  import { i18n } from "$lib/i18n/index.svelte";
  import { tabStore } from "$lib/stores/tab.svelte";
  import { showHeadingReferenceMenu } from "$lib/actions/reference-menu";
  import type { TocHeading } from "$lib/types";
  import MetadataTree from "./MetadataTree.svelte";
  import MetadataSources from "./MetadataSources.svelte";

  let { onselect }: { onselect?: () => void } = $props();

  const m = $derived(i18n.m);

  function scrollTo(id: string) {
    workspaceStore
      .root()
      ?.querySelector(`#${CSS.escape(id)}`)
      ?.scrollIntoView({ behavior: "smooth" });
    tocStore.setActiveId(id);
    onselect?.();
  }

  function showReferenceMenu(event: MouseEvent, heading: TocHeading): void {
    const tab = tabStore.tabs.find((candidate) => candidate.id === tabStore.activeTabId);
    if (!tab?.document || !tab.source) return;
    void showHeadingReferenceMenu(event, {
      document: tab.document,
      source: tab.source,
      title: tab.title,
      heading: { ...heading, id: heading.referenceId ?? heading.id },
    });
  }
</script>

<div class="flex-1 overflow-y-auto py-1">
  {#if frontmatterStore.data && Object.keys(frontmatterStore.data).length > 0}
    <details class="border-b px-3 py-2">
      <summary class="cursor-pointer text-xs font-semibold text-muted-foreground">
        {m.toc.metadata}
      </summary>
      <div class="mt-2"><MetadataTree value={frontmatterStore.data} /></div>
    </details>
  {/if}
  <MetadataSources />
  {#if tocStore.headings.length === 0}
    <p class="px-3 py-2 text-xs text-muted-foreground">{m.toc.emptyPrompt}</p>
  {:else}
    {#each tocStore.headings as heading (heading.id)}
      <button
        class="block w-full truncate py-0.5 text-left text-xs transition-colors hover:text-foreground"
        class:text-foreground={heading.id === tocStore.activeId}
        class:font-medium={heading.id === tocStore.activeId}
        class:text-muted-foreground={heading.id !== tocStore.activeId}
        style="padding-left: {(heading.level - 1) * 10 + 8}px; padding-right: 8px"
        onclick={() => scrollTo(heading.id)}
        oncontextmenu={(event) => showReferenceMenu(event, heading)}
      >
        {heading.text}
      </button>
    {/each}
    {#if tocStore.truncated}
      <p class="border-t px-3 py-2 text-xs text-muted-foreground">{m.toc.outlineLimited}</p>
    {/if}
  {/if}
</div>
