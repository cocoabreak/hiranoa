<script lang="ts">
  import { i18n } from "$lib/i18n/index.svelte";

  let { details }: { details: string } = $props();
  const m = $derived(i18n.m);
  let copyState = $state<"idle" | "copying" | "copied" | "failed">("idle");

  async function copyDetails(): Promise<void> {
    copyState = "copying";
    try {
      await navigator.clipboard.writeText(details);
      copyState = "copied";
    } catch {
      copyState = "failed";
    }
  }
</script>

<div class="mt-3 border-t pt-2">
  <details>
    <summary class="cursor-pointer font-medium">{m.update.errorDetails}</summary>
    <pre
      class="mt-2 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs leading-relaxed">{details}</pre>
  </details>
  <div class="mt-2 flex flex-wrap items-center gap-2">
    <button
      type="button"
      class="rounded border px-2 py-1 font-medium hover:bg-muted disabled:opacity-50"
      disabled={copyState === "copying"}
      onclick={copyDetails}
    >
      {m.update.copyErrorDetails}
    </button>
    <span role="status" class="text-muted-foreground">
      {#if copyState === "copied"}
        {m.update.errorDetailsCopied}
      {:else if copyState === "failed"}
        {m.update.errorDetailsCopyFailed}
      {/if}
    </span>
  </div>
</div>
