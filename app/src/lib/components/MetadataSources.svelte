<script lang="ts">
  import {
    captureOpenTarget,
    captureOtherTarget,
    navigateOpenedAnchor,
  } from "$lib/actions/workspace-actions";
  import { showOpenOtherMenu } from "$lib/actions/open-other-menu";
  import { untrack } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { openSourceMarkdown } from "$lib/actions/file-actions";
  import { tabStore } from "$lib/stores/tab.svelte";
  import { sourceMetadataStore as metadataStore } from "$lib/stores/metadata.svelte";
  import { linkInspectorStore } from "$lib/stores/links.svelte";
  import { linkPreviewStore } from "$lib/stores/link-preview.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { contentStore } from "$lib/stores/content.svelte";
  import { extractFrontmatter } from "$lib/markdown/frontmatter";
  import { sourceDocument, MAX_METADATA_RESULTS, type MetadataSource } from "$lib/metadata";
  import { i18n } from "$lib/i18n/index.svelte";

  const m = $derived(i18n.m);
  const tab = $derived(tabStore.tabs.find((entry) => entry.id === tabStore.activeTabId));
  let enabled = $state(false);
  let error = $state<string | null>(null);
  const sameSource = $derived(!!tab?.source && metadataStore.sourceId === tab.source.id);
  let outgoing = $state<MetadataSource[]>([]);
  let currentLoading = $state(false);
  let currentPartial = $state(false);
  let currentInvalid = $state(false);
  const currentFailureCount = $derived(
    Number(
      currentInvalid && !metadataStore.documents.some((entry) => entry.path === tab?.document?.path)
    )
  );
  const incoming = $derived(
    sameSource
      ? [
          ...new Set(
            metadataStore.sources
              .filter(
                (edge) =>
                  edge.status === "ready" &&
                  (tab?.source?.kind === "native"
                    ? edge.path?.toLowerCase() === tab?.document?.path.toLowerCase()
                    : edge.path === tab?.document?.path)
              )
              .map((edge) => edge.from)
          ),
        ]
      : []
  );

  $effect(() => {
    const current = tab;
    const source = current?.source;
    const raw = current ? contentStore.get(current.path)?.raw : undefined;
    const revision = linkInspectorStore.revision;
    void metadataStore.version;
    void settingsStore.settings.showHiddenFiles;
    void settingsStore.settings.respectGitignore;
    let cancelled = false;
    if (enabled && source && current?.document && raw !== undefined)
      untrack(() => {
        currentLoading = true;
        currentPartial = false;
        currentInvalid = false;
        outgoing = [];
        error = null;
        void (async () => {
          await metadataStore.load(source, revision);
          if (cancelled) return;
          const parsed = extractFrontmatter(raw);
          const edges = await metadataStore.sourcesFor(
            {
              path: current.document!.path,
              title: current.title,
              description: "",
              data: parsed.data ?? {},
              invalid: !!parsed.invalid,
            },
            source.id
          );
          if (!cancelled) {
            outgoing = edges.items;
            currentPartial = edges.partial;
            currentInvalid = edges.invalid;
          }
        })()
          .catch((cause) => {
            if (!cancelled) error = String(cause);
          })
          .finally(() => {
            if (!cancelled) currentLoading = false;
          });
      });
    return () => {
      cancelled = true;
    };
  });

  async function refresh() {
    if (tab?.source) {
      await metadataStore.load(tab.source, linkInspectorStore.revision, true);
    }
  }
  async function open(edge: MetadataSource, other = false) {
    const openTarget = other ? captureOtherTarget() : captureOpenTarget();
    if (!tab?.source) return;
    error = null;
    try {
      if (edge.status === "external") await openUrl(edge.raw);
      else {
        const target = sourceDocument(edge, tab.source.id);
        if (
          target &&
          (await openSourceMarkdown(target, tab.source, undefined, openTarget)) &&
          edge.anchor
        )
          navigateOpenedAnchor(openTarget, edge.anchor);
      }
    } catch (cause) {
      error = String(cause);
    }
  }
  async function openIncoming(path: string, other = false) {
    const openTarget = other ? captureOtherTarget() : captureOpenTarget();
    if (!tab?.source) return;
    try {
      await openSourceMarkdown(
        { sourceId: tab.source.id, path },
        tab.source,
        undefined,
        openTarget
      );
    } catch (cause) {
      error = String(cause);
    }
  }
  function preview(event: MouseEvent | FocusEvent, edge: MetadataSource) {
    if (!tab?.document || !tab.source) return;
    const target = sourceDocument(edge, tab.source.id);
    const element = event.currentTarget as HTMLElement;
    if (target)
      linkPreviewStore.begin({
        current: tab.document,
        target,
        sourceGeneration: tab.source.generation ?? 0,
        anchor: edge.anchor,
        origin: element,
        getRect: () => (element.isConnected ? element.getBoundingClientRect() : null),
      });
  }
</script>

{#if tab?.document && tab.source}
  <details class="border-b px-3 py-2" ontoggle={(event) => (enabled = event.currentTarget.open)}>
    <summary class="cursor-pointer text-xs font-semibold text-muted-foreground"
      >{m.metadata.sources} / {m.metadata.usedBy}</summary
    >
    <div class="mt-2 space-y-2 text-xs">
      <button
        type="button"
        class="rounded border px-2 py-1"
        onclick={refresh}
        disabled={metadataStore.isLoading}>{m.metadata.refresh}</button
      >
      {#if metadataStore.isLoading || currentLoading}<p role="status">{m.metadata.loading}</p>
      {:else if metadataStore.error}<p role="alert" class="break-words text-destructive">
          {metadataStore.error}
        </p>
      {:else if sameSource}
        {#if metadataStore.partial || currentPartial || currentInvalid}<p
            role="status"
            class="text-muted-foreground"
          >
            {m.metadata.partial}
            {m.metadata.failed(metadataStore.failed + currentFailureCount)}
          </p>{/if}
        <p class="font-semibold">{m.metadata.sources}</p>
        {#if outgoing.length === 0}<p class="text-muted-foreground">
            {currentInvalid ? m.metadata.invalid : m.metadata.emptySources}
          </p>{/if}
        {#each outgoing.slice(0, MAX_METADATA_RESULTS) as edge, index (index)}
          <div class="break-words">
            <span class="text-muted-foreground">{m.metadata.statuses[edge.status]}: </span>
            {#if edge.status === "ready" || edge.status === "external"}
              <button
                type="button"
                class="text-left hover:underline"
                onclick={(event) => open(edge, event.shiftKey)}
                oncontextmenu={(event) => {
                  if (edge.status === "ready")
                    void showOpenOtherMenu(event, () => open(edge, true));
                }}
                onmouseenter={(event) => preview(event, edge)}
                onmouseleave={(event) => linkPreviewStore.hideFromOrigin(event.currentTarget)}
                onfocus={(event) => preview(event, edge)}
                onblur={(event) => linkPreviewStore.hideFromOrigin(event.currentTarget)}
                >{edge.raw}</button
              >
            {:else}<span>{edge.raw}</span>{/if}
          </div>
        {/each}
        <p class="pt-2 font-semibold">{m.metadata.usedBy}</p>
        <p class="text-muted-foreground">{m.metadata.incomingNote}</p>
        {#if incoming.length === 0}<p class="text-muted-foreground">
            {m.metadata.emptyIncoming}
          </p>{/if}
        {#each incoming.slice(0, MAX_METADATA_RESULTS) as path (path)}
          <button
            type="button"
            class="block w-full break-words text-left hover:underline"
            onclick={(event) => openIncoming(path, event.shiftKey)}
            oncontextmenu={(event) => showOpenOtherMenu(event, () => openIncoming(path, true))}
            >{metadataStore.documents.find((entry) => entry.path === path)?.title || path}<span
              class="block text-muted-foreground">{path}</span
            ></button
          >
        {/each}
        {#if incoming.length > MAX_METADATA_RESULTS}<p>{m.metadata.limited}</p>{/if}
      {/if}
      {#if error}<p role="alert" class="break-words text-destructive">{error}</p>{/if}
    </div>
  </details>
{/if}
