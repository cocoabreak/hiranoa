<script lang="ts">
  import { colors, type Color } from "$lib/annotations";
  import { i18n } from "$lib/i18n/index.svelte";
  let {
    selected,
    disabled = false,
    onpick,
  }: { selected?: Color; disabled?: boolean; onpick: (color: Color) => void } = $props();
  const m = $derived(i18n.m.annotations);
</script>

<div role="group" aria-label={m.color} class="flex flex-wrap gap-1">
  {#each colors as color}
    <button
      type="button"
      data-pick={color}
      {disabled}
      aria-pressed={selected === undefined ? undefined : selected === color}
      class="inline-flex min-h-7 items-center gap-0.5 rounded border px-1 py-1 text-xs text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-foreground"
      onmousedown={(e) => e.preventDefault()}
      onclick={() => onpick(color)}
    >
      <span aria-hidden="true" class="swatch" data-color={color}
        >{selected === color ? "✓" : ""}</span
      >{m[color]}
    </button>
  {/each}
</div>

<style>
  .swatch {
    display: inline-grid;
    place-items: center;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    color: #1c1917;
    box-shadow: inset 0 0 0 1px #0003;
    font-weight: bold;
  }
  [data-color="yellow"] {
    background: #fde68a;
  }
  [data-color="blue"] {
    background: #bae6fd;
  }
  [data-color="pink"] {
    background: #fbcfe8;
  }
</style>
