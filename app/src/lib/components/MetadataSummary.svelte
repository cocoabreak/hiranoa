<script lang="ts">
  import { extractFrontmatter } from "$lib/markdown/frontmatter";
  import { displayMetadataValue } from "$lib/metadata";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { i18n } from "$lib/i18n/index.svelte";
  let { raw }: { raw: string } = $props();
  const parsed = $derived(extractFrontmatter(raw));
  const m = $derived(i18n.m);
  const fields = $derived(
    settingsStore.settings.metadataDisplayFields.filter(
      (field) => parsed.data && Object.hasOwn(parsed.data, field.key)
    )
  );
</script>

{#if parsed.invalid}
  <p class="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground" role="status">
    {m.metadata.invalid}
  </p>
{:else if fields.length}
  <dl
    class="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b bg-muted/20 px-4 py-2 text-xs"
    aria-label={m.metadata.title}
    title={m.metadata.meaning}
  >
    {#each fields as field (field.key)}
      <div class="flex min-w-0 gap-1">
        <dt class="text-muted-foreground">{field.label || field.key}:</dt>
        <dd class="max-w-64 truncate" title={displayMetadataValue(parsed.data?.[field.key], field)}>
          {displayMetadataValue(parsed.data?.[field.key], field)}
        </dd>
      </div>
    {/each}
  </dl>
{/if}
