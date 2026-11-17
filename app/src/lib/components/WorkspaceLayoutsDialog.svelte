<script lang="ts">
  import { onMount } from "svelte";
  import { X } from "@lucide/svelte";
  import { focusTrap } from "$lib/actions/focus-trap";
  import { applyLayout, captureLayout } from "$lib/actions/layout-actions";
  import {
    loadLayouts,
    persistLayouts,
    MAX_LAYOUTS,
    MAX_LAYOUT_NAME,
    type WorkspaceLayout,
  } from "$lib/workspace-layouts";
  import { i18n } from "$lib/i18n/index.svelte";

  let { onclose }: { onclose: () => void } = $props();
  let layouts = $state<WorkspaceLayout[]>([]);
  let name = $state("");
  let loaded = $state(false);
  let busy = $state(false);
  let message = $state("");
  let failed = $state(false);
  let pending = $state<{ action: "apply" | "remove" | "rename"; id: string } | null>(null);
  let renamed = $state("");
  const m = $derived(i18n.m.layouts);

  onMount(() => {
    void loadLayouts()
      .then((value) => {
        layouts = value.layouts;
        loaded = true;
      })
      .catch(() => {
        failed = true;
        message = m.loadError;
      });
  });
  function close() {
    if (!busy) onclose();
  }
  async function perform(action: () => Promise<void>) {
    if (busy || !loaded) return;
    busy = true;
    failed = false;
    message = "";
    try {
      await action();
      pending = null;
    } catch (error) {
      console.warn("Layout operation failed", error);
      failed = true;
      message = m.error;
    } finally {
      busy = false;
    }
  }
  async function save() {
    await perform(async () => {
      const value = await persistLayouts([...layouts, captureLayout(name)]);
      layouts = value.layouts;
      name = "";
      message = m.saved;
    });
  }
  async function confirm() {
    const selected = pending;
    if (!selected) return;
    await perform(async () => {
      const layout = layouts.find((item) => item.id === selected.id);
      if (!layout) return;
      if (selected.action === "apply") {
        const result = await applyLayout(layout);
        message = m.result(result.restored, result.skipped);
      } else {
        const next =
          selected.action === "remove"
            ? layouts.filter((item) => item.id !== selected.id)
            : layouts.map((item) => (item.id === selected.id ? { ...item, name: renamed } : item));
        layouts = (await persistLayouts(next)).layouts;
        message = selected.action === "remove" ? m.deleted : m.changed;
      }
    });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  role="presentation"
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 print:hidden"
  onclick={(event) => {
    if (event.target === event.currentTarget) close();
  }}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="layouts-title"
    aria-busy={busy}
    tabindex="-1"
    use:focusTrap={{
      onEscape: () => {
        if (!busy && pending) pending = null;
        else close();
      },
    }}
    class="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
  >
    <div class="flex items-center justify-between border-b px-5 py-3">
      <h2 id="layouts-title" class="text-sm font-semibold">{m.title}</h2>
      <button
        type="button"
        aria-label={m.close}
        disabled={busy}
        onclick={close}
        class="rounded p-1 hover:bg-muted disabled:opacity-50"><X size={18} /></button
      >
    </div>
    <div class="space-y-4 overflow-y-auto p-5">
      <p class="text-xs text-muted-foreground">{m.hint}</p>
      <form
        class="flex flex-wrap items-end gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label class="min-w-0 flex-1 text-sm"
          >{m.name}
          <input
            bind:value={name}
            maxlength={MAX_LAYOUT_NAME}
            disabled={!loaded || busy || !!pending}
            class="mt-1 w-full rounded border bg-background px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={!loaded || busy || !!pending || !name.trim() || layouts.length >= MAX_LAYOUTS}
          class="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >{m.save}</button
        >
      </form>
      {#if loaded && !layouts.length}<p class="py-5 text-center text-sm text-muted-foreground">
          {m.empty}
        </p>{/if}
      <ul class="space-y-2">
        {#each layouts as layout (layout.id)}
          <li class="flex flex-wrap items-center gap-2 rounded border p-3">
            <div class="min-w-0 flex-1">
              <p class="break-words text-sm font-medium">{layout.name}</p>
              <p class="text-xs text-muted-foreground">
                {m.tabCount(
                  layout.session.workspace!.panes.reduce((sum, pane) => sum + pane.tabs.length, 0)
                )}
              </p>
            </div>
            {#each ["apply", "rename", "remove"] as action}
              <button
                type="button"
                disabled={busy || !!pending}
                class="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                onclick={() => {
                  pending = { action: action as "apply" | "rename" | "remove", id: layout.id };
                  renamed = layout.name;
                  message = "";
                }}
              >
                {m[action as "apply" | "rename" | "remove"]}
              </button>
            {/each}
          </li>
        {/each}
      </ul>
      {#if pending}
        <form
          class="space-y-3 rounded border bg-muted/30 p-4"
          onsubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <p class="break-words text-sm font-medium">
            {layouts.find((item) => item.id === pending!.id)?.name}
          </p>
          {#if pending.action === "rename"}
            <label class="block text-sm"
              >{m.name}<input
                bind:value={renamed}
                maxlength={MAX_LAYOUT_NAME}
                disabled={busy}
                class="mt-1 w-full rounded border bg-background px-3 py-2"
              /></label
            >
          {:else}<p class="text-sm">
              {pending.action === "apply" ? m.replace : m.deleteConfirm}
            </p>{/if}
          <div class="flex gap-2">
            <button
              type="submit"
              disabled={busy || (pending.action === "rename" && !renamed.trim())}
              class="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              >{busy ? m.busy : m[pending.action]}</button
            >
            <button
              type="button"
              disabled={busy}
              onclick={() => (pending = null)}
              class="rounded border px-3 py-2 text-sm disabled:opacity-50">{m.cancel}</button
            >
          </div>
        </form>
      {/if}
      <p
        role={failed ? "alert" : "status"}
        aria-live="polite"
        class="text-sm"
        class:text-destructive={failed}
      >
        {message}
      </p>
    </div>
  </div>
</div>
