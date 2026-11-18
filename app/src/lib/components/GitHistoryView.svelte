<script lang="ts">
  import "$lib/markdown/body.css";
  import { onMount, onDestroy, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { focusTrap } from "$lib/actions/focus-trap";
  import { i18n } from "$lib/i18n/index.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import type { DocumentRef } from "$lib/types";
  import type { HistoryInfo, HistorySnapshot } from "$lib/history/types";
  import {
    markdownBlocks,
    compareSequences,
    mapScroll,
    changedRange,
    markTextRange,
    type DiffPair,
  } from "$lib/history/compare";
  import { createHistoryRenderer } from "$lib/history/render";
  import { historyMessages } from "$lib/history/messages";

  let {
    document: target,
    title,
    onclose,
  }: { document: DocumentRef; title: string; onclose: () => void } = $props();
  const m = $derived(historyMessages[i18n.locale]);
  let info = $state<HistoryInfo | null>(null);
  let leftRevision = $state("");
  let rightRevision = $state("working");
  let leftSnapshot = $state<HistorySnapshot | null>(null);
  let rightSnapshot = $state<HistorySnapshot | null>(null);
  let mode = $state<"visual" | "source">("visual");
  let busy = $state(true);
  let error = $state("");
  let pairs = $state<DiffPair[]>([]);
  let sourcePairs = $state<DiffPair[]>([]);
  let leftLines = $state<string[]>([]),
    rightLines = $state<string[]>([]);
  let selected = $state(0);
  let synchronized = $state(true),
    showFlow = $state(true);
  let band = $state("");
  let bandHeight = $state(0);
  let leftPane: HTMLDivElement,
    rightPane: HTMLDivElement,
    leftRoot: HTMLElement,
    rightRoot: HTMLElement,
    columns: HTMLDivElement;
  let sourceScroller = $state<HTMLDivElement>();
  let leftElements = new Map<number, HTMLElement>(),
    rightElements = new Map<number, HTMLElement>();
  const leftRenderer = createHistoryRenderer(),
    rightRenderer = createHistoryRenderer();
  const changes = $derived(pairs.flatMap((pair, index) => (pair.kind !== "equal" ? [index] : [])));
  const sourceChanges = $derived(
    sourcePairs.flatMap((pair, index) => (pair.kind !== "equal" ? [index] : []))
  );
  const navigation = $derived(mode === "source" ? sourceChanges : changes);
  let generation = 0,
    disposed = false,
    frame = 0;
  let resize: ResizeObserver | undefined;
  const programmatic: { left: number | null; right: number | null } = { left: null, right: null };

  function close() {
    onclose();
  }
  onMount(() => {
    void (async () => {
      try {
        const value = await invoke<HistoryInfo | null>("open_git_history", { document: target });
        if (disposed) {
          if (value) await invoke("close_git_history", { sessionId: value.sessionId });
          return;
        }
        if (!value) {
          close();
          return;
        }
        info = value;
        if (!value.commits.length) {
          busy = false;
          return;
        }
        leftRevision = value.commits[0].id;
        await compare();
      } catch (cause) {
        if (!disposed) {
          error = String(cause);
          busy = false;
        }
      }
    })();
    resize = new ResizeObserver(queueBand);
    resize.observe(columns);
    resize.observe(leftRoot);
    resize.observe(rightRoot);
  });
  onDestroy(() => {
    disposed = true;
    generation++;
    leftRenderer.clear();
    rightRenderer.clear();
    resize?.disconnect();
    cancelAnimationFrame(frame);
    if (info) void invoke("close_git_history", { sessionId: info.sessionId }).catch(() => {});
  });

  async function compare() {
    if (!info || !leftRevision) return;
    const current = ++generation;
    busy = true;
    error = "";
    band = "";
    leftRenderer.clear();
    rightRenderer.clear();
    leftRoot.replaceChildren();
    rightRoot.replaceChildren();
    leftElements.clear();
    rightElements.clear();
    pairs = [];
    sourcePairs = [];
    leftSnapshot = null;
    rightSnapshot = null;
    selected = 0;
    const sessionId = info.sessionId;
    try {
      const snapshots = await Promise.all(
        [leftRevision, rightRevision].map((revision) =>
          invoke<HistorySnapshot>("read_git_snapshot", { sessionId, revision })
        )
      );
      if (current !== generation || disposed) return;
      [leftSnapshot, rightSnapshot] = snapshots;
      const [leftBlocks, rightBlocks] = await Promise.all(
        snapshots.map((snapshot) => markdownBlocks(snapshot.raw, settingsStore.settings.renderers))
      );
      if (current !== generation || disposed) return;
      const correspondence = compareSequences(
        leftBlocks.map((b) => b.raw),
        rightBlocks.map((b) => b.raw)
      );
      const settings = settingsStore.settings;
      const options = {
        renderers: { ...settings.renderers },
        codeTheme: settings.codeTheme,
        showLineNumbers: settings.showLineNumbers,
      };
      const maps = await Promise.all([
        leftRenderer.render(
          leftRoot,
          snapshots[0].raw,
          leftBlocks,
          sessionId,
          leftRevision,
          options,
          i18n.locale
        ),
        rightRenderer.render(
          rightRoot,
          snapshots[1].raw,
          rightBlocks,
          sessionId,
          rightRevision,
          options,
          i18n.locale
        ),
      ]);
      if (current !== generation || disposed) return;
      [leftElements, rightElements] = maps;
      pairs = correspondence;
      correspondence.forEach((pair, index) => {
        const old = pair.left === null ? undefined : leftElements.get(pair.left);
        const next = pair.right === null ? undefined : rightElements.get(pair.right);
        for (const element of [old, next])
          if (element && pair.kind !== "equal") {
            element.classList.add("history-block", `history-${pair.kind}`);
            element.dataset.changeIndex = String(index);
            element.setAttribute("aria-label", m[pair.kind]);
          }
        if (
          pair.kind === "changed" &&
          old &&
          next &&
          !old.querySelector("pre,code,svg,math,.katex,.mermaid-pending") &&
          !next.querySelector("pre,code,svg,math,.katex,.mermaid-pending")
        ) {
          const a = old.textContent ?? "",
            b = next.textContent ?? "";
          if (a.length + b.length < 20_000) {
            const range = changedRange(a, b);
            markTextRange(old, range.left);
            markTextRange(next, range.right);
          }
        }
        if (pair.kind !== "equal")
          for (const element of [old, next])
            if (element) {
              const label = window.document.createElement("span");
              label.className = "history-change-label";
              label.textContent = `${pair.kind === "added" ? "+" : pair.kind === "deleted" ? "−" : "±"} ${m[pair.kind]}`;
              element.before(label);
            }
      });
      if (mode === "source") buildSource();
      await tick();
      queueBand();
    } catch (cause) {
      if (current === generation && !disposed) error = String(cause);
    } finally {
      if (current === generation && !disposed) busy = false;
    }
  }
  function buildSource() {
    leftLines = (leftSnapshot?.raw ?? "").replace(/\r\n?/g, "\n").split("\n");
    rightLines = (rightSnapshot?.raw ?? "").replace(/\r\n?/g, "\n").split("\n");
    sourcePairs = compareSequences(leftLines, rightLines, 2_000_000);
  }
  function changeMode(next: "visual" | "source") {
    if (busy || !leftSnapshot || !rightSnapshot) return;
    error = "";
    try {
      if (next === "source") buildSource();
      mode = next;
      selected = 0;
      queueBand();
    } catch (cause) {
      error = String(cause);
    }
  }
  function elementFor(pair: DiffPair, side: "left" | "right") {
    const index = pair[side];
    return index === null ? undefined : (side === "left" ? leftElements : rightElements).get(index);
  }
  function top(element: HTMLElement, pane: HTMLElement) {
    return element.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  }
  function jump(delta: number) {
    if (!navigation.length) return;
    selected = (selected + delta + navigation.length) % navigation.length;
    if (mode === "source") {
      sourceScroller
        ?.querySelector<HTMLElement>(`[data-source-row="${sourceChanges[selected]}"]`)
        ?.scrollIntoView({ block: "center" });
      return;
    }
    const pair = pairs[changes[selected]];
    for (const side of ["left", "right"] as const) {
      const pane = side === "left" ? leftPane : rightPane;
      const element = elementFor(pair, side);
      if (!element) continue;
      const target = Math.max(
        0,
        Math.min(pane.scrollHeight - pane.clientHeight, top(element, pane) - 40)
      );
      programmatic[side] = target;
      pane.scrollTop = target;
    }
    queueBand();
  }
  function scroll(side: "left" | "right") {
    queueBand();
    const source = side === "left" ? leftPane : rightPane,
      target = side === "left" ? rightPane : leftPane;
    const other = side === "left" ? "right" : "left";
    if (programmatic[side] !== null && Math.abs(source.scrollTop - programmatic[side]!) < 2) {
      programmatic[side] = null;
      return;
    }
    programmatic[side] = null;
    if (!synchronized || busy) return;
    const anchors: [number, number][] = [[0, 0]];
    for (const pair of pairs) {
      const a = elementFor(pair, side),
        b = elementFor(pair, other);
      if (a && b) anchors.push([top(a, source), top(b, target)]);
    }
    anchors.push([
      Math.max(0, source.scrollHeight - source.clientHeight),
      Math.max(0, target.scrollHeight - target.clientHeight),
    ]);
    anchors.sort((a, b) => a[0] - b[0]);
    const position = mapScroll(
      source.scrollTop,
      anchors,
      Math.max(0, target.scrollHeight - target.clientHeight)
    );
    if (Math.abs(target.scrollTop - position) > 1) {
      programmatic[other] = position;
      target.scrollTop = position;
    }
  }
  function queueBand() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(updateBand);
  }
  function endpoint(pairIndex: number, side: "left" | "right"): [number, number] {
    const pane = side === "left" ? leftPane : rightPane;
    let element = elementFor(pairs[pairIndex], side),
      missing = !element;
    for (let i = pairIndex + 1; !element && i < pairs.length; i++)
      element = elementFor(pairs[i], side);
    if (!element) return [pane.clientHeight, pane.clientHeight];
    const rect = element.getBoundingClientRect(),
      parent = pane.getBoundingClientRect();
    const start = Math.max(0, Math.min(pane.clientHeight, rect.top - parent.top));
    return [
      start,
      missing
        ? Math.min(pane.clientHeight, start + 2)
        : Math.max(start + 2, Math.min(pane.clientHeight, rect.bottom - parent.top)),
    ];
  }
  function updateBand() {
    const selectedIndex = changes[selected];
    for (const element of [...leftElements.values(), ...rightElements.values()])
      element.classList.toggle(
        "history-selected",
        element.dataset.changeIndex === String(selectedIndex)
      );
    if (!columns || !changes.length || !showFlow || mode !== "visual" || busy) {
      band = "";
      return;
    }
    bandHeight = columns.clientHeight;
    const index = changes[selected],
      a = endpoint(index, "left"),
      b = endpoint(index, "right");
    band = `M0 ${a[0]} C24 ${a[0]} 24 ${b[0]} 48 ${b[0]} L48 ${b[1]} C24 ${b[1]} 24 ${a[1]} 0 ${a[1]} Z`;
  }
  function key(event: KeyboardEvent) {
    if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      jump(event.key === "ArrowUp" ? -1 : 1);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="history-view fixed inset-x-0 bottom-0 top-8 z-40 flex flex-col bg-background text-foreground print:hidden"
  role="dialog"
  aria-modal="true"
  aria-busy={busy}
  aria-labelledby="history-title"
  tabindex="-1"
  use:focusTrap={{ onEscape: close }}
  onkeydown={key}
>
  <header class="flex flex-wrap items-center gap-3 border-b px-4 py-2">
    <h2 id="history-title" class="min-w-0 flex-1 truncate text-sm font-semibold">
      {title} · {m.title}
    </h2>
    <button type="button" class="rounded border px-3 py-1 text-sm hover:bg-muted" onclick={close}
      >{m.close}</button
    >
  </header>
  <div class="history-body flex min-h-0 flex-1">
    <aside
      class="history-sidebar w-52 shrink-0 overflow-y-auto border-r p-3"
      aria-label={m.history}
    >
      <p class="mb-3 text-xs text-muted-foreground">{m.scope}</p>
      {#each info?.commits ?? [] as commit}
        <button
          type="button"
          class="mb-2 w-full rounded border p-2 text-left text-xs hover:bg-muted"
          class:bg-accent={leftRevision === commit.id}
          disabled={busy}
          aria-pressed={leftRevision === commit.id}
          onclick={() => {
            leftRevision = commit.id;
            void compare();
          }}
        >
          <span class="block break-words font-medium">{commit.summary}</span>
          <span class="mt-1 block text-muted-foreground"
            >{commit.id.slice(0, 7)} · {commit.author}</span
          >
          <span class="block text-muted-foreground"
            >{new Date(commit.timestamp * 1000).toLocaleString(i18n.locale)}</span
          >
        </button>
      {/each}
      {#if info?.truncated}<p class="text-xs text-muted-foreground">{m.truncated}</p>{/if}
    </aside>
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex flex-wrap items-center gap-2 border-b p-2 text-xs">
        <label class="flex min-w-0 items-center gap-1"
          >{m.old}<select
            class="max-w-52 min-w-0 rounded border bg-background p-1"
            value={leftRevision}
            disabled={busy}
            onchange={(event) => {
              leftRevision = event.currentTarget.value;
              void compare();
            }}
            >{#each info?.commits ?? [] as commit}<option value={commit.id}
                >{commit.id.slice(0, 7)} {commit.summary}</option
              >{/each}</select
          ></label
        >
        <label class="flex min-w-0 items-center gap-1"
          >{m.next}<select
            class="max-w-52 min-w-0 rounded border bg-background p-1"
            value={rightRevision}
            disabled={busy}
            onchange={(event) => {
              rightRevision = event.currentTarget.value;
              void compare();
            }}
            ><option value="working">{m.working}</option
            >{#each info?.commits ?? [] as commit}<option value={commit.id}
                >{commit.id.slice(0, 7)} {commit.summary}</option
              >{/each}</select
          ></label
        >
        <button
          type="button"
          class="rounded border px-2 py-1 hover:bg-muted"
          disabled={busy || !info?.commits.length}
          onclick={() => void compare()}>{m.reload}</button
        >
      </div>
      <div class="flex flex-wrap items-center gap-3 border-b p-2 text-xs">
        <button
          type="button"
          class="rounded border px-2 py-1 hover:bg-muted"
          aria-pressed={mode === "visual"}
          disabled={busy || !leftSnapshot || !rightSnapshot}
          onclick={() => changeMode("visual")}>{m.visual}</button
        >
        <button
          type="button"
          class="rounded border px-2 py-1 hover:bg-muted"
          aria-pressed={mode === "source"}
          disabled={busy || !leftSnapshot || !rightSnapshot}
          onclick={() => changeMode("source")}>{m.source}</button
        >
        <label class="flex items-center gap-1"
          ><input type="checkbox" bind:checked={synchronized} />{m.sync}</label
        >
        <label class="history-flow-toggle flex items-center gap-1"
          ><input type="checkbox" bind:checked={showFlow} onchange={queueBand} />{m.flow}</label
        >
        <button
          type="button"
          class="rounded border px-2 py-1"
          disabled={!navigation.length || busy}
          aria-label={m.previousChange}
          onclick={() => jump(-1)}>↑</button
        >
        <span aria-live="polite"
          >{m.position(navigation.length ? selected + 1 : 0, navigation.length)}</span
        >
        <button
          type="button"
          class="rounded border px-2 py-1"
          disabled={!navigation.length || busy}
          aria-label={m.nextChange}
          onclick={() => jump(1)}>↓</button
        >
      </div>
      {#if busy}<p role="status" class="px-3 py-2 text-sm">{m.loading}</p>{/if}
      {#if error}<p role="alert" class="break-words px-3 py-2 text-sm text-destructive">
          {m.error}
          {error}
        </p>{/if}
      {#if info && !info.commits.length}<p role="status" class="p-4">{m.empty}</p>{/if}
      {#if mode === "visual" && !busy && info?.commits.length && !changes.length && !error}<p
          role="status"
          class="px-3 py-2 text-xs"
        >
          {m.noChanges}
        </p>{/if}
      <div
        bind:this={columns}
        class="history-columns min-h-0 flex-1"
        style:display={mode === "visual" ? "grid" : "none"}
      >
        <div
          class="history-pane min-w-0 overflow-auto"
          bind:this={leftPane}
          onscroll={() => scroll("left")}
        >
          <div
            class="history-version sticky top-0 z-10 border-b bg-background/95 px-3 py-2 text-xs"
          >
            {m.old} · {leftRevision.slice(0, 7)} · {#if leftSnapshot && !leftSnapshot.present}{m.unavailable}{/if}
          </div>
          <article
            bind:this={leftRoot}
            class="markdown-body selectable-content history-document"
            style:font-size={`${settingsStore.settings.contentZoom}%`}
          ></article>
        </div>
        <div class="history-gutter relative" aria-hidden="true">
          {#if band && showFlow}<svg
              class="pointer-events-none absolute inset-0 h-full w-full"
              viewBox={`0 0 48 ${bandHeight || 1}`}
              preserveAspectRatio="none"><path d={band} /></svg
            >{/if}
        </div>
        <div
          class="history-pane min-w-0 overflow-auto"
          bind:this={rightPane}
          onscroll={() => scroll("right")}
        >
          <div
            class="history-version sticky top-0 z-10 border-b bg-background/95 px-3 py-2 text-xs"
          >
            {m.next} · {rightRevision === "working" ? m.working : rightRevision.slice(0, 7)} · {#if rightSnapshot && !rightSnapshot.present}{m.unavailable}{/if}
          </div>
          <article
            bind:this={rightRoot}
            class="markdown-body selectable-content history-document"
            style:font-size={`${settingsStore.settings.contentZoom}%`}
          ></article>
        </div>
      </div>
      {#if mode === "source"}
        <div bind:this={sourceScroller} class="min-h-0 flex-1 overflow-auto" aria-label={m.source}>
          {#each sourcePairs as pair, index}
            <div
              data-source-row={index}
              class="history-source-row"
              class:history-added={pair.kind === "added"}
              class:history-deleted={pair.kind === "deleted"}
              class:history-changed={pair.kind === "changed"}
              aria-label={m[pair.kind]}
            >
              <pre><span class="history-line-number"
                  >{pair.kind === "equal"
                    ? ""
                    : pair.kind === "changed"
                      ? "±"
                      : pair.kind === "added"
                        ? "+"
                        : "−"} {pair.left === null ? "" : pair.left + 1}</span
                > {pair.left === null ? "" : leftLines[pair.left]}</pre>
              <pre><span class="history-line-number"
                  >{pair.right === null ? "−" : pair.right + 1}</span
                > {pair.right === null ? "" : rightLines[pair.right]}</pre>
            </div>
          {/each}
        </div>
      {/if}
      <footer class="flex flex-wrap gap-x-4 border-t px-3 py-2 text-xs text-muted-foreground">
        <span>＋ {m.added}</span><span>− {m.deleted}</span><span>± {m.changed}</span><span
          >{m.limited}</span
        >
      </footer>
    </div>
  </div>
</div>

<style>
  .history-columns {
    grid-template-columns: minmax(0, 1fr) 48px minmax(0, 1fr);
  }
  .history-document {
    padding: 24px;
    min-height: 100%;
  }
  .history-gutter {
    background: hsl(var(--muted) / 0.45);
  }
  .history-gutter path {
    fill: hsl(40 80% 55% / 0.23);
    stroke: hsl(40 70% 45% / 0.4);
    stroke-width: 1;
  }
  .history-document :global(.history-block) {
    border-inline-start: 3px solid transparent;
    padding-inline-start: 10px;
  }
  .history-document :global(.history-change-label) {
    display: block;
    font-size: 11px;
    color: hsl(var(--muted-foreground));
    margin-top: 12px;
  }
  .history-document :global(.history-added),
  .history-source-row.history-added {
    background: hsl(140 65% 50% / 0.12);
    border-inline-start-color: hsl(140 65% 40%);
  }
  .history-document :global(.history-deleted),
  .history-source-row.history-deleted {
    background: hsl(355 75% 55% / 0.12);
    border-inline-start-color: hsl(355 75% 50%);
  }
  .history-document :global(.history-changed),
  .history-source-row.history-changed {
    background: hsl(40 80% 55% / 0.14);
    border-inline-start-color: hsl(40 70% 45%);
  }
  .history-document :global(.history-selected) {
    outline: 2px solid hsl(var(--ring) / 0.55);
    outline-offset: 2px;
  }
  .history-document :global(mark.history-word-change) {
    color: inherit;
    background: hsl(40 85% 55% / 0.3);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .history-source-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border-bottom: 1px solid hsl(var(--border) / 0.4);
  }
  .history-source-row pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 2px 12px;
    font-size: 12px;
    user-select: text;
  }
  .history-source-row pre + pre {
    border-left: 1px solid hsl(var(--border));
  }
  .history-line-number {
    color: hsl(var(--muted-foreground));
    display: inline-block;
    min-width: 3ch;
  }
  @media (max-width: 900px) {
    .history-sidebar {
      width: 150px;
    }
    .history-columns {
      grid-template-columns: 1fr 1fr;
    }
    .history-gutter,
    .history-flow-toggle {
      display: none;
    }
    .history-document {
      padding: 14px;
    }
  }
  @media (max-width: 640px) {
    .history-sidebar {
      display: none;
    }
  }
</style>
