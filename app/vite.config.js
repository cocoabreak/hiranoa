import { defineConfig } from "vitest/config";
import { sveltekit } from "@sveltejs/kit/vite";
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import packageJson from "./package.json" with { type: "json" };
import packageLock from "./package-lock.json" with { type: "json" };
const aboutPackages = {
  mermaid: "Mermaid",
  katex: "KaTeX",
  "markdown-it": "markdown-it",
  shiki: "Shiki",
  dompurify: "DOMPurify",
};
/** @type {Record<string, { version?: string; license?: string; [key: string]: unknown }>} */
const lockedPackages = packageLock.packages;
const aboutBuildInfo = {
  appVersion: packageJson.version,
  components: Object.fromEntries(
    Object.entries(aboutPackages).map(([packageName, displayName]) => {
      const installed = lockedPackages[`node_modules/${packageName}`];
      if (!installed?.version || !installed?.license) {
        throw new Error(`About情報に必要な依存が見つかりません: ${packageName}`);
      }
      return [packageName, { displayName, version: installed.version, license: installed.license }];
    })
  ),
};

const host = process.env.TAURI_DEV_HOST;
const isVitest = Boolean(process.env.VITEST);

// 明示的な戻り値の型注釈が必要:
// この関数は server.hmr の三項演算子 + test.coverage を同時に含んでおり、
// 注釈なしだと defineConfig() のオーバーロード解決に失敗し
// 意味不明な "no properties in common with type 'UserConfig'" エラーになる
// (svelte-check で再現確認済み)。
/** @type {() => Promise<import('vitest/config').ViteUserConfig>} */
const config = async () => ({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ fallback: "index.html" }),
      version: { pollInterval: 0 },
    }),
    tailwindcss(),
  ],
  define: {
    __ABOUT_BUILD_INFO__: JSON.stringify(aboutBuildInfo),
  },

  // ADR-010: dev の依存事前バンドル（Rolldown optimizeDeps）が katex を壊し、
  // \frac 等のコマンドが描画されなくなる（\f がフォームフィード化）。katex を
  // 事前バンドルから除外し、素のESM(dist/katex.mjs)を読ませて回避する。
  // release build は optimizeDeps を使わず、engine.ts のESM注入で対応する。
  optimizeDeps: {
    exclude: ["katex"],
  },

  // Vitest実行時はsvelteをクライアント(browser)条件で解決させる。
  // 未指定だとSvelteKitのvite pluginがSSR条件で解決し、
  // @testing-library/svelte の mount() が「サーバーでは使えない」エラーになる。
  resolve: {
    // 既存importを維持し、SvelteKit 3で自動生成されなくなったaliasを明示する。
    alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) },
    ...(isVitest ? { conditions: ["browser"] } : {}),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    setupFiles: ["./vitest-setup.ts"],
    include: ["src/**/*.{test,spec}.{js,ts}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{js,ts,svelte}"],
      exclude: ["src/**/*.{test,spec}.{js,ts}", "src/**/*.d.ts"],
    },
  },
});

// https://vite.dev/config/
export default defineConfig(config);
