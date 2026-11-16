<script lang="ts">
  import { untrack } from "svelte";
  import { metadataStore } from "$lib/stores/metadata.svelte";
  import { explorerStore } from "$lib/stores/explorer.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { linkInspectorStore } from "$lib/stores/links.svelte";
  import { openSourceMarkdown } from "$lib/actions/file-actions";
  import {
    matchesMetadata,
    metadataKeys,
    displayMetadataValue,
    MAX_METADATA_RESULTS,
    type MetadataFilter,
    type MetadataDocument,
  } from "$lib/metadata";
  import { i18n } from "$lib/i18n/index.svelte";
  const m = $derived(i18n.m);
  let query = $state("");
  let folder = $state("");
  let filters = $state<MetadataFilter[]>([]);
  let openError = $state("");
  const sameSource = $derived(explorerStore.source?.id === metadataStore.sourceId);
  const matches = $derived(
    sameSource
      ? metadataStore.documents.filter((document) =>
          matchesMetadata(document, query, folder, filters)
        )
      : []
  );
  const keys = $derived(metadataKeys(sameSource ? metadataStore.documents : []));
  $effect(() => {
    const source = explorerStore.source;
    const revision = linkInspectorStore.revision;
    void settingsStore.settings.showHiddenFiles;
    void settingsStore.settings.respectGitignore;
    if (source)
      untrack(() => {
        void metadataStore.load(source, revision);
      });
  });
  function refresh() {
    if (explorerStore.source)
      void metadataStore.load(explorerStore.source, linkInspectorStore.revision, true);
  }
  async function open(document: MetadataDocument) {
    const source = explorerStore.source;
    if (!source || !sameSource) return;
    try {
      openError = "";
      await openSourceMarkdown({ sourceId: source.id, path: document.path }, source);
    } catch (error) {
      openError = String(error);
    }
  }
</script>

<div class="flex h-full flex-col text-xs">
  <form
    class="space-y-2 border-b p-2"
    onsubmit={(event) => {
      event.preventDefault();
      refresh();
    }}
  >
    <input
      class="w-full rounded border bg-background p-1.5"
      placeholder={m.metadata.query}
      aria-label={m.metadata.query}
      maxlength="512"
      bind:value={query}
    />
    <input
      class="w-full rounded border bg-background p-1.5"
      placeholder={m.metadata.folder}
      aria-label={m.metadata.folder}
      maxlength="4096"
      bind:value={folder}
    />
    <datalist id="metadata-property-keys"
      >{#each keys.items as key (key)}<option value={key}></option>{/each}</datalist
    >
    {#if keys.partial}<p class="text-muted-foreground" role="status">
        {m.metadata.keysLimited}
      </p>{/if}
    {#each filters as filter, index (index)}
      <fieldset class="space-y-1 rounded border p-1.5">
        <legend>{m.metadata.condition} {index + 1}</legend>
        <input
          class="w-full rounded border bg-background p-1"
          aria-label={m.metadata.key}
          placeholder={m.metadata.key}
          list="metadata-property-keys"
          maxlength="128"
          bind:value={filter.key}
        />
        <select
          class="w-full rounded border bg-background p-1"
          aria-label={m.metadata.condition}
          bind:value={filter.operator}
        >
          <option value="exists">{m.metadata.exists}</option><option value="equals"
            >{m.metadata.equals}</option
          ><option value="contains">{m.metadata.contains}</option>
        </select>
        {#if filter.operator !== "exists"}<input
            class="w-full rounded border bg-background p-1"
            aria-label={m.metadata.value}
            placeholder={m.metadata.value}
            maxlength="2048"
            bind:value={filter.value}
          />{/if}
        <button
          type="button"
          class="text-muted-foreground hover:underline"
          onclick={() => (filters = filters.filter((_, i) => i !== index))}
          >{m.metadata.remove}</button
        >
      </fieldset>
    {/each}
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        class="rounded border px-2 py-1 disabled:opacity-30"
        disabled={filters.length >= 8}
        onclick={() => (filters = [...filters, { key: "tags", operator: "equals", value: "" }])}
        >{m.metadata.addCondition}</button
      >
      <button type="submit" class="rounded border px-2 py-1" disabled={metadataStore.isLoading}
        >{m.metadata.refresh}</button
      >
      <button
        type="button"
        class="text-muted-foreground hover:underline"
        onclick={() => {
          query = "";
          folder = "";
          filters = [];
        }}>{m.metadata.clear}</button
      >
    </div>
  </form>
  <div class="flex-1 space-y-2 overflow-y-auto p-2" aria-live="polite">
    {#if !explorerStore.source}<p>{m.metadata.noSource}</p>
    {:else if metadataStore.isLoading}<p role="status">{m.metadata.loading}</p>
    {:else if metadataStore.error}<p role="alert" class="break-words text-destructive">
        {metadataStore.error}
      </p>
    {:else if sameSource}
      {#if metadataStore.partial}<p class="rounded bg-muted p-2">
          {m.metadata.partial}
          {m.metadata.failed(metadataStore.failed)}
        </p>{/if}
      <p class="text-muted-foreground">{m.metadata.results(matches.length)}</p>
      {#if matches.length > MAX_METADATA_RESULTS}<p>{m.metadata.limited}</p>{/if}
      {#if matches.length === 0}<p>{m.metadata.noResults}</p>{/if}
      {#each matches.slice(0, MAX_METADATA_RESULTS) as document (document.path)}
        <button
          type="button"
          class="block w-full space-y-1 rounded border p-2 text-left hover:bg-accent"
          onclick={() => open(document)}
        >
          <span class="block break-words font-medium">{document.title}</span>
          <span class="block break-words text-muted-foreground">{document.path}</span>
          {#if document.description}<span class="block break-words">{document.description}</span
            >{/if}
          {#each settingsStore.settings.metadataDisplayFields as field (field.key)}
            {#if Object.hasOwn(document.data, field.key)}<span
                class="block break-words text-muted-foreground"
                >{field.label || field.key}: {displayMetadataValue(
                  document.data[field.key],
                  field
                )}</span
              >{/if}
          {/each}
          {#if document.invalid}<span class="block text-muted-foreground">{m.metadata.invalid}</span
            >{/if}
        </button>
      {/each}
    {/if}
    {#if openError}<p role="alert" class="break-words text-destructive">{openError}</p>{/if}
  </div>
</div>
