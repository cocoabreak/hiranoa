<script lang="ts">
  import { tick } from "svelte";
  import { i18n } from "$lib/i18n/index.svelte";
  import type { Color } from "$lib/annotations";
  import AnnotationColors from "./AnnotationColors.svelte";
  let {
    range,
    root,
    quote,
    composing,
    visible,
    busy,
    oncompose,
    onsave,
    ondismiss,
  }: {
    range: Range;
    root: HTMLElement;
    quote: string;
    composing: boolean;
    visible: boolean;
    busy: boolean;
    oncompose: () => void;
    onsave: (color: Color, memo: string) => void;
    ondismiss: () => void;
  } = $props();
  const m = $derived(i18n.m.annotations);
  let box = $state<HTMLElement>(),
    input = $state<HTMLTextAreaElement>();
  let memo = $state(""),
    color = $state<Color>("yellow");
  $effect(() => {
    const el = box,
      selection = range,
      viewer = root,
      keepVisible = composing;
    if (!el) return;
    function position() {
      if (!el) return;
      const bounds = viewer.getBoundingClientRect(),
        rect = selection.getBoundingClientRect(),
        gap = 6;
      el.style.maxWidth = Math.max(0, bounds.width - 2 * gap) + "px";
      const { width, height } = el.getBoundingClientRect();
      el.style.visibility =
        !keepVisible && (rect.bottom < bounds.top || rect.top > bounds.bottom || !rect.height)
          ? "hidden"
          : "visible";
      el.style.left =
        Math.max(bounds.left + gap, Math.min(rect.left, bounds.right - width - gap)) + "px";
      const above = rect.top - height - gap;
      el.style.top =
        Math.max(
          bounds.top,
          above >= bounds.top ? above : Math.min(rect.bottom + gap, bounds.bottom - height)
        ) + "px";
    }
    position();
    const observer = new ResizeObserver(position);
    observer.observe(el);
    observer.observe(viewer);
    window.addEventListener("resize", position);
    viewer.addEventListener("scroll", position, { passive: true });
    function escape(e: KeyboardEvent) {
      if (
        e.key === "Escape" &&
        !e.isComposing &&
        !e.defaultPrevented &&
        (viewer.contains(document.activeElement) ||
          el?.contains(document.activeElement) ||
          document.activeElement === document.body) &&
        !document.activeElement?.closest('[aria-modal="true"]')
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (el?.contains(document.activeElement)) viewer.focus({ preventScroll: true });
        ondismiss();
      }
    }
    window.addEventListener("keydown", escape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      viewer.removeEventListener("scroll", position);
      window.removeEventListener("keydown", escape, true);
    };
  });
  async function startMemo() {
    oncompose();
    await tick();
    input?.focus({ preventScroll: true });
  }
</script>

{#if visible}
  <div
    bind:this={box}
    role="group"
    aria-label={m.add}
    data-annotation-toolbar
    class="fixed z-30 flex flex-wrap items-center gap-1 rounded-lg border bg-background p-1.5 text-xs text-foreground shadow-lg print:hidden"
    style:width={composing ? "17rem" : undefined}
  >
    <AnnotationColors
      selected={composing ? color : undefined}
      disabled={busy}
      onpick={(c) => {
        if (composing) color = c;
        else onsave(c, "");
      }}
    />
    {#if composing}
      <q class="w-full truncate px-1 text-muted-foreground">{quote}</q>
      <textarea
        aria-label={m.memo}
        bind:this={input}
        bind:value={memo}
        maxlength="4096"
        rows="2"
        class="w-full resize-none rounded border bg-background p-1.5"></textarea>
      <button data-save disabled={busy} onclick={() => onsave(color, memo)}>{m.save}</button>
      <button onclick={ondismiss}>{m.cancel}</button>
    {:else}
      <button
        data-add-memo
        disabled={busy}
        onmousedown={(e) => e.preventDefault()}
        onclick={startMemo}>{m.addMemo}</button
      >
    {/if}
  </div>
{/if}

<style>
  button {
    padding: 0.25rem 0.375rem;
    border-radius: 0.25rem;
  }
  button:hover {
    background: hsl(var(--muted));
  }
  button:focus-visible {
    outline: 2px solid hsl(var(--ring));
  }
</style>
