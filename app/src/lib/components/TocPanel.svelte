<script lang="ts">
  import { ListTree, Highlighter, X } from "@lucide/svelte";
  import { focusTrap } from "$lib/actions/focus-trap";
  import { saveSettings } from "$lib/settings-store";
  import {
    DEFAULT_TOC_WIDTH,
    MAX_PANEL_WIDTH,
    MIN_PANEL_WIDTH,
    settingsStore,
  } from "$lib/stores/settings.svelte";
  import { tocStore } from "$lib/stores/toc.svelte";
  import { i18n } from "$lib/i18n/index.svelte";
  import ResizeHandle from "./ResizeHandle.svelte";
  import TOCView from "./TOCView.svelte";
  import { workspaceStore } from "$lib/stores/workspace.svelte";
  import { annotationViews } from "$lib/stores/annotation-views";

  let { compact }: { compact: boolean } = $props();

  const m = $derived(i18n.m);
  let width = $state(settingsStore.settings.tocWidth);
  let drawerOpen = $state(false);
  let tab = $state<"toc" | "notes">("toc");
  const view = $derived(annotationViews.get(workspaceStore.activePaneId));
  const showNotes = $derived(tab === "notes" && !!view);
  const notesLabel = $derived(m.annotations.title + (view?.count ? " (" + view.count + ")" : ""));
  const notesHint = $derived(view?.hasMatch ? m.annotations.same : undefined);
  function open(which: "toc" | "notes") {
    tab = which;
    if (!settingsStore.settings.tocVisible) {
      settingsStore.toggleToc();
      void saveSettings();
    }
    drawerOpen = compact;
  }
  const hasHeadings = $derived(tocStore.headings.length > 0);

  $effect(() => {
    width = settingsStore.settings.tocWidth;
  });

  $effect(() => {
    if (!compact || !settingsStore.settings.tocVisible || (!hasHeadings && !view))
      drawerOpen = false;
  });

  function closeDrawer() {
    drawerOpen = false;
  }

  function hideToc() {
    settingsStore.toggleToc();
    void saveSettings();
  }
</script>

{#snippet body()}
  <div class="flex min-h-9 shrink-0 items-center gap-1 border-b px-1">
    <div
      class="flex min-w-0 flex-1 flex-wrap gap-0.5"
      role="group"
      aria-label={m.sidebar.toc + " / " + m.annotations.title}
    >
      <button class="panel-tab" aria-pressed={!showNotes} onclick={() => (tab = "toc")}
        >{m.sidebar.toc}</button
      >
      {#if view}<button
          class="panel-tab"
          data-notes-tab
          title={notesHint}
          aria-pressed={showNotes}
          onclick={() => (tab = "notes")}
          >{notesLabel}{#if notesHint}<span aria-label={notesHint}> •</span>{/if}</button
        >{/if}
    </div>
    <button
      data-close-panel
      type="button"
      class="shrink-0 rounded p-1 hover:bg-muted"
      aria-label={m.common.close}
      onclick={compact ? closeDrawer : hideToc}><X size={14} /></button
    >
  </div>
  {#if showNotes && view}{@render view.list(closeDrawer)}{:else}<TOCView
      onselect={closeDrawer}
    />{/if}
{/snippet}
{#if (compact || !settingsStore.settings.tocVisible) && (view || (hasHeadings && settingsStore.settings.tocVisible))}
  <div
    class="absolute right-3 top-11 z-20 flex items-center gap-0.5 rounded-full border bg-background p-0.5 text-xs text-foreground shadow-sm print:hidden"
  >
    {#if hasHeadings && settingsStore.settings.tocVisible}
      <button
        class="launcher"
        aria-label={m.sidebar.openToc}
        aria-expanded={drawerOpen && !showNotes}
        aria-controls="toc-drawer"
        onclick={() => open("toc")}><ListTree size={15} />{m.sidebar.toc}</button
      >
    {/if}
    {#if view}
      <button
        class="launcher"
        data-open-annotations
        title={notesHint}
        aria-expanded={drawerOpen && showNotes}
        aria-controls={compact ? "toc-drawer" : undefined}
        onclick={() => open("notes")}
        ><Highlighter size={15} />{notesLabel}{#if notesHint}<span aria-label={notesHint}>
            •</span
          >{/if}</button
      >
    {/if}
  </div>
{/if}
{#if settingsStore.settings.tocVisible}
  {#if compact}
    {#if drawerOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        role="presentation"
        class="absolute inset-0 z-40 bg-black/30 print:hidden"
        onclick={(event) => {
          if (event.target === event.currentTarget) closeDrawer();
        }}
      >
        <div
          id="toc-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={showNotes ? m.annotations.title : m.sidebar.toc}
          tabindex="-1"
          use:focusTrap={{ onEscape: closeDrawer }}
          class="absolute inset-y-0 right-0 flex max-w-[85%] flex-col border-l bg-background shadow-xl"
          style="width: 360px"
        >
          {@render body()}
        </div>
      </div>
    {/if}
  {:else}
    <div class="contents print:hidden">
      <ResizeHandle
        label={m.accessibility.resizeToc}
        edge="left"
        size={width}
        min={MIN_PANEL_WIDTH}
        max={MAX_PANEL_WIDTH}
        defaultSize={DEFAULT_TOC_WIDTH}
        onchange={(next) => (width = next)}
        oncommit={(next) => {
          settingsStore.setTocWidth(next);
          void saveSettings();
        }}
      />
      <aside class="flex shrink-0 flex-col border-l bg-muted/20" style="width: {width}px">
        {@render body()}
      </aside>
    </div>
  {/if}
{/if}

<style>
  .panel-tab,
  .launcher {
    border-radius: 0.375rem;
    padding: 0.3rem 0.45rem;
    font-size: 0.75rem;
  }
  .panel-tab {
    color: hsl(var(--muted-foreground));
  }
  .panel-tab[aria-pressed="true"] {
    background: hsl(var(--muted));
    color: hsl(var(--foreground));
    font-weight: 600;
  }
  .launcher {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border-radius: 1rem;
  }
  .launcher:hover,
  .panel-tab:hover {
    background: hsl(var(--muted));
  }
  button:focus-visible {
    outline: 2px solid hsl(var(--ring));
  }
</style>
