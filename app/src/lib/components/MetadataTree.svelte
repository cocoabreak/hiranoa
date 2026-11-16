<script lang="ts">
  import MetadataTree from "./MetadataTree.svelte";
  let { value, depth = 0 }: { value: unknown; depth?: number } = $props();
  const entries = $derived(value && typeof value === "object" ? Object.entries(value) : []);
</script>

{#if value && typeof value === "object" && depth < 8}
  <dl class="space-y-1 border-l pl-2">
    {#each entries as [key, child] (key)}
      <div class="break-words text-xs">
        {#if Array.isArray(child) && child.every((entry) => entry === null || typeof entry !== "object")}
          <dt class="text-muted-foreground">{key}</dt>
          <dd class="mt-1 flex flex-wrap gap-1">
            {#each child as entry, index (index)}<span class="rounded-full bg-muted px-2 py-0.5"
                >{String(entry)}</span
              >{/each}
          </dd>
        {:else if child && typeof child === "object"}
          <details>
            <summary class="cursor-pointer text-muted-foreground"
              >{Array.isArray(value) ? `#${Number(key) + 1}` : key}</summary
            >
            <dd class="mt-1"><MetadataTree value={child} depth={depth + 1} /></dd>
          </details>
        {:else}
          <dt class="text-muted-foreground">
            {Array.isArray(value) ? `#${Number(key) + 1}` : key}
          </dt>
          <dd class="whitespace-pre-wrap">{String(child)}</dd>
        {/if}
      </div>
    {/each}
  </dl>
{:else}
  <span class="break-words text-xs">{value === null ? "null" : String(value)}</span>
{/if}
