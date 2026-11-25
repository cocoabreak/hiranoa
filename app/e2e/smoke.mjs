import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import {
  WebView2Driver,
  findFreePort,
  launchTauriDev,
  terminateProcessTree,
} from "../scripts/webview2-driver.mjs";
import { createFixtures } from "./fixtures.mjs";
import { verifyAnnotationMigration } from "./annotation-migration.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(appDir, "e2e", "artifacts");
const workDir = mkdtempSync(path.join(os.tmpdir(), "hiranoa-e2e-"));
const fixtures = createFixtures(path.join(workDir, "fixtures"));
const port = await findFreePort();
const driver = new WebView2Driver({ port });
const mermaidPolicyProbeUrl = "https://mermaid-images.example.invalid/frame-policy.png";
let child;
let failed = false;
let diagnostics;

const js = (value) => JSON.stringify(value.replaceAll("\\", "/"));
const state = () => driver.evaluate("window.__e2e.getState()");

async function test(name, run) {
  try {
    await run();
    globalThis.console.log(`PASS ${name}`);
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
}

async function open(method, file) {
  await driver.evaluate(`window.__e2e.${method}(${js(file)})`);
}

try {
  mkdirSync(artifactsDir, { recursive: true });
  const stateDir = path.join(workDir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "settings.json"),
    JSON.stringify({ settings: { checkForUpdatesOnStartup: false } })
  );
  child = launchTauriDev({
    appDir,
    port,
    profileDir: path.join(workDir, "profile"),
    stateDir,
    logPath: path.join(artifactsDir, "tauri.log"),
  });
  await driver.waitForCdp();
  diagnostics = await driver.observeDiagnostics();
  await driver.waitFor("window.__e2e?.getState().hydrated", { timeoutMs: 30_000 });

  await test("旧形式の注釈を保持し、最後の削除と候補検索の失敗を個別に表示する", () =>
    verifyAnnotationMigration(driver, workDir));

  await test("Markdownを開いて表示できる", async () => {
    await open("openMarkdownFile", fixtures.basic);
    await driver.waitFor(
      `document.querySelector('[role="main"]')?.innerText.includes('smoke-marker')`
    );
    assert.equal((await state()).activeTab.renderMode, "full");
    assert.equal(
      await driver.evaluate("getComputedStyle(document.querySelector('.markdown-body')).contain"),
      "paint"
    );
  });

  await test("Markdown方言・リンク・数式の互換性を維持する", async () => {
    await open("openMarkdownFile", fixtures.compatibility);
    await driver.waitFor("document.querySelector('.markdown-body .katex mfrac') !== null");
    await driver.waitFor(
      "document.querySelector('.wiki-link:not(.wiki-link-missing)[href]') !== null"
    );
    const result = await driver.evaluate(`(() => {
      const main = document.querySelector('.markdown-body');
      return {
        headingIds: [...main.querySelectorAll('h2')].map(h => h.getAttribute('data-logical-id')),
        wikiHref: main.querySelector('.wiki-link[data-wiki-target="guide/index"]')?.getAttribute('href'),
        definition: main.querySelector('dl dd strong')?.textContent,
        footnote: main.querySelector('.footnote-ref a')?.getAttribute('href'),
        footnoteTarget: main.querySelector('[data-logical-id="fn1"]')?.textContent,
        callout: main.querySelector('.callout-note .callout-title-text')?.textContent,
        checked: main.querySelector('input[type="checkbox"]')?.checked,
        emoji: main.textContent.includes('😄'),
        links: [...main.querySelectorAll('a')].map(a => a.getAttribute('href')),
        cjkLink: [...main.querySelectorAll('a')].find(a => a.textContent === 'https://example.com/')?.getAttribute('href'),
      };
    })()`);
    assert.deepEqual(result.headingIds, ["日本語見出し", "日本語見出し-1"]);
    assert.equal(result.wikiHref, "guide/index.md");
    assert.equal(result.definition, "Definition");
    assert.equal(result.footnote, "#fn1");
    assert.ok(result.footnoteTarget.includes("Footnote body"));
    assert.equal(result.callout, "Callout title");
    assert.equal(result.checked, true);
    assert.equal(result.emoji, true);
    assert.ok(result.links.includes("http://www.example.com"));
    assert.ok(result.links.includes("mailto:user@example.com"));
    assert.equal(result.cjkLink, "https://example.com/");
    assert.equal(
      await driver.evaluate(`document.querySelector('.markdown-body area[href="guide/index.md"]').dispatchEvent(
        new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
      )`),
      false
    );
  });

  await test("WebViewがアプリ画面外への直接遷移とポップアップを拒否する", async () => {
    const appPage = await driver.evaluate("location.href");
    const externalPage = `http://127.0.0.1:${await findFreePort()}/navigation-check`;
    const client = await driver.connect();
    try {
      for (const url of [
        externalPage,
        new URL("/link-graph", appPage).href,
        pathToFileURL(fixtures.basic).href,
      ]) {
        const result = await client.send("Page.navigate", { url });
        assert.equal(result.errorText, "net::ERR_ABORTED", url);
      }
      const popup = await client.send("Runtime.evaluate", {
        expression: `window.open(${JSON.stringify(externalPage)}) === null`,
        userGesture: true,
        returnByValue: true,
      });
      assert.equal(popup.result.value, true);
      assert.equal(await driver.evaluate("location.href"), appPage);
      assert.equal((await driver.targets()).filter((target) => target.type === "page").length, 1);
    } finally {
      client.close();
    }
  });

  await test("正常なMermaidをSVG表示できる", async () => {
    await open("openMarkdownFile", fixtures.validMermaid);
    await driver.waitFor("document.querySelector('.mermaid-rendered svg') !== null", {
      timeoutMs: 30_000,
    });
    const labelMetrics = await driver.evaluate(`(() => {
      const labels = [...document.querySelectorAll('.mermaid-rendered .nodeLabel p')];
      const measure = (text) => {
        const label = labels.find((element) => element.textContent.includes(text));
        if (!label) return null;
        const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
        const labelRect = label.getBoundingClientRect();
        const node = label.closest('g.node');
        const foreignRect = node?.querySelector('foreignObject')?.getBoundingClientRect();
        const shapeRect = node?.querySelector('rect, polygon, path')?.getBoundingClientRect();
        const contains = (outer) =>
          outer &&
          labelRect.top >= outer.top - 1 &&
          labelRect.right <= outer.right + 1 &&
          labelRect.bottom <= outer.bottom + 1 &&
          labelRect.left >= outer.left - 1;
        return {
          hasBreak: label.querySelector('br') !== null,
          lines: Math.round(label.offsetHeight / lineHeight),
          lineHeight,
          containedByForeignObject: contains(foreignRect),
          containedByShape: contains(shapeRect),
        };
      };
      const paragraph = [...document.querySelectorAll('.markdown-body > p')]
        .find((element) => element.textContent.includes('regular paragraph'));
      return {
        autoWrapped: measure('UTF-8'),
        rounded: measure('Long rounded'),
        diamond: measure('Diamond node'),
        stadium: measure('Stadium node'),
        single: measure('Single line'),
        paragraphLineHeight: paragraph ? getComputedStyle(paragraph).lineHeight : null,
      };
    })()`);
    assert.equal(labelMetrics.autoWrapped.hasBreak, false);
    assert.ok(labelMetrics.autoWrapped.lines >= 2);
    assert.equal(labelMetrics.autoWrapped.lineHeight, 24);
    assert.equal(labelMetrics.autoWrapped.containedByForeignObject, true);
    assert.equal(labelMetrics.autoWrapped.containedByShape, true);
    for (const shape of ["rounded", "diamond", "stadium"]) {
      assert.deepEqual(labelMetrics[shape], {
        hasBreak: true,
        lines: 2,
        lineHeight: 24,
        containedByForeignObject: true,
        containedByShape: true,
      });
    }
    assert.deepEqual(labelMetrics.single, {
      hasBreak: false,
      lines: 1,
      lineHeight: 24,
      containedByForeignObject: true,
      containedByShape: true,
    });
    assert.equal(labelMetrics.paragraphLineHeight, "28px");
  });

  await test("Mermaid の拡大表示はリンクを無効にし、拡大・移動・終了できる", async () => {
    const file = path.join(workDir, "fixtures", "lightbox-mermaid.md");
    writeFileSync(
      file,
      '# Diagram\n\n```mermaid\nflowchart LR\n  A[Overview] --> B[Details]\n  click A href "#details"\n```\n\n## Details\n'
    );
    await open("openMarkdownFile", file);
    const expand = ".mermaid-rendered .lightbox-trigger-button";
    const original = ".mermaid-rendered svg a";
    await driver.waitFor(`document.querySelector(${JSON.stringify(original)}) !== null`);
    const appUrl = await driver.evaluate("location.href");
    const getLink = (selector) =>
      driver.evaluate(`(() => {
        const link = document.querySelector(${JSON.stringify(selector)});
        return [link.getAttribute("href"), link.getAttributeNS("http://www.w3.org/1999/xlink", "href")];
      })()`);
    assert.ok((await getLink(original)).includes("#details"));

    const dialog = '[role="dialog"]:has(svg a)';
    const link = `${dialog} svg a`;
    const close = `${dialog} > button`;
    const client = await driver.connect();
    const pressKey = async (key, windowsVirtualKeyCode) => {
      const fields = { key, code: key, windowsVirtualKeyCode };
      await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...fields });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...fields });
    };
    const mouseButton = async (type, point, button, buttons) =>
      client.send("Input.dispatchMouseEvent", { type, ...point, button, buttons, clickCount: 1 });
    const waitForDialog = (present) =>
      driver.waitFor(`Boolean(document.querySelector(${JSON.stringify(dialog)})) === ${present}`);
    try {
      assert.equal(await driver.click(expand), "OK");
      await waitForDialog(true);
      assert.deepEqual(await getLink(link), [null, null]);
      assert.ok((await getLink(original)).includes("#details"));

      const point = await driver.evaluate(`(() => {
        const anchor = document.querySelector(${JSON.stringify(link)});
        const box = anchor.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return anchor.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
      })()`);
      assert.ok(point, "拡大した SVG のリンク位置を実マウスで操作できる");
      for (const [button, buttons] of [
        ["left", 1],
        ["middle", 4],
      ]) {
        await mouseButton("mousePressed", point, button, buttons);
        await mouseButton("mouseReleased", point, button, 0);
      }
      assert.equal(await driver.evaluate("location.href"), appUrl);

      // A presentation-only link is skipped by Tab. Enter also has no destination
      // if the element receives focus (for example, from a keyboard tool).
      const focus = (selector) =>
        driver.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      const hasFocus = (selector) =>
        driver.evaluate(`document.activeElement.matches(${JSON.stringify(selector)})`);
      await focus(close);
      await pressKey("Tab", 9);
      assert.equal(await hasFocus(close), true);
      await driver.evaluate(
        `document.querySelector(${JSON.stringify(link)}).setAttribute("tabindex", "0")`
      );
      await focus(link);
      assert.equal(await hasFocus(link), true);
      await pressKey("Enter", 13);
      assert.equal(await driver.evaluate("location.href"), appUrl);
      assert.equal((await driver.targets()).filter((target) => target.type === "page").length, 1);

      const matrix = `new DOMMatrixReadOnly(getComputedStyle(document.querySelector(
        ${JSON.stringify(`${dialog} div[style^="transform:"]`)}
      )).transform)`;
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...point,
        deltaX: 0,
        deltaY: -120,
      });
      await driver.waitFor(`${matrix}.a > 1`);
      await mouseButton("mousePressed", point, "left", 1);
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x + 32,
        y: point.y + 18,
        button: "left",
        buttons: 1,
      });
      await mouseButton("mouseReleased", { x: point.x + 32, y: point.y + 18 }, "left", 0);
      await driver.waitFor(`${matrix}.e === 32 && ${matrix}.f === 18`);

      await focus(close);
      await pressKey("Escape", 27);
      await waitForDialog(false);
      assert.equal(await driver.click(expand), "OK");
      await waitForDialog(true);
      assert.equal(await driver.evaluate(`${matrix}.isIdentity`), true);
      assert.equal(await driver.click(close), "OK");
      await waitForDialog(false);
    } finally {
      client.close();
    }
  });

  await test("Mermaid の外部画像は確認・ブロック中にリクエストを開始しない", async () => {
    const imageOrigin = "https://mermaid-images.example.invalid";
    const png = readFileSync(path.join(appDir, "static", "favicon.png")).toString("base64");
    const requests = [];
    // Supply a test image through CDP. No requests leave the WebView test environment.
    const client = await driver.connect({
      onEvent: ({ method, params }) => {
        if (method !== "Fetch.requestPaused") return;
        requests.push(
          client.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "image/png" }],
            body: png,
          })
        );
      },
    });
    const approveButton = `[...document.querySelectorAll('button')].find(el =>
      ['Load images for this document', 'この文書の画像を読み込む'].includes(el.textContent.trim()))`;
    try {
      await client.send("Fetch.enable", { patterns: [{ urlPattern: `${imageOrigin}/*` }] });
      const framePolicy = await driver.evaluate(`(async () => {
        const frame = document.querySelector('iframe[data-mermaid-renderer]');
        const violation = new Promise(resolve => {
          frame.contentDocument.addEventListener('securitypolicyviolation',
            event => resolve(event.effectiveDirective), { once: true });
        });
        const image = new frame.contentWindow.Image();
        image.src = ${JSON.stringify(mermaidPolicyProbeUrl)};
        return Promise.all([violation, image.decode().then(() => true, () => false)]);
      })()`);
      assert.deepEqual(framePolicy, ["img-src", false]);
      assert.equal(requests.length, 0, "The isolated renderer CSP must stop the image request");
      for (const policy of ["block", "ask"]) {
        await driver.evaluate(`(async () => {
          const { settingsStore } = await import('/src/lib/stores/settings.svelte.ts');
          settingsStore.setExternalImagePolicy(${JSON.stringify(policy)});
        })()`);
        const file = path.join(workDir, "fixtures", `mermaid-images-${policy}.md`);
        writeFileSync(
          file,
          [
            `# ${policy} diagram policy`,
            "",
            "```mermaid",
            "flowchart LR",
            '  A[Start] --> B["img: and image() are labels"]',
            "```",
            "",
            "```mermaid",
            "flowchart LR",
            `  A@{ img: "data:image/png;base64,${png}", w: 32, h: 32 }`,
            "```",
            "",
            "```mermaid",
            "flowchart LR",
            `  A@{ img: "${imageOrigin}/${policy}.png", label: "Example image", w: 48, h: 48 }`,
            "```",
          ].join("\n")
        );
        await open("openMarkdownFile", file);
        await driver.waitFor(
          `document.querySelector('.markdown-body h1')?.textContent === '${policy} diagram policy'
            && document.querySelectorAll('.mermaid-rendered > svg').length === 2
            && document.querySelector('.mermaid-rendered > svg image')?.getAttribute('href')?.startsWith('data:image/png')
            && document.querySelector('.mermaid-blocked') !== null`,
          { timeoutMs: 30_000 }
        );
        assert.equal(requests.length, 0, `Mermaid started an image request during ${policy}`);
        assert.equal(await driver.evaluate(`Boolean(${approveButton})`), policy === "ask");
      }

      await driver.evaluate(`(${approveButton}).click()`);
      await driver.waitFor(
        `document.querySelector('.mermaid-rendered svg image[href="${imageOrigin}/ask.png"]') !== null`,
        { timeoutMs: 30_000 }
      );
      assert.ok(requests.length > 0, "The approved diagram should request its image");
      await Promise.all(requests);
    } finally {
      client.close();
    }
  });

  await test("数式とMermaid内数式を描画できる", async () => {
    await open("openMarkdownFile", fixtures.math);
    await driver.waitFor("document.querySelector('.mermaid-rendered .katex') !== null", {
      timeoutMs: 30_000,
    });
    const math = await driver.evaluate(`(async () => {
      const fonts = [...document.fonts].filter(font => font.family.includes('KaTeX'));
      await Promise.all(fonts.map(font => font.load()));
      await document.fonts.ready;
      const main = document.querySelector('[role="main"]');
      const formula = main.querySelector('.katex');
      const rendered = formula.querySelector('.katex-html');
      const box = rendered.getBoundingClientRect();
      return {
        fractions: main.querySelectorAll('mfrac').length,
        roots: main.querySelectorAll('msqrt').length,
        errors: main.querySelectorAll('.katex-error').length,
        fontCount: fonts.length,
        allFontsLoaded: fonts.every(font => font.status === 'loaded'),
        width: box.width,
        height: box.height,
      };
    })()`);
    assert.ok(math.fractions >= 2);
    assert.ok(math.roots >= 1);
    assert.equal(math.errors, 0);
    assert.equal(math.fontCount, 20);
    assert.equal(math.allFontsLoaded, true);
    assert.ok(math.width > 0 && math.height > 0);
  });

  await test("不正なMermaidをエラー表示できる", async () => {
    await open("openMarkdownFile", fixtures.invalidMermaid);
    await driver.waitFor("document.querySelector('.mermaid-error-container') !== null", {
      timeoutMs: 30_000,
    });
  });

  for (const kind of ["native", "zip"]) {
    await test(`${kind}: 対応画像を表示し非対応形式を拒否する`, async () => {
      if (kind === "native") {
        await open("openMarkdownFile", fixtures.compatibility);
      } else {
        await open("openArchive", fixtures.archive);
        await driver.evaluate("window.__e2e.openArchiveEntry('inside.md')");
        await driver.waitFor(
          `document.querySelector('[role="main"]')?.innerText.includes('zip-smoke-marker')`
        );
      }
      await driver.waitFor(`(() => {
        const image = document.querySelector('.markdown-body img[alt="Supported format"]');
        return image?.getAttribute('src')?.startsWith('data:image/gif;base64,') && image.naturalWidth === 1;
      })()`);
      const result = await driver.evaluate(`(async () => {
        const { tabStore } = await import('/src/lib/stores/tab.svelte.ts');
        const tab = tabStore.tabs.find(tab => tab.id === tabStore.activeTabId);
        const { invoke } = window.__TAURI_INTERNALS__;
        const read = async (command, args) => {
          try {
            await invoke(command, args);
            return null;
          } catch (error) {
            return String(error);
          }
        };
        const sourceError = await read('read_source_image', {
          document: { ...tab.document, path: 'images/pixel.txt' }
        });
        const directError = ${kind === "native"} ? await read('read_image_data_url', {
          path: ${js(path.join(path.dirname(fixtures.compatibility), "images/pixel.txt"))}
        }) : null;
        const image = document.querySelector('.markdown-body img[alt="Unsupported format"]');
        return { sourceError, directError, unsupportedHasSource: image?.hasAttribute('src') };
      })()`);
      assert.deepEqual(result, {
        sourceError: "対応していない画像形式です",
        directError: kind === "native" ? "対応していない画像形式です" : null,
        unsupportedHasSource: false,
      });
    });
  }

  for (const kind of ["native", "zip"]) {
    await test(`${kind}: ディレクトリーリンクのプレビュー・アンカー・タブを統一する`, async () => {
      if (kind === "native") {
        await open("openMarkdownFile", fixtures.directoryLinks);
      } else {
        await open("openArchive", fixtures.directoryArchive);
        await driver.evaluate("window.__e2e.openArchiveEntry('directory-links.md')");
      }
      await driver.waitFor("document.querySelector('a[href=\"guide/#details\"]') !== null");
      await driver.evaluate("document.querySelector('a[href=\"guide/#details\"]').focus()");
      await driver.waitFor(
        "document.querySelector('#link-preview-tooltip')?.textContent.includes('guide/index.md')"
      );
      await driver.click('a[href="guide/#details"]');
      await driver.waitFor(
        "document.querySelector('[role=\"main\"]')?.innerText.includes('directory-index-marker')"
      );
      await driver.waitFor("document.querySelector('[role=\"main\"]')?.scrollTop > 500");
      const before = await state();
      assert.ok(before.activeTab.path.endsWith(":guide%2Findex.md"));
      const tabCount = await driver.evaluate("document.querySelectorAll('[data-tab-id]').length");
      await driver.click('a[href="./#details"]');
      assert.equal((await state()).activeTab.path, before.activeTab.path);
      await driver.click('a[href="../directory-links.md"]');
      await driver.waitFor("document.querySelector('a[href=\"guide\"]') !== null");
      await driver.click('a[href="guide"]');
      await driver.waitFor("window.__e2e.getState().activeTab.path.endsWith(':guide%2Findex.md')");
      assert.equal((await state()).activeTab.path, before.activeTab.path);
      await driver.click('a[href="../directory-links.md"]');
      await driver.waitFor("document.querySelector('a[href=\"guide/index.md\"]') !== null");
      await driver.click('a[href="guide/index.md"]');
      await driver.waitFor("window.__e2e.getState().activeTab.path.endsWith(':guide%2Findex.md')");
      assert.equal((await state()).activeTab.path, before.activeTab.path);
      assert.equal(
        await driver.evaluate("document.querySelectorAll('[data-tab-id]').length"),
        tabCount
      );
      for (const name of ["read me", "日本語 資料", "literal%20name"]) {
        await driver.click('a[href="../directory-links.md"]');
        const selector = `a[href="${encodeURIComponent(name)}/"]`;
        await driver.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
        await driver.click(selector);
        const suffix = `:${encodeURIComponent(`${name}/index.md`)}`;
        await driver.waitFor(
          `window.__e2e.getState().activeTab.path.endsWith(${JSON.stringify(suffix)})`
        );
        await driver.waitFor(
          "document.querySelector('a[href=\"../directory-links.md\"]') !== null"
        );
      }
    });
  }

  await test("Wikiリンクで文書を開ける", async () => {
    await open("openMarkdownFile", fixtures.compatibility);
    const wiki = '.markdown-body .wiki-link[data-wiki-target="guide/index"][href]';
    await driver.waitFor(`document.querySelector(${JSON.stringify(wiki)}) !== null`);
    assert.equal(await driver.click(wiki), "OK");
    await driver.waitFor("window.__e2e.getState().activeTab.path.endsWith(':guide%2Findex.md')");
  });

  await test("除外設定が Wiki リンクと文書一覧に反映される", async () => {
    const root = path.join(workDir, "fixtures", "ignore-rules");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(path.join(root, "notes"));
    writeFileSync(path.join(root, ".gitignore"), "draft-*.md\n");
    writeFileSync(path.join(root, "notes", ".gitignore"), "!draft-visible.md\n");
    writeFileSync(path.join(root, "notes", "draft-hidden.md"), "# Hidden");
    writeFileSync(path.join(root, "notes", "draft-visible.md"), "# Visible");
    const file = path.join(root, "index.md");
    writeFileSync(file, "# Ignore rules\n\n[[draft-hidden]] and [[draft-visible]]");

    await open("openMarkdownFile", file);
    await driver.waitFor(`document.querySelector('.markdown-body .wiki-link-missing[data-wiki-target="draft-hidden"]')
      && document.querySelector('.markdown-body a[href="notes/draft-visible.md"]')`);
    const paths = await driver.evaluate(`(async () => {
      const { tabStore } = await import('/src/lib/stores/tab.svelte.ts');
      const { document: { sourceId } } = tabStore.tabs.find(tab => tab.id === tabStore.activeTabId);
      const { invoke } = window.__TAURI_INTERNALS__;
      const list = (respectGitignore) => invoke('list_source_markdown_documents', {
        sourceId, showHiddenFiles: false, respectGitignore
      }).then(documents => documents.map(({ path }) => path).sort());
      return [await list(true), await list(false)];
    })()`);
    assert.deepEqual(paths, [
      ["index.md", "notes/draft-visible.md"],
      ["index.md", "notes/draft-hidden.md", "notes/draft-visible.md"],
    ]);
  });

  await test("5 MiB境界で安全モードへ切り替わる", async () => {
    await open("openMarkdownFile", fixtures.belowLimit);
    assert.equal((await state()).activeTab.renderMode, "full");
    await open("openLargeMarkdownInSafeMode", fixtures.atLimit);
    assert.equal((await state()).activeTab.renderMode, "safe");
    await driver.waitFor(`document.querySelector('[role="main"]')?.innerText.includes('At limit')`);
  });

  await test("左右同一文書のIDと表示状態を分離し、片側クローズ後も本文を残す", async () => {
    await driver.evaluate("window.__e2e.resetSession()");
    await open("openMarkdownFile", fixtures.compatibility);
    await driver.waitFor("document.querySelector('.footnote-ref') !== null");
    await driver.key("Ctrl+\\");
    await driver.waitFor("document.querySelectorAll('.markdown-body .footnote-ref').length === 2");
    const ids = await driver.evaluate(
      "[...document.querySelectorAll('.markdown-body [id]')].map(el => el.id)"
    );
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(await driver.click('button[aria-label="元のMarkdownを表示"]'), "OK");
    await driver.waitFor("document.querySelectorAll('.source-view').length === 1");
    assert.equal(
      await driver.evaluate("document.querySelectorAll('.markdown-body .footnote-ref').length"),
      1
    );
    await driver.key("Ctrl+W");
    await driver.waitFor("document.querySelectorAll('.markdown-body').length === 1");
    await driver.waitFor("document.querySelector('.footnote-ref') !== null");
  });

  await test("名前付きレイアウトの検索復元と倍率変更で閲覧位置を維持する", async () => {
    const layoutDocument = path.join(workDir, "fixtures", "layout-position.md");
    writeFileSync(
      layoutDocument,
      Array.from(
        { length: 200 },
        (_, i) => `## Section ${i}\n\nlayout-position-marker paragraph ${i}\n`
      ).join("\n")
    );
    await driver.evaluate("window.__e2e.resetSession()");
    await open("openMarkdownFile", layoutDocument);
    await driver.waitFor(
      "document.querySelector('.markdown-body')?.textContent.includes('layout-position-marker')"
    );
    for (const mode of ["rendered", "source"]) {
      await driver.evaluate(`(async () => {
        const tabs = (await import('/src/lib/stores/tab.svelte.ts')).tabStore;
        tabs.updateTab(tabs.activeTabId, {viewMode: ${JSON.stringify(mode)}});
        (await import('/src/lib/stores/settings.svelte.ts')).settingsStore.setContentZoom(200);
        const search = (await import('/src/lib/stores/search.svelte.ts')).searchStore;
        search.setQuery('layout-position-marker'); search.openSearch();
      })()`);
      await driver.waitFor(
        "document.querySelector('.search-match') !== null || document.querySelector('mark') !== null"
      );
      const saved = await driver.evaluate(`(async () => {
        await new Promise(resolve => setTimeout(resolve, 350));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const main = document.querySelector('[role="main"]');
        main.scrollTop = main.scrollHeight - main.clientHeight - 100;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return main.scrollTop;
      })()`);
      assert.ok(saved > 1000);
      // Complete the browser's scroll event delivery before taking the saved snapshot.
      await driver.waitFor(
        `Math.abs((window.__e2e.getState().scroll[${JSON.stringify(mode)}] ?? -1) - ${saved}) < 3`
      );
      await driver.evaluate(`(async () => {
        const actions = await import('/src/lib/actions/layout-actions.ts');
        const layout = actions.captureLayout('Position regression');
        (await import('/src/lib/stores/settings.svelte.ts')).settingsStore.setContentZoom(50);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await actions.applyLayout(layout);
      })()`);
      await driver.waitFor(
        `Math.abs(document.querySelector('[role="main"]').scrollTop - ${saved}) < 3`
      );
      await driver.evaluate("new Promise(resolve => setTimeout(resolve, 400))");
      const actual = await driver.evaluate("document.querySelector('[role=main]').scrollTop");
      assert.ok(Math.abs(actual - saved) < 3, `${mode}: saved=${saved}, actual=${actual}`);
    }
    await driver.evaluate(
      `(async()=>{(await import('/src/lib/stores/search.svelte.ts')).searchStore.closeSearch();(await import('/src/lib/stores/settings.svelte.ts')).settingsStore.setContentZoom(100)})()`
    );
  });

  await test("更新通知を表示できる", async () => {
    await driver.evaluate("window.__e2e.showUpdateAvailable()");
    await driver.waitFor(
      `Array.from(document.querySelectorAll('[role="status"]')).some((el) => el.innerText.includes('9.9.9'))`
    );
  });

  await test("リロード後にタブ・検索・スクロールを復元する", async () => {
    await driver.evaluate("window.__e2e.resetSession()");
    await open("openMarkdownFile", fixtures.basic);
    await driver.waitFor(
      "document.querySelector('[role=\"main\"]')?.scrollHeight > document.querySelector('[role=\"main\"]')?.clientHeight + 600"
    );
    // 対象文書のDOM構築と二段階の初期スクロール復元が完了してから検索する。
    await driver.waitFor(
      "document.querySelector('.markdown-body [data-logical-id=\"section-299\"]') !== null"
    );
    await driver.evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    );
    await driver.key("Ctrl+F");
    await driver.waitFor("document.querySelector('input') !== null");
    await driver.evaluate(`(() => {
      const input = document.querySelector('input');
      const main = document.querySelector('[role="main"]');
      window.__e2eSearchScrollEnded = false;
      main.addEventListener('scrollend', () => { window.__e2eSearchScrollEnded = true; }, { once: true });
      input.value = 'line 10';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    // 検索結果への遅延スクロールと手動スクロールを競合させず、実際の移動完了を待つ。
    await driver.waitFor("window.__e2e.getState().search.query === 'line 10'");
    await driver.waitFor("window.__e2eSearchScrollEnded === true");
    await driver.waitFor("window.__e2e.getState().scroll.rendered >= 500");
    await driver.evaluate("window.__e2eReloadMarker = 'old-page'");
    await driver.key("Ctrl+R");
    await driver.waitFor("window.__e2eReloadMarker === undefined", { timeoutMs: 30_000 });
    await driver.waitFor("window.__e2e?.getState().hydrated", { timeoutMs: 30_000 });
    await driver.waitFor("window.__e2e.getState().search.query === 'line 10'");
    await driver.waitFor("document.querySelector('[role=\"main\"]')?.scrollTop >= 500");
    const restored = await state();
    assert.equal(restored.activeTab.title, "basic.md");
    assert.equal(restored.search.open, true);
    assert.ok(restored.scroll.rendered >= 500, `scroll=${restored.scroll.rendered}`);
  });

  await test("現在の文書ソースから別の認可済みソースの本文と画像を読めない", async () => {
    const sibling = path.join(workDir, "other-source");
    const outsideMarkdown = path.join(sibling, "note.md");
    const outsideImage = path.join(sibling, "pixel.GIF");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(outsideMarkdown, "# Other source");
    writeFileSync(
      outsideImage,
      readFileSync(path.join(path.dirname(fixtures.compatibility), "images/pixel.GIF"))
    );
    await open("openMarkdownFile", fixtures.compatibility);
    await driver.waitFor(`(() => {
      const body = document.querySelector('.markdown-body');
      const image = body?.querySelector('img[alt="Supported format"]');
      return body?.querySelector('h1')?.textContent === 'Markdown compatibility' &&
        image?.getAttribute('src')?.startsWith('data:image/gif;base64,') && image.naturalWidth === 1;
    })()`);
    const result = await driver.evaluate(`(async () => {
      const { tabStore } = await import('/src/lib/stores/tab.svelte.ts');
      const { document: { sourceId } } = tabStore.tabs.find(tab => tab.id === tabStore.activeTabId);
      const { invoke } = window.__TAURI_INTERNALS__;
      await invoke('authorize_dev_path', { path: ${js(sibling)} });
      const markdownAllowed = await invoke('is_path_allowed', { path: ${js(outsideMarkdown)} });
      const imageAllowed = await invoke('is_path_allowed', { path: ${js(outsideImage)} });
      const readError = (command, path) => invoke(command, { document: { sourceId, path } })
        .then(() => null, error => String(error));
      return {
        markdownAllowed, imageAllowed,
        markdownError: await readError('read_source_markdown', '../other-source/note.md'),
        imageError: await readError('read_source_image', '../other-source/pixel.GIF'),
      };
    })()`);
    assert.deepEqual(result, {
      markdownAllowed: true,
      imageAllowed: true,
      markdownError: "ソースのルート外へ移動できません",
      imageError: "ソースのルート外へ移動できません",
    });
  });

  await test("注釈の保存、コピーの分離、改訂時の位置の復元と未解決表示", async () => {
    const original = path.join(workDir, "guide.md");
    const copy = path.join(workDir, "copy.md");
    const raw =
      "# 設定の適用\n\n設定は翌日から反映されます。\n\n変更内容は履歴から確認できます。\n";
    writeFileSync(original, raw);
    writeFileSync(copy, raw);
    const button = (selector) => `document.querySelector('.annotations ${selector}')`;
    const highlight = "CSS.highlights.get('hiranoa-note-yellow')?.size";
    const client = await driver.connect();
    const viewport = (width) =>
      client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 760,
        deviceScaleFactor: 1,
        mobile: false,
      });
    try {
      const selectParagraph = (index = 0) =>
        driver.evaluate(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelectorAll('.markdown-body p')[${index}]);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    })()`);
      const toolbar = "[data-annotation-toolbar]";
      await driver.evaluate("window.__e2e.resetSession()");
      await viewport(1250);
      await driver.evaluate(`(async()=>{const {settingsStore}=await import('/src/lib/stores/settings.svelte.ts');
      settingsStore.setTheme('dark'); settingsStore.setContentZoom(100); if(!settingsStore.settings.tocVisible)settingsStore.toggleToc();})()`);
      await open("openMarkdownFile", original);
      await driver.waitFor(
        "document.documentElement.classList.contains('dark') && document.querySelector('[data-notes-tab]') && document.querySelector('.markdown-body p')?.textContent==='設定は翌日から反映されます。'"
      );
      const location = () =>
        driver.evaluate(
          "document.querySelector('.markdown-body p').getBoundingClientRect().toJSON()"
        );
      const before = await location();
      await selectParagraph(1);
      await driver.waitFor(
        "document.querySelectorAll('[data-annotation-toolbar] [data-pick]').length === 3"
      );
      await driver.evaluate("document.querySelector('[data-annotation-toolbar] button').focus()");
      await driver.key("Escape");
      await driver.waitFor("!document.querySelector('[data-annotation-toolbar]')");
      await selectParagraph(1);
      await driver.waitFor("document.querySelector('[data-annotation-toolbar] [data-pick=blue]')");
      await driver.click(toolbar + " [data-pick=blue]");
      await driver.waitFor(
        "CSS.highlights.get('hiranoa-note-blue')?.size === 1 && !document.querySelector('[data-annotation-toolbar]')"
      );
      assert.deepEqual(await location(), before);
      assert.equal(await driver.evaluate("document.querySelector('.annotations') === null"), true);
      await selectParagraph();
      await driver.waitFor("document.querySelector('[data-add-memo]') !== null");
      await driver.click(toolbar + " [data-add-memo]");
      await driver.waitFor("document.activeElement.matches('[data-annotation-toolbar] textarea')");
      await driver.evaluate(`(() => {
      const input = document.querySelector('[data-annotation-toolbar] textarea');
      input.value='運用チームに確認する';
      input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('[data-annotation-toolbar] [data-save]').click();
    })()`);
      await driver.waitFor(
        `${highlight} === 1 && !document.querySelector('[data-annotation-toolbar]')`
      );
      await driver.click("[data-notes-tab]");
      await driver.waitFor(`${button("article p")}?.textContent === '運用チームに確認する'`);
      await driver.click(".annotations article[data-color=yellow] [data-edit]");
      await driver.waitFor(`${button("[data-pick=yellow][aria-pressed=true]")}`);
      await driver.screenshot(path.join(artifactsDir, "annotation-colors-dark.png"));
      await driver.click(".annotations [data-save]");
      await open("openMarkdownFile", copy);
      await driver.waitFor(button("[data-match]"));
      assert.equal(await driver.evaluate(highlight + " ?? 0"), 0);
      assert.equal(await driver.evaluate(button("article") + " === null"), true);
      writeFileSync(
        original,
        raw.replace(
          "設定は翌日から反映されます。",
          "適用する前に内容を確認してください。\n\n設定は翌日から反映されます。"
        )
      );
      await open("openMarkdownFile", original);
      await driver.waitFor(
        `document.querySelector('.markdown-body p')?.textContent === '適用する前に内容を確認してください。' && ${highlight} === 1`
      );
      writeFileSync(copy, readFileSync(original));
      await open("openMarkdownFile", copy);
      await driver.waitFor(button("[data-match]"));
      assert.equal(await driver.evaluate(highlight + " ?? 0"), 0);
      writeFileSync(original, raw.replace("翌日", "当日"));
      await open("openMarkdownFile", original);
      await driver.waitFor(
        `document.querySelector('.markdown-body p')?.textContent === '設定は当日から反映されます。' && !(${highlight})`
      );
      await driver.waitFor(
        `${button("article strong")} && ${button("article[data-color=yellow] q")}?.textContent === '設定は翌日から反映されます。' && ${button("article p")}?.textContent === '運用チームに確認する'`
      );
      await driver.evaluate(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('.markdown-body p'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    })()`);
      await driver.waitFor(button("button[data-reattach]"));
      await driver.click(".annotations article[data-color=yellow] button[data-reattach]");
      await driver.waitFor(
        `${highlight} === 1 && ${button("article[data-color=yellow] q")}?.textContent === '設定は当日から反映されます。' && ${button("article p")}?.textContent === '運用チームに確認する'`
      );
      // The narrow drawer is reachable even from a document without headings.
      await viewport(770);
      const plain = path.join(workDir, "reading.md");
      writeFileSync(plain, "本文だけの文書です。\n");
      await open("openMarkdownFile", plain);
      await driver.waitFor(
        "document.querySelector('[data-open-annotations]') && document.querySelector('.markdown-body p')?.textContent === '本文だけの文書です。'"
      );
      await driver.click("[data-open-annotations]");
      await driver.waitFor(
        "document.querySelector('#toc-drawer .annotations') && !document.querySelector('.annotations article')"
      );
      await driver.evaluate(`(() => {
        const input=document.querySelector('#toc-drawer input[type=file]');
        const transfer=new DataTransfer();
        transfer.items.add(new File(["{}"],"annotations.json",{type:"application/json"}));
        input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));
      })()`);
      await driver.waitFor("document.querySelector('#toc-drawer [role=alert]')");
      await driver.click("#toc-drawer [data-close-panel]");
      await driver.waitFor("!document.querySelector('#toc-drawer')");
      // In split view the list follows the pane that owns the keyboard focus.
      await viewport(1600);
      await driver.key("Ctrl+\\");
      await driver.waitFor("document.querySelectorAll('.viewer-pane').length===2");
      await open("openMarkdownFile", original);
      await driver.waitFor("!!document.querySelector('.annotations article')");
      await driver.evaluate(`(() => {
        const range=document.createRange();
        range.selectNodeContents(document.querySelector('.pane-active .markdown-body p'));
        getSelection().removeAllRanges();getSelection().addRange(range);
      })()`);
      await driver.waitFor("document.querySelector('[data-add-memo]')");
      await driver.click(toolbar + " [data-add-memo]");
      await driver.waitFor("document.activeElement.matches('[data-annotation-toolbar] textarea')");
      await driver.evaluate(`(() => {
        const input=document.activeElement;
        input.value="編集中のメモ";input.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      await driver.click(toolbar + " [data-pick=pink]");
      const clickParagraph = async (text) => {
        const point = await driver.evaluate(`(() => {
          const p=Array.from(document.querySelectorAll('.viewer-pane .markdown-body p')).find(el=>el.textContent===${JSON.stringify(text)});
          const rect=p.getBoundingClientRect();return {x:rect.left+8,y:rect.top+8};
        })()`);
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          ...point,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 1,
          ...point,
        });
      };
      await clickParagraph("本文だけの文書です。");
      await driver.waitFor(
        "document.querySelector('.annotations') && !document.querySelector('.annotations article')"
      );
      await clickParagraph("設定は当日から反映されます。");
      await driver.waitFor(
        "document.querySelector('[data-annotation-toolbar] textarea')?.value==='編集中のメモ' && document.querySelector('[data-pick=pink][aria-pressed=true]')"
      );
    } finally {
      client.close();
    }
  });

  const unexpectedErrors = diagnostics.errors.filter(
    (message) =>
      !message.includes(mermaidPolicyProbeUrl) || !message.includes("Content Security Policy")
  );
  assert.deepEqual(unexpectedErrors, [], `ブラウザエラー: ${unexpectedErrors.join("\n")}`);
} catch (error) {
  failed = true;
  globalThis.console.error(error);
  try {
    await driver.screenshot(path.join(artifactsDir, "failure.png"));
  } catch (screenshotError) {
    globalThis.console.error("失敗時スクリーンショットを保存できませんでした:", screenshotError);
  }
  globalThis.process.exitCode = 1;
} finally {
  diagnostics?.close();
  await terminateProcessTree(child?.pid);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (!failed) globalThis.console.log("WebView2 smoke tests passed.");
}
