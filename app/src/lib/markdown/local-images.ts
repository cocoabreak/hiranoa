import { invoke } from "@tauri-apps/api/core";
import type { DocumentRef, DocumentSourceInfo } from "$lib/types";
import { documentKey, resolveDocumentTarget } from "$lib/document-sources";

const MAX_LOCAL_IMAGES_PER_DOCUMENT = 100;
const LOCAL_IMAGE_CONCURRENCY = 4;
const MAX_LOCAL_IMAGE_DATA_URL_CHARS = 64 * 1024 * 1024;

/**
 * width/height属性をインラインスタイルへ反映する。
 * Tailwind preflightの img{height:auto} に上書きされるのを防ぐため、
 * 属性ではなくインラインスタイルとしてカスケード優先度を確保する。
 */
export function applyIntrinsicImageSize(container: HTMLElement): void {
  for (const img of container.querySelectorAll<HTMLImageElement>("img")) {
    const width = img.getAttribute("width");
    const height = img.getAttribute("height");
    if (width) img.style.width = `${width}px`;
    if (height) img.style.height = `${height}px`;
  }
}

/**
 * 相対パス・ローカル絶対パスの画像を、信頼ルート内チェック（Rust側）を通した上で
 * base64データURLへ変換する。http(s)/data URLはそのまま。
 * 読み込み失敗・信頼ルート外はsrcを外して壊れ画像アイコン表示にする。
 */
export function hydrateLocalImages(
  container: HTMLElement | DocumentFragment,
  document: DocumentRef,
  source: DocumentSourceInfo,
  {
    maxDataUrlChars = MAX_LOCAL_IMAGE_DATA_URL_CHARS,
    forExport = false,
  }: { maxDataUrlChars?: number; forExport?: boolean } = {}
): { done: Promise<void[]>; cancel: () => void } {
  const images = Array.from(container.querySelectorAll<HTMLImageElement>("img"));
  const byPath = new Map<string, { document: DocumentRef; images: HTMLImageElement[] }>();
  for (const img of images) {
    const src = img.getAttribute("src") ?? "";
    if (!src || /^(?:https?:|data:)/i.test(src.trimStart())) continue;
    const resolved = resolveDocumentTarget(source, document, src);
    if (!resolved) {
      img.removeAttribute("src");
      continue;
    }
    const key = documentKey(resolved);
    const group = byPath.get(key) ?? { document: resolved, images: [] };
    group.images.push(img);
    byPath.set(key, group);
    // Rustで検証したdata URLを受け取るまでは、未検証のsrcをDOMに残さない。
    img.removeAttribute("src");
  }

  const entries = [...byPath.entries()];
  for (const [, skipped] of entries.slice(MAX_LOCAL_IMAGES_PER_DOCUMENT)) {
    skipped.images.forEach((img) => img.removeAttribute("src"));
  }
  const jobs = entries.slice(0, MAX_LOCAL_IMAGES_PER_DOCUMENT);
  let cancelled = false;
  let budgetExhausted = maxDataUrlChars <= 0;
  let hydratedChars = 0;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (!cancelled && !budgetExhausted) {
      const job = jobs[nextIndex++];
      if (!job) return;
      const [, { document: resolved, images: targets }] = job;
      try {
        const dataUrl = await invoke<string>("read_source_image", { document: resolved });
        if (cancelled) return;
        const storedChars = dataUrl.length * (forExport ? targets.length : 1);
        if (forExport && !dataUrl.startsWith("data:image/")) continue;
        if (forExport && !budgetExhausted && storedChars <= maxDataUrlChars - hydratedChars) {
          // Do not serialize local files that the browser cannot render as images.
          const probe = new Image();
          probe.src = dataUrl;
          await probe.decode();
          if (cancelled) return;
        }
        if (budgetExhausted || storedChars > maxDataUrlChars - hydratedChars) {
          budgetExhausted = true;
          targets.forEach((img) => img.removeAttribute("src"));
          return;
        }
        hydratedChars += storedChars;
        targets.forEach((img) => {
          if (img.parentNode) img.src = dataUrl;
        });
      } catch {
        targets.forEach((img) => img.removeAttribute("src"));
      }
    }
  }

  const workerCount = Math.min(LOCAL_IMAGE_CONCURRENCY, jobs.length);
  return {
    done: Promise.all(Array.from({ length: workerCount }, () => worker())),
    cancel: () => {
      cancelled = true;
    },
  };
}
