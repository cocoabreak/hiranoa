import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { authorizePath } from "$lib/actions/security";
import { settingsStore } from "$lib/stores/settings.svelte";
import { prepareCustomCss } from "./scope";
import { workspaceStore } from "$lib/stores/workspace.svelte";

const STYLE_ID = "custom-user-css";
let unlistenChange: UnlistenFn | null = null;
let prepared = $state<((scope?: string) => string) | null>(null);
let applyGeneration = 0;
let applyQueue: Promise<void> = Promise.resolve();

function removeStyle() {
  document.querySelectorAll(`[id^="${STYLE_ID}"]`).forEach((style) => style.remove());
}

function createRuntimeStore() {
  let error = $state<string | null>(null);
  let applied = $state(false);

  return {
    get error() {
      return error;
    },
    get applied() {
      return applied;
    },
    setResult(nextError: string | null, nextApplied: boolean) {
      error = nextError;
      applied = nextApplied;
    },
  };
}

export const customCssRuntimeStore = createRuntimeStore();

async function applyCustomCssGeneration(generation: number): Promise<void> {
  if (generation !== applyGeneration) return;
  await invoke("unwatch_custom_css").catch(() => {});
  if (generation !== applyGeneration) return;
  prepared = null;
  removeStyle();
  customCssRuntimeStore.setResult(null, false);

  const { customCssEnabled, customCssPath } = settingsStore.settings;
  if (!customCssEnabled || !customCssPath) return;

  try {
    if (!(await authorizePath(customCssPath))) return;
    if (generation !== applyGeneration) return;
    const raw = await invoke<string>("read_custom_css", { path: customCssPath });
    if (generation !== applyGeneration) return;
    const compiled = await prepareCustomCss(raw);
    if (generation !== applyGeneration) return;
    prepared = compiled;
    applyStyles();
    await invoke("watch_custom_css", { path: customCssPath });
    if (generation !== applyGeneration) {
      removeStyle();
      await invoke("unwatch_custom_css").catch(() => {});
      return;
    }
    customCssRuntimeStore.setResult(null, true);
  } catch (error) {
    if (generation !== applyGeneration) return;
    removeStyle();
    customCssRuntimeStore.setResult(String(error), false);
  }
}

function applyStyles() {
  removeStyle();
  if (!prepared) return;
  workspaceStore.paneIds.forEach((id, index) => {
    const style = document.createElement("style");
    style.id = index === 0 ? STYLE_ID : `${STYLE_ID}-${id}`;
    style.textContent = prepared!(id);
    document.head.append(style);
  });
}

/** 現在の設定に従い、多重要求を直列化して最新のCSSとwatcherだけを確定する。 */
export function applyCustomCss(): Promise<void> {
  const generation = ++applyGeneration;
  const run = applyQueue.then(() => applyCustomCssGeneration(generation));
  applyQueue = run.catch(() => {});
  return run;
}

/** CSS変更イベントの購読を開始する。アプリのルートで一度だけ呼ぶ。 */
export async function startCustomCss(): Promise<() => void> {
  const stopStyles = $effect.root(() => {
    $effect(() => {
      void workspaceStore.paneIds;
      void prepared;
      applyStyles();
    });
  });
  await applyCustomCss();
  unlistenChange?.();
  unlistenChange = await listen("custom-css-changed", () => {
    void applyCustomCss();
  });
  return () => {
    stopStyles();
    prepared = null;
    applyGeneration++;
    unlistenChange?.();
    unlistenChange = null;
    removeStyle();
    customCssRuntimeStore.setResult(null, false);
    void invoke("unwatch_custom_css").catch(() => {});
  };
}
