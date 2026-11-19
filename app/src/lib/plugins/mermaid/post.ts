import { addMermaidExpandButton } from "$lib/markdown/image-lightbox-trigger";
import type { Locale } from "$lib/i18n/index.svelte";
import { EXTERNAL_IMAGES_BLOCKED_EVENT } from "$lib/markdown/external-images";

// プラグイン自己完結の実行時文言（コアの辞書には載せない）
const MESSAGES = {
  ja: {
    renderFailed: "⚠ Mermaid レンダリング失敗（クリックでコードを表示）",
    resourcesBlocked: "外部リソースを制限しているため、Mermaid 図を表示できません。",
  },
  en: {
    renderFailed: "⚠ Mermaid rendering failed (click to show code)",
    resourcesBlocked: "This Mermaid diagram is hidden while external resources are restricted.",
  },
} satisfies Record<Locale, { renderFailed: string; resourcesBlocked: string }>;

const RENDER_TIMEOUT_MS = 8000;
const MAX_PRINT_DIAGRAMS = 100;
const PRINT_RENDER_CONCURRENCY = 2;

/** 単一のMermaid要素を描画する（タイムアウト付き） */
async function renderOne(
  el: HTMLElement,
  locale: Locale,
  externalImagesAllowed = false,
  onExternalImagesBlocked?: (count: number) => void,
  isCurrent: () => boolean = () => true,
  viewRoot?: HTMLElement,
  blockLocalResources = false
): Promise<void> {
  if (!isCurrent()) return;
  if (!el.classList.contains("mermaid-pending")) return;

  const code = decodeURIComponent(el.dataset.code ?? "");
  if (!code) return;

  el.classList.replace("mermaid-pending", "mermaid-processing");

  const renderId = `mermaid-${crypto.randomUUID()}`;
  const restricted = !externalImagesAllowed || blockLocalResources;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const blockDiagram = () => {
    if (blockLocalResources)
      throw new Error("Resource references are not supported in history diagrams");
    el.classList.replace("mermaid-processing", "mermaid-blocked");
    el.textContent = MESSAGES[locale].resourcesBlocked;
    if (onExternalImagesBlocked) onExternalImagesBlocked(1);
    else
      el.dispatchEvent(
        new CustomEvent(EXTERNAL_IMAGES_BLOCKED_EVENT, { detail: 1, bubbles: true })
      );
  };
  try {
    const resources = restricted ? await import("./resources") : null;
    if (!isCurrent()) return;
    const hasResources = blockLocalResources
      ? resources?.hasDiagramResources(code)
      : resources?.hasExternalImageNode(code);
    if (hasResources) {
      blockDiagram();
      return;
    }
    const render = restricted
      ? await (await import("./restricted")).getRestrictedRenderer()
      : (await import("./renderer")).renderMermaid;
    if (!isCurrent()) return;

    // タイムアウト付きで描画（hangするダイアグラムへの対策）
    const svg = await Promise.race([
      render(renderId, code),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Mermaid render timed out (${RENDER_TIMEOUT_MS}ms)`)),
          RENDER_TIMEOUT_MS
        );
      }),
    ]);

    if (!isCurrent()) return;
    if (resources?.hasSvgResources(svg)) {
      blockDiagram();
      return;
    }
    const scope = viewRoot?.dataset.viewScope;
    const svgTools = scope ? await import("$lib/markdown/view-svg") : null;
    if (!isCurrent()) return;
    el.innerHTML = svg;
    if (svgTools && scope) svgTools.namespaceGeneratedSvg(el, `view-${scope}`, viewRoot);
    el.classList.replace("mermaid-processing", "mermaid-rendered");
    addMermaidExpandButton(el);
  } catch (e) {
    if (!isCurrent()) return;
    console.warn("Mermaid render error:", e);
    const rawCode = el.dataset.code ? decodeURIComponent(el.dataset.code) : "";
    el.innerHTML = `
      <details class="mermaid-error-container" style="border:1px solid #f87171;border-radius:4px;padding:0.5rem;margin:0.5rem 0">
        <summary style="cursor:pointer;font-size:0.75rem;color:#f87171">
          ${MESSAGES[locale].renderFailed}
        </summary>
        <pre style="font-size:0.75rem;margin-top:0.5rem;overflow-x:auto"></pre>
      </details>`;
    // rawCodeは攻撃者制御の文字列のためinnerHTMLに直接埋め込まず、textContentで挿入する
    el.querySelector("pre")!.textContent = rawCode;
    el.classList.replace("mermaid-processing", "mermaid-error-container");
  } finally {
    clearTimeout(timeout);
    if (!restricted) {
      // Mermaidは描画用に d${id}（strict）または i${id}（sandbox）を
      // document.body直下へ作る。構文エラーやタイムアウトでもレイアウトへ漏らさない。
      // ${id} 自体は成功時に返されるSVGのIDなので、ここでは削除しない。
      document.getElementById(`d${renderId}`)?.remove();
      document.getElementById(`i${renderId}`)?.remove();
    }
  }
}

/**
 * コンテナ内の未レンダリングのMermaid図をすべて即時レンダリングする。
 * 印刷（PDF出力）前に、画面外で遅延中の図が空のまま出力されるのを防ぐために使う。
 */
export async function renderAllPending(
  container: HTMLElement,
  locale: Locale,
  externalImagesAllowed = false,
  onExternalImagesBlocked?: (count: number) => void,
  blockLocalResources = false
): Promise<void> {
  const pending = [...container.querySelectorAll<HTMLElement>(".mermaid-pending")];
  const jobs = pending.slice(0, MAX_PRINT_DIAGRAMS);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const element = jobs[nextIndex++];
      if (!element) return;
      await renderOne(
        element,
        locale,
        externalImagesAllowed,
        onExternalImagesBlocked,
        () => container.contains(element),
        container,
        blockLocalResources
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PRINT_RENDER_CONCURRENCY, jobs.length) }, () => worker())
  );
  if (pending.length > MAX_PRINT_DIAGRAMS) {
    console.warn(
      `Mermaid print rendering was limited to ${MAX_PRINT_DIAGRAMS} of ${pending.length} diagrams`
    );
  }
}

/**
 * コンテナ内の .mermaid-pending 要素を遅延レンダリングする。
 * IntersectionObserver でビューポートに近づいた時だけ描画するため、
 * 大量の図があってもUIをブロックしない。
 * @returns クリーンアップ関数
 */
export function setupLazyMermaid(
  container: HTMLElement,
  locale: Locale,
  externalImagesAllowed = false,
  onExternalImagesBlocked?: (count: number) => void,
  blockLocalResources = false
): () => void {
  const pending = container.querySelectorAll<HTMLElement>(".mermaid-pending");
  if (pending.length === 0) return () => {};

  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          // イベントループを解放してからレンダリング
          const timer = setTimeout(() => {
            timers.delete(timer);
            void renderOne(
              entry.target as HTMLElement,
              locale,
              externalImagesAllowed,
              onExternalImagesBlocked,
              () => !disposed && container.contains(entry.target),
              container,
              blockLocalResources
            );
          }, 0);
          timers.add(timer);
        }
      }
    },
    { rootMargin: "300px 0px", threshold: 0 } // 300px手前からプリレンダリング
  );

  pending.forEach((el) => observer.observe(el));

  return () => {
    disposed = true;
    observer.disconnect();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const element of pending) {
      if (container.contains(element))
        element.classList.replace("mermaid-processing", "mermaid-pending");
    }
  };
}
