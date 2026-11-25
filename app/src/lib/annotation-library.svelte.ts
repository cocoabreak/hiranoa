import { maxNotes, serializeExport, type Annotation } from "./annotations";

interface Book {
  id: string;
  location: string;
  title: string;
  revision: string;
  annotations: Annotation[];
  count: number;
}
export type OpenBook = Pick<Book, "location" | "title" | "revision">;
const storeName = "documents";
let opening: Promise<IDBDatabase> | undefined;
let version = $state(0);
export const annotationLibrary = {
  get version() {
    return version;
  },
};

function database() {
  if (!opening)
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("hiranoa-annotations", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(storeName, { keyPath: "location" });
        store.createIndex("catalog", ["revision", "title", "id", "count"]);
      };
      request.onerror = () => {
        opening = undefined;
        reject(request.error);
      };
      request.onsuccess = () => resolve(request.result);
    });
  return opening;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readBook(location: string): Promise<Book | undefined> {
  const db = await database();
  return result(db.transaction(storeName).objectStore(storeName).get(location));
}

type Candidate = Pick<Book, "location" | "title" | "id" | "count">;
export async function otherBooks(current: OpenBook, all: boolean): Promise<Candidate[]> {
  const store = (await database()).transaction(storeName).objectStore(storeName);
  const range = all ? undefined : IDBKeyRange.bound([current.revision], [current.revision, []]);
  const request = store.index("catalog").openKeyCursor(range);
  return new Promise((resolve, reject) => {
    const candidates: Candidate[] = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(candidates);
        return;
      }
      const location = cursor.primaryKey as string;
      const [, title, id, count] = cursor.key as [string, string, string, number];
      if (location !== current.location) candidates.push({ location, title, id, count });
      cursor.continue();
    };
  });
}

export async function rememberRevision(current: OpenBook, valid: () => boolean) {
  const saved = await readBook(current.location);
  if (!saved || saved.revision === current.revision || !valid()) return;
  await write(async (store) => {
    const latest: Book | undefined = await result(store.get(current.location));
    if (valid() && latest?.id === saved.id && latest.revision === saved.revision)
      store.put({ ...latest, revision: current.revision });
  });
}

async function write(action: (store: IDBObjectStore) => Promise<void>) {
  const transaction = (await database()).transaction(storeName, "readwrite");
  const completed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? Error("transaction aborted"));
  });
  try {
    await action(transaction.objectStore(storeName));
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* A failed request already aborted it. */
    }
    await completed.catch(() => {});
    throw error;
  }
  await completed;
  version++;
}

export function changeBook(current: OpenBook, change: (notes: Annotation[]) => Annotation[]) {
  return write(async (store) => {
    const old: Book | undefined = await result(store.get(current.location));
    const annotations = change(old?.annotations ?? []);
    if (annotations.length > maxNotes) throw Error("annotation limit");
    serializeExport(annotations);
    if (!annotations.length) store.delete(current.location);
    else
      store.put({
        ...current,
        id: old?.id ?? crypto.randomUUID(),
        annotations,
        count: annotations.length,
      });
  });
}

export function attachBook(
  current: OpenBook,
  source: Pick<Book, "location" | "id">,
  move: boolean
) {
  return write(async (store) => {
    const old: Book | undefined = await result(store.get(source.location));
    if (!old || old.id !== source.id || (await result(store.get(current.location))))
      throw Error("document changed");
    const annotations = move
      ? old.annotations
      : old.annotations.map((n) => ({ ...n, id: crypto.randomUUID() }));
    store.put({
      ...current,
      id: move ? old.id : crypto.randomUUID(),
      annotations,
      count: annotations.length,
    });
    if (move) store.delete(source.location);
  });
}
