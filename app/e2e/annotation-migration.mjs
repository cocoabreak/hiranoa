import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

// Run before opening the first document in the smoke test's private WebView profile.
export async function verifyAnnotationMigration(driver, workDir) {
  const file = path.join(workDir, "migration.md").replaceAll("\\", "/");
  const raw = "# Migration\n\nOriginal quote.\n";
  writeFileSync(file, raw);
  const oldBook = await driver.evaluate(`(async () => {
    const { digest } = await import('/src/lib/annotations.ts');
    const revision = await digest(${JSON.stringify(raw)});
    const book = { location: 'legacy-location', title: 'original.md', id: crypto.randomUUID(), revision,
      annotations: [{ id: crypto.randomUUID(), quote: 'Original quote.', before: '', after: '',
        start: 0, revision, color: 'blue',
        memo: 'Preserve this memo.', created: new Date().toISOString() }] };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('hiranoa-annotations', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('documents', { keyPath: 'location' });
        store.createIndex('revision', 'revision');
        store.add(book);
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    return book;
  })()`);
  const lib = "await import('/src/lib/annotation-library.svelte.ts')";
  const readLegacy = () => driver.evaluate(`(async () => (${lib}).readBook('legacy-location'))()`);
  const migrated = {
    ...oldBook,
    count: 1,
    annotations: oldBook.annotations.map((note) => ({ ...note, heading: "", unique: false })),
  };
  assert.deepEqual(await readLegacy(), migrated);
  const roundTrip = await driver.evaluate(`(async () => {
    const { parseExport, serializeExport } = await import('/src/lib/annotations.ts');
    const book = await (${lib}).readBook('legacy-location');
    return parseExport(serializeExport(book.annotations));
  })()`);
  assert.deepEqual(roundTrip, migrated.annotations);

  await driver.evaluate(`window.__e2e.openMarkdownFile(${JSON.stringify(file)})`);
  const launcher = await driver.waitFor(
    "document.querySelector('[data-open-annotations]') ? '[data-open-annotations]' : document.querySelector('[data-notes-tab]') && '[data-notes-tab]'"
  );
  await driver.click(launcher);
  const match = ".annotations [data-match]";
  const copyButton = match + " + div button:last-child";
  await driver.waitFor(`document.querySelector('${copyButton}')`);
  const clearCurrent = `(async () => {
    const library = ${lib};
    const { documentLocation } = await import('/src/lib/annotations.ts');
    const location = await documentLocation({kind:'native', nativePath:${JSON.stringify(file)}}, {path:''});
    const book = await library.readBook(location);
    await library.changeBook(book, notes => notes.filter(n => n.id !== book.annotations[0].id));
  })()`;
  const copy = async () => {
    await driver.click(copyButton);
    await driver.waitFor(
      "document.querySelector('.annotations article p')?.textContent === 'Preserve this memo.'"
    );
  };
  await copy();
  await driver.evaluate(clearCurrent);
  await driver.waitFor(
    `document.querySelector('${match}') && !document.querySelector('.annotations article')`
  );
  assert.equal(
    await driver.evaluate("document.querySelector('.annotations [role=alert]') === null"),
    true
  );

  await copy();
  // Only the automatic candidate lookup after deletion fails. The read and write are real.
  await driver.evaluate(`(() => {
    const open = IDBIndex.prototype.openKeyCursor;
    IDBIndex.prototype.openKeyCursor = function(range, direction) {
      if (this.name === 'catalog') {
        IDBIndex.prototype.openKeyCursor = open;
        throw new DOMException('Test candidate lookup failure', 'UnknownError');
      }
      return open.call(this, range, direction);
    };
  })()`);
  await driver.evaluate(clearCurrent);
  await driver.waitFor(
    "document.querySelector('.annotations [role=alert]') && !document.querySelector('.annotations article')"
  );
  assert.equal(
    await driver.evaluate(
      "Array.from(document.querySelectorAll('[role=alert]')).filter(el => el.textContent.trim()).length"
    ),
    1
  );
  await driver.click(".annotations button[aria-expanded]");
  await driver.waitFor(
    "document.querySelector('.annotations')?.textContent.includes('original.md (1)') && !document.querySelector('.annotations [role=alert]')"
  );
  assert.deepEqual(await readLegacy(), migrated);
  await driver.evaluate("window.__e2e.resetSession()");
}
