<script lang="ts">
  import { moveOtherPaneLabel } from "$lib/pane-labels";

  import { onMount } from "svelte";
  import { workspaceStore } from "$lib/stores/workspace.svelte";
  import { tabStore } from "$lib/stores/tab.svelte";
  import { splitView, unsplitView, moveTabToOther } from "$lib/actions/workspace-actions";
  import { i18n } from "$lib/i18n/index.svelte";
  import TabBar from "./TabBar.svelte";
  import MarkdownViewer from "./MarkdownViewer.svelte";

  let element: HTMLElement;
  let width = $state(0);
  const split = $derived(workspaceStore.paneIds.length === 2);
  const narrow = $derived(split && width > 0 && width < 566);
  const m = $derived(i18n.m.split);
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
    });
    observer.observe(element);
    return () => observer.disconnect();
  });
  function resize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const move = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      workspaceStore.setRatio((event.clientX - rect.left) / rect.width);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("lostpointercapture", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", end);
  }
</script>

<div bind:this={element} class="print-expand flex min-w-0 flex-1 flex-col">
  {#if narrow}
    <div class="flex gap-1 border-b px-2 py-1 print:hidden" role="group" aria-label={m.focus}>
      {#each workspaceStore.paneIds as id, index}
        <button
          class="rounded px-3 py-1 text-xs hover:bg-muted"
          class:bg-accent={id === workspaceStore.activePaneId}
          aria-pressed={id === workspaceStore.activePaneId}
          onclick={() => workspaceStore.activate(id)}>{index === 0 ? m.left : m.right}</button
        >
      {/each}
    </div>
  {/if}
  <div class="print-expand flex min-h-0 flex-1">
    {#each workspaceStore.paneIds as paneId, index (paneId)}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <section
        data-pane-id={paneId}
        aria-label={index === 0 ? m.left : m.right}
        class="print-expand viewer-pane flex min-w-0 flex-col"
        class:pane-active={split && paneId === workspaceStore.activePaneId}
        style:min-width={split && !narrow ? "280px" : undefined}
        class:pane-hidden={narrow && paneId !== workspaceStore.activePaneId}
        style:flex={split && !narrow
          ? `${index === 0 ? workspaceStore.splitRatio : 1 - workspaceStore.splitRatio} 1 0%`
          : "1 1 0%"}
        onpointerdown={() => workspaceStore.activate(paneId)}
        onfocusin={() => workspaceStore.activate(paneId)}
      >
        <div class="flex min-w-0 border-b print:hidden">
          <div class="min-w-0 flex-1"><TabBar {paneId} /></div>
          <div class="flex shrink-0 items-center gap-0.5 px-1">
            {#if split}
              <button
                title={moveOtherPaneLabel(paneId)}
                aria-label={moveOtherPaneLabel(paneId)}
                class="rounded px-1.5 py-1 text-xs hover:bg-muted"
                disabled={!tabStore.forPane(paneId).activeTabId}
                onclick={() => moveTabToOther(paneId, tabStore.forPane(paneId).activeTabId!)}
                >↔</button
              >
              <button
                title={m.unsplit}
                aria-label={m.unsplit}
                class="rounded px-1.5 py-1 text-xs hover:bg-muted"
                onclick={unsplitView}>×</button
              >
            {:else}
              <button
                title={`${m.split} (Ctrl+\\)`}
                aria-label={m.split}
                class="rounded px-2 py-1 text-base hover:bg-muted"
                disabled={!tabStore.activeTabId}
                onclick={splitView}>◫</button
              >
            {/if}
          </div>
        </div>
        <MarkdownViewer {paneId} />
      </section>
      {#if split && index === 0 && !narrow}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div
          role="separator"
          tabindex="0"
          aria-label={m.resize}
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(workspaceStore.splitRatio * 100)}
          class="w-1.5 shrink-0 cursor-col-resize touch-none bg-border hover:bg-primary/50 focus:bg-primary/50 print:hidden"
          onpointerdown={resize}
          ondblclick={() => workspaceStore.setRatio(0.5)}
          onkeydown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              workspaceStore.setRatio(
                workspaceStore.splitRatio + (event.key === "ArrowLeft" ? -0.02 : 0.02)
              );
            }
          }}
        ></div>
      {/if}
    {/each}
  </div>
</div>

<style>
  .viewer-pane {
    position: relative;
  }
  .pane-active::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: hsl(var(--primary));
    z-index: 20;
    pointer-events: none;
  }
  .pane-hidden {
    display: none;
  }
  @media print {
    .pane-active::before {
      display: none;
    }
    :global(body.printing-pane) .viewer-pane:not(:global(.print-target)) {
      display: none !important;
    }
    .viewer-pane:global(.print-target) {
      display: flex !important;
      flex: 1 !important;
    }
  }
</style>
