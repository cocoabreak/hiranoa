<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { onDestroy } from "svelte";
  import { i18n } from "$lib/i18n/index.svelte";
  import type { DocumentRef, DocumentSourceInfo } from "$lib/types";
  import {
    digest,
    documentLocation,
    indexText,
    locate,
    matchBudget,
    maxFileBytes,
    parseExport,
    serializeExport,
    type Anchor,
    type Annotation,
    type Color,
  } from "$lib/annotations";
  import {
    annotationLibrary,
    attachBook,
    changeBook,
    otherBooks,
    readBook,
    rememberRevision,
    type OpenBook,
  } from "$lib/annotation-library.svelte";
  import { annotationViews } from "$lib/stores/annotation-views";
  import { workspaceStore } from "$lib/stores/workspace.svelte";
  import AnnotationColors from "./AnnotationColors.svelte";
  import AnnotationToolbar from "./AnnotationToolbar.svelte";
  let {
    paneId,
    root,
    documentRef,
    source,
    title,
    raw,
    rendered,
  }: {
    paneId: string;
    root: HTMLElement;
    documentRef: DocumentRef;
    source: DocumentSourceInfo;
    title: string;
    raw: string;
    rendered: boolean;
  } = $props();
  const m = $derived(i18n.m.annotations);
  let showAll = $state(false),
    failed = $state<"reader" | "list" | null>(null),
    busy = $state(false);
  let current = $state.raw<OpenBook>();
  let notes = $state.raw<Annotation[]>([]);
  let candidates = $state.raw<Awaited<ReturnType<typeof otherBooks>>>([]);
  let lookup = $state<"idle" | "ready" | "failed">("idle");
  let readFailed = $state(false);
  type SelectionTarget = { anchor: Anchor; range: Range };
  let selected = $state.raw<SelectionTarget | null>(null);
  let draft = $state.raw<SelectionTarget | null>(null);
  const target = $derived(draft ?? selected);
  const activePane = $derived(workspaceStore.activePaneId === paneId);
  $effect(() => {
    if (!rendered) draft = null;
    if (!activePane || !rendered) {
      selected = null;
    }
  });
  let editing = $state<string | null>(null),
    memo = $state(""),
    color = $state<Color>("yellow");
  let ranges = $state.raw(new Map<string, Range>());
  let fileInput: HTMLInputElement = $state()!;
  let mounted = true;
  onDestroy(() => {
    mounted = false;
  });
  $effect(() => {
    const params = { source, documentRef, title, raw };
    let active = true;
    current = undefined;
    failed = null;
    draft = null;
    selected = null;
    Promise.all([documentLocation(params.source, params.documentRef), digest(params.raw)])
      .then(async ([location, revision]) => {
        if (!active) return;
        const book = { location, revision, title: params.title };
        await rememberRevision(book, () => active);
        if (active) current = book;
      })
      .catch(() => {
        if (active) failed = "reader";
      });
    return () => {
      active = false;
    };
  });
  $effect(() => {
    const book = current,
      all = showAll;
    void annotationLibrary.version;
    let active = true;
    candidates = [];
    lookup = "idle";
    readFailed = false;
    if (!book) {
      notes = [];
      return;
    }
    (async () => {
      const saved = await readBook(book.location);
      if (!active) return;
      notes = saved?.annotations ?? [];
      if (saved) return;
      try {
        const others = await otherBooks(book, all);
        if (active) {
          candidates = others;
          lookup = "ready";
        }
      } catch {
        if (active) lookup = "failed";
      }
    })().catch(() => {
      if (active) readFailed = true;
    });
    return () => {
      active = false;
    };
  });

  $effect(() => {
    const book = current,
      entries = notes,
      el = root;
    selected = null;
    if (!book || !rendered) {
      ranges = new Map();
      return;
    }
    let index: ReturnType<typeof indexText> | undefined;
    let previous: { name: string; range: Range }[] = [];
    function clearPaint() {
      for (const { name, range } of previous) {
        const group = globalThis.CSS?.highlights?.get(name);
        group?.delete(range);
        if (group?.size === 0) CSS.highlights.delete(name);
      }
      previous = [];
    }
    function paint() {
      clearPaint();
      index = entries.length ? indexText(el) : undefined;
      const found = new Map<string, Range>();
      const budget = matchBudget();
      for (const n of entries) {
        if (!index) break;
        const start = locate(index, n, book!.revision, budget);
        const range = start === null ? null : index.range(start, n.quote.length);
        if (!range) continue;
        found.set(n.id, range);
        if (!globalThis.CSS?.highlights) continue;
        const name = "hiranoa-note-" + n.color;
        const group = CSS.highlights.get(name) ?? new Highlight();
        group.add(range);
        CSS.highlights.set(name, group);
        previous.push({ name, range });
      }
      ranges = found;
    }
    function capture() {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) {
        if (el.contains(document.activeElement) || document.activeElement === document.body)
          selected = null;
        return;
      }
      const range = selection.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) {
        selected = null;
        return;
      }
      index ??= indexText(el);
      const anchor = index.capture(range, book!.revision);
      selected = anchor ? { anchor, range: range.cloneRange() } : null;
    }
    paint();
    capture();
    const observer = new MutationObserver(() => {
      paint();
      capture();
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    document.addEventListener("selectionchange", capture);
    return () => {
      observer.disconnect();
      document.removeEventListener("selectionchange", capture);
      clearPaint();
    };
  });

  async function perform(action: () => Promise<unknown>, surface: "list" | "reader" = "list") {
    if (busy) return;
    busy = true;
    failed = null;
    try {
      await action();
    } catch {
      failed = surface;
    } finally {
      busy = false;
    }
  }
  function dismiss() {
    selected = null;
    draft = null;
    const selection = window.getSelection();
    if (selection?.anchorNode && root.contains(selection.anchorNode)) selection.removeAllRanges();
  }
  function add(color: Color, memo: string) {
    const anchor = target?.anchor,
      book = current;
    if (!anchor || !book || anchor.revision !== book.revision) return;
    void perform(async () => {
      await changeBook(book, (list) => [
        ...list,
        { ...anchor, id: crypto.randomUUID(), color, memo, created: new Date().toISOString() },
      ]);
      if (mounted && current === book && activePane && root.isConnected) {
        dismiss();
        root.focus({ preventScroll: true });
      } else if (mounted && current === book) draft = null;
    }, "reader");
  }
  function update(id: string, patch: Partial<Annotation>) {
    const book = current;
    if (book)
      void perform(async () => {
        await changeBook(book, (list) => list.map((n) => (n.id === id ? { ...n, ...patch } : n)));
        editing = null;
      });
  }
  function remove(id: string) {
    const book = current;
    if (book)
      void perform(async () => {
        if (await ask(m.deleteConfirm))
          await changeBook(book, (list) => list.filter((n) => n.id !== id));
      });
  }
  function transfer(sourceBook: (typeof candidates)[number], move: boolean) {
    const book = current;
    if (book)
      void perform(async () => {
        if (!move || (await ask(m.moveConfirm))) await attachBook(book, sourceBook, move);
      });
  }
  function importFile(file?: File) {
    const book = current;
    if (!file || !book) return;
    void perform(async () => {
      if (file.size > maxFileBytes) throw Error("file size");
      const items = parseExport(await file.text());
      await changeBook(book, (list) => {
        const ids = new Set(list.map((n) => n.id));
        return [
          ...list,
          ...items.filter((n) => {
            if (ids.has(n.id)) return false;
            ids.add(n.id);
            return true;
          }),
        ];
      });
    });
  }
  function exportFile() {
    void perform(async () => {
      const contents = serializeExport(notes);
      await invoke("save_text_export", {
        format: "annotations",
        suggestedName: title + ".hiranoa.json",
        contents,
      });
    });
  }
  function jump(id: string) {
    const node = ranges.get(id)?.startContainer;
    node?.parentElement?.scrollIntoView({ block: "center" });
  }
  const orderedNotes = $derived.by(() =>
    [...notes].sort((a, b) => {
      const left = ranges.get(a.id),
        right = ranges.get(b.id);
      if (left && right) return left.compareBoundaryPoints(Range.START_TO_START, right);
      if (left) return -1;
      if (right) return 1;
      return a.start - b.start;
    })
  );
  $effect(() => {
    annotationViews.set(paneId, {
      list,
      get count() {
        return notes.length;
      },
      get hasMatch() {
        return !showAll && !notes.length && candidates.length > 0;
      },
    });
    return () => {
      annotationViews.delete(paneId);
    };
  });
</script>

{#if target && rendered && (activePane || draft)}
  <AnnotationToolbar
    {root}
    visible={activePane}
    range={target.range}
    quote={target.anchor.quote}
    composing={!!draft}
    {busy}
    oncompose={() => (draft = selected)}
    onsave={add}
    ondismiss={dismiss}
  />
{/if}
{#if (failed === "reader" || readFailed) && activePane && !fileInput}
  <p
    role="alert"
    class="absolute bottom-2 left-2 z-30 rounded border bg-background px-3 py-2 text-sm text-destructive print:hidden"
  >
    {m.error}
  </p>
{/if}

{#snippet list(onNavigate: () => void)}
  <section
    class="annotations min-h-0 flex-1 overflow-y-auto px-3 py-2 text-xs"
    aria-label={m.title}
  >
    {#if failed || readFailed}<p role="alert" class="rounded border px-2 py-1 text-destructive">
        {m.error}
      </p>{/if}
    {#if !notes.length && current && !readFailed}<p>{m.empty} {rendered ? m.select : ""}</p>{/if}
    {#each orderedNotes as n (n.id)}
      <article class="mb-3 border-s-[3px] px-2 py-1" data-color={n.color}>
        {#if ranges.has(n.id)}
          <button
            class="block w-full text-start text-sm font-medium"
            title={m.jump}
            onclick={() => {
              jump(n.id);
              onNavigate();
            }}><q class="whitespace-pre-wrap break-words">{n.quote}</q></button
          >
        {:else}<q class="whitespace-pre-wrap break-words">{n.quote}</q>{/if}
        {#if editing === n.id}
          <label
            >{m.memo}<textarea
              maxlength="4096"
              class="block w-full rounded border bg-background p-1"
              bind:value={memo}></textarea></label
          >
          <AnnotationColors selected={color} disabled={busy} onpick={(c) => (color = c)} />
          <button data-save disabled={busy} onclick={() => update(n.id, { memo, color })}
            >{m.save}</button
          >
          <button onclick={() => (editing = null)}>{m.cancel}</button>
        {:else}
          {#if n.memo}<p class="my-1 whitespace-pre-wrap break-words">{n.memo}</p>{/if}
          {#if !ranges.has(n.id)}<strong>{m.unresolved}</strong>{/if}
          {#if selected && rendered}<button
              data-reattach
              disabled={busy}
              onmousedown={(e) => e.preventDefault()}
              onclick={() => selected && update(n.id, selected.anchor)}>{m.reanchor}</button
            >{/if}
          <button
            data-edit
            onclick={() => {
              editing = n.id;
              memo = n.memo;
              color = n.color;
            }}>{m.edit}</button
          >
          <button disabled={busy} onclick={() => remove(n.id)}>{m.remove}</button>
        {/if}
      </article>
    {/each}
    <div class="flex flex-wrap gap-2">
      <button disabled={!current || busy} onclick={() => fileInput.click()}>{m.importFile}</button>
      <input
        type="file"
        hidden
        accept=".json"
        bind:this={fileInput}
        onchange={() => {
          importFile(fileInput.files?.[0]);
          fileInput.value = "";
        }}
      />
      {#if notes.length}<button disabled={busy} onclick={exportFile}>{m.exportFile}</button>
      {:else}<button
          disabled={!current || busy}
          onclick={() => (showAll = !showAll)}
          aria-expanded={showAll}>{m.other}</button
        >{/if}
    </div>
    {#if !notes.length && candidates.length}
      {#if !showAll}<p data-match>{m.same}</p>{/if}
      {#each candidates as candidate (candidate.id)}
        <div>
          {candidate.title} ({candidate.count})
          <button disabled={busy} onclick={() => transfer(candidate, true)}>{m.move}</button>
          <button disabled={busy} onclick={() => transfer(candidate, false)}>{m.copy}</button>
        </div>
      {/each}
    {:else if lookup === "failed"}<p role="alert" class="rounded border px-2 py-1 text-destructive">
        {m.lookupError}
      </p>
    {:else if showAll && lookup === "ready"}<p>{m.noOther}</p>{/if}
  </section>
{/snippet}

<style>
  .annotations button {
    padding: 0.2rem 0.4rem;
    border-radius: 0.25rem;
  }
  .annotations button:hover {
    background: hsl(var(--muted));
  }
  article[data-color="yellow"] {
    border-color: #eab308;
  }
  article[data-color="blue"] {
    border-color: #38bdf8;
  }
  article[data-color="pink"] {
    border-color: #f472b6;
  }
  :global(::highlight(hiranoa-note-yellow)) {
    background-color: #fde68a;
    color: #1c1917;
  }
  :global(::highlight(hiranoa-note-blue)) {
    background-color: #bae6fd;
    color: #1c1917;
  }
  :global(::highlight(hiranoa-note-pink)) {
    background-color: #fbcfe8;
    color: #1c1917;
  }
</style>
