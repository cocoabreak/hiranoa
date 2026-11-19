import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  WebView2Driver,
  findFreePort,
  launchTauriDev,
  terminateProcessTree,
} from "../scripts/webview2-driver.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(appDir, "e2e/artifacts/history");
const work = mkdtempSync(path.join(os.tmpdir(), "hiranoa-history-e2e-"));
const repo = path.join(work, "fixtures", "repo");
const doc = path.join(repo, "docs", "guide.md");
const asset = path.join(repo, "docs/assets/example.svg");
mkdirSync(path.dirname(asset), { recursive: true });
mkdirSync(artifacts, { recursive: true });
const environment = Object.fromEntries(
  Object.entries(globalThis.process.env).filter(([key]) => !key.startsWith("GIT_"))
);
Object.assign(environment, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: globalThis.process.platform === "win32" ? "NUL" : "/dev/null",
});
function git(...args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: repo, env: environment, encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function markdown(timeout, extra) {
  return (
    `---\ntitle: Guide\n---\n# Connection guide\n\nTimeout: ${timeout} seconds.\n\n${extra}\n\n[Jump to last step](#step-34) · [Other document](../secret.md)\n\n![Versioned image](assets/example.svg)\n\n\`\`\`mermaid\ngraph LR\n  A[Start] --> B[Done]\n\`\`\`\n\nMath: $\\frac{1}{2}$.\n\n` +
    '\n```mermaid\n%%{init: {"themeCSS":".node rect {fill:url(https://example.invalid/history-probe.svg)}"}}%%\nflowchart TD\nA[probe]\n```\n\n' +
    `| Setting | Package name |\n| --- | --- |\n| Theme | ${"Example".repeat(40)} |\n\n` +
    Array.from({ length: 35 }, (_, i) => `## Step ${i}\n\nRead section ${i}.\n`).join("\n") +
    `\nRead [options][ref] and this note[^note].\n\n[ref]: https://example.invalid/${timeout}\n\n[^note]: Timeout note ${timeout}.\n`
  );
}
const svg = (color, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="72"><rect width="160" height="72" fill="${color}"/><text x="12" y="40" fill="white">${label}</text></svg>`;
git("init");
writeFileSync(doc, markdown(30, "Legacy settings are accepted."));
writeFileSync(asset, svg("#995444", "old-image"));
git("add", ".");
git("commit", "-m", "Initial guide");
const old = git("rev-parse", "HEAD");
writeFileSync(doc, markdown(60, "Retry up to 3 times."));
writeFileSync(asset, svg("#446699", "new-image"));
git("add", ".");
git("commit", "-m", "Update guide");
const latest = git("rev-parse", "HEAD");
const looseObjects = globalThis.process.argv.includes("--loose-objects");
if (!looseObjects) git("gc", "--prune=now");
globalThis.console.log(`Testing Git history with ${looseObjects ? "loose" : "packed"} objects`);
writeFileSync(doc, markdown(90, "Retry up to 3 times."));
writeFileSync(path.join(repo, "secret.md"), "Outside document folder");
const indexBefore = readFileSync(path.join(repo, ".git/index"));
const headBefore = readFileSync(path.join(repo, ".git/HEAD"));
const port = await findFreePort();
const driver = new WebView2Driver({ port });
const stateDir = path.join(work, "state");
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  path.join(stateDir, "settings.json"),
  JSON.stringify({ settings: { language: "en", checkForUpdatesOnStartup: false } })
);
const nativeConsent = globalThis.process.argv.includes("--native-consent");
if (nativeConsent) delete globalThis.process.env.HIRANOA_E2E_GIT_HISTORY_APPROVE;
else globalThis.process.env.HIRANOA_E2E_GIT_HISTORY_APPROVE = "1";
let child, diagnostics, network;
const requests = [];
const evaluate = (code) => driver.evaluate(code);
const waitReady = () =>
  driver.waitFor(
    `document.querySelector('.history-view')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.history-view [role=alert]')`,
    { timeoutMs: nativeConsent ? 120000 : 30000 }
  );
const openHistory = () =>
  evaluate(
    `(async()=>{(await import('/src/lib/commands/registry.ts')).runCommand('history.compare')})()`
  );
const select = async (index, value) =>
  evaluate(
    `(()=>{const el=document.querySelectorAll('.history-view select')[${index}];el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`
  );
const button = async (name) => {
  const result = await evaluate(
    `(()=>{const el=[...document.querySelectorAll('.history-view button')].find(el=>el.textContent.trim()===${JSON.stringify(name)});if(!el||el.disabled)return false;el.click();return true})()`
  );
  assert.equal(result, true, name);
};
try {
  child = launchTauriDev({
    appDir,
    port,
    profileDir: path.join(work, "profile"),
    stateDir,
    logPath: path.join(artifacts, "tauri.log"),
  });
  await driver.waitForCdp();
  diagnostics = await driver.observeDiagnostics();
  network = await driver.connect({
    onEvent: (event) => {
      if (event.method === "Network.requestWillBeSent") requests.push(event.params.request.url);
    },
  });
  await network.send("Network.enable");
  await driver.waitFor("!!window.__e2e", { timeoutMs: 60000 });
  await evaluate(`window.__e2e.openMarkdownFile(${JSON.stringify(doc)})`);
  await driver.waitFor(
    `document.querySelector('[role=main]')?.textContent.includes('Timeout: 90')`
  );
  const original = await evaluate(
    `(async()=>({tabs:(await import('/src/lib/stores/tab.svelte.ts')).tabStore.allTabs.map(t=>t.id),panes:[...(await import('/src/lib/stores/workspace.svelte.ts')).workspaceStore.paneIds]}))()`
  );
  if (nativeConsent) {
    await openHistory();
    await driver.waitFor("document.querySelector('.history-view') !== null");
    globalThis.console.log("Waiting for No in the native Git history dialog");
    await driver.waitFor("document.querySelector('.history-view') === null", {
      timeoutMs: 120000,
    });
    assert.equal(
      await evaluate(`document.querySelector('[role=main]')?.textContent.includes('Timeout: 90')`),
      true
    );
    globalThis.console.log("PASS rejecting Git history leaves the original preview visible");
    const control = createInterface({
      input: globalThis.process.stdin,
      output: globalThis.process.stdout,
    });
    try {
      await control.question("Press Enter to open the native approval dialog again. ");
    } finally {
      control.close();
    }
  }
  await openHistory();
  if (nativeConsent) globalThis.console.log("Waiting for Yes in the native Git history dialog");
  await waitReady();
  assert.equal(
    await evaluate(`document.querySelectorAll('.history-view .history-document').length`),
    2
  );
  await driver.waitFor(`document.querySelector('.history-view .history-word-change') !== null`);
  assert.deepEqual(
    await evaluate(
      `Array.from(document.querySelectorAll('.history-pane'), pane => {
        const document = pane.querySelector('.history-document');
        const version = pane.querySelector('.history-version');
        pane.scrollLeft = 80;
        const result = {
          contain: getComputedStyle(pane).contain,
          isolation: getComputedStyle(document).isolation,
          canScrollWideTable: pane.scrollLeft > 0 && pane.scrollWidth > pane.clientWidth,
          headerOnTop: getComputedStyle(version).zIndex === "10"
        };
        pane.scrollLeft = 0;
        return result;
      })`
    ),
    Array.from({ length: 2 }, () => ({
      contain: "paint",
      isolation: "isolate",
      canScrollWideTable: true,
      headerOnTop: true,
    }))
  );
  await driver.waitFor(
    `document.querySelector('.history-gutter path')?.getAttribute('d')?.length > 10`
  );
  assert.equal(
    await evaluate(
      `(async()=>{const {invoke}=await import('/node_modules/@tauri-apps/api/core.js');return invoke('is_path_allowed',{path:${JSON.stringify(path.join(repo, "secret.md"))}})})()`
    ),
    false
  );
  globalThis.console.log(
    "PASS history view / word changes / connection band / no folder trust expansion"
  );
  await driver.waitFor(
    `document.querySelectorAll('.history-document img[src^="data:"]').length === 2`
  );
  writeFileSync(asset, svg("#336655", "refreshed-image"));
  await button("Refresh comparison");
  await waitReady();
  await driver.waitFor(
    `(()=>{const img=document.querySelectorAll('.history-document img')[1];return img?.src.startsWith('data:')&&atob(img.src.split(',')[1]).includes('refreshed-image')})()`
  );
  globalThis.console.log("PASS refresh reads the current working image");
  await select(0, old);
  await waitReady();
  await select(1, latest);
  await waitReady();
  await driver.waitFor(
    `document.querySelector('.history-document')?.textContent.includes('Timeout: 30')`
  );
  await driver.waitFor(
    `document.querySelectorAll('.history-document')[1]?.textContent.includes('Timeout: 60')`
  );
  await driver.waitFor(
    `document.querySelectorAll('.history-document img[src^="data:"]').length === 2`
  );
  const imageVersions = await evaluate(
    `([...document.querySelectorAll('.history-document img')].map(el=>atob(el.src.split(',')[1])))`
  );
  assert.ok(imageVersions[0].includes("old-image"));
  assert.ok(imageVersions[1].includes("new-image"));
  assert.equal(
    await evaluate(`document.querySelectorAll('.history-definition.history-changed').length`),
    2
  );
  assert.equal(
    await evaluate(
      `document.querySelectorAll('.history-document .footnotes .history-changed').length`
    ),
    2
  );
  await driver.waitFor(
    `[...document.querySelectorAll('.history-document')].every(el=>el.querySelector('.mermaid-rendered svg'))`,
    { timeoutMs: 30000 }
  );
  assert.ok(await evaluate(`document.querySelectorAll('.history-document .katex').length >= 2`));
  await driver.waitFor(
    `document.querySelectorAll('.history-document [data-viewer-plugin].mermaid-error-container').length === 2`
  );
  assert.equal(
    requests.some((url) => url.includes("history-probe.svg")),
    false
  );
  const appPage = await evaluate("location.href");
  assert.deepEqual(
    await evaluate(`Array.from(document.querySelectorAll('.history-document'), root => ({
      local: Array.from(root.querySelectorAll('a')).find(link => link.textContent === 'Other document')?.getAttribute('href'),
      external: Array.from(root.querySelectorAll('a')).find(link => link.textContent === 'options')?.getAttribute('href'),
    }))`),
    [
      { local: null, external: null },
      { local: null, external: null },
    ]
  );
  const historyAnchor = '.history-document a[href="#step-34"]';
  assert.equal(await driver.click(historyAnchor), "OK");
  await driver.waitFor("document.querySelector('.history-pane').scrollTop > 1000");
  assert.equal(await evaluate("location.href"), appPage);
  assert.equal(
    await evaluate(`document.querySelector(${JSON.stringify(historyAnchor)}).dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    )`),
    false
  );
  await evaluate(`document.querySelectorAll('.history-pane').forEach(pane => pane.scrollTop = 0)`);
  globalThis.console.log("PASS history anchors stay in the comparison; other links are disabled");
  await driver.screenshot(path.join(artifacts, "visual-diff.png"));
  const initialBand = await evaluate(
    `document.querySelector('.history-gutter path').getAttribute('d')`
  );
  await evaluate(
    `(()=>{const box=document.querySelector('.history-view input[type=checkbox]');box.checked=false;box.dispatchEvent(new Event('change',{bubbles:true}));document.querySelectorAll('.history-pane')[1].scrollTop=90})()`
  );
  await driver.waitFor(
    `document.querySelector('.history-gutter path')?.getAttribute('d') !== ${JSON.stringify(initialBand)}`
  );
  await driver.screenshot(path.join(artifacts, "connection-flow.png"));
  await evaluate(
    `(()=>{for(const pane of document.querySelectorAll('.history-pane'))pane.scrollTop=0;const box=document.querySelector('.history-view input[type=checkbox]');box.checked=true;box.dispatchEvent(new Event('change',{bubbles:true}))})()`
  );
  globalThis.console.log("PASS commit-to-commit / versioned images / Mermaid and TeX");
  await button("Source diff");
  await driver.waitFor(`document.querySelectorAll('[data-source-row]').length > 10`);
  assert.ok(
    await evaluate(
      `document.querySelector('.history-source-row.history-changed')?.textContent.includes('Timeout')`
    )
  );
  await button("Visual diff");
  await evaluate(`(()=>{const p=document.querySelector('.history-pane');p.scrollTop=700})()`);
  await driver.waitFor(`document.querySelectorAll('.history-pane')[1].scrollTop > 200`);
  const client = await driver.connect();
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 700,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await driver.waitFor(
    `getComputedStyle(document.querySelector('.history-gutter')).display === 'none'`
  );
  client.close();
  globalThis.console.log("PASS source diff / corresponding scroll / narrow layout");
  await button("Close comparison");
  await driver.waitFor(`!document.querySelector('.history-view')`);
  const after = await evaluate(
    `(async()=>({tabs:(await import('/src/lib/stores/tab.svelte.ts')).tabStore.allTabs.map(t=>t.id),panes:[...(await import('/src/lib/stores/workspace.svelte.ts')).workspaceStore.paneIds]}))()`
  );
  assert.deepEqual(after, original);
  assert.deepEqual(readFileSync(path.join(repo, ".git/index")), indexBefore);
  assert.deepEqual(readFileSync(path.join(repo, ".git/HEAD")), headBefore);
  assert.deepEqual(diagnostics.errors, []);
  globalThis.console.log("PASS original workspace preserved / Git index and HEAD unchanged");
} catch (error) {
  globalThis.process.exitCode = 1;
  globalThis.console.error(error);
  try {
    globalThis.console.error(
      await evaluate(
        `([...document.querySelectorAll('.history-document')].map(el=>({diagrams:[...el.querySelectorAll('[data-viewer-plugin]')].map(d=>({class:d.className,html:d.innerHTML.slice(0,300)}))})))`
      )
    );
    await driver.screenshot(path.join(artifacts, "failure.png"));
  } catch {
    /* App may not have started. */
  }
} finally {
  diagnostics?.close();
  network?.close();
  await terminateProcessTree(child?.pid);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
