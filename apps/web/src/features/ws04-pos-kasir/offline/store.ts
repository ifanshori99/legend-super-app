// O3 local storage of the offline POS (bead legend-wasr7.7;
// docs/design/cloud-only-release.md §2). One IndexedDB database per tablet
// holds, per outlet: the kit the cloud issued (with the local receipt
// counter), the queue of offline sales not yet settled by the cloud, and the
// sales set aside for a supervisor ("perlu dicek").
//
// - Every write is one transaction over all stores, so taking the next `L`
//   number and appending its sale either both land or neither does: a crash
//   between them never leaves a gap or a number used twice.
// - A queued sale is never edited; it is only deleted once the cloud settled
//   it (ingested, held, duplicate) or moved to `parked`.
// - The backend is injected: the browser uses IndexedDB, Node tests use the
//   in-memory backend (same transaction semantics, survives a "reload" when a
//   new store is opened over the same backend).
import type { OfflineSaleEvent, PosOfflineKit } from "@starter/shared/pos";

export type StoreName = "kits" | "queue" | "parked";

export type KitRecord = {
  outletId: string;
  kit: PosOfflineKit;
  /** Last `L` number this tablet used on `kit.receiptRun.sequenceId`. */
  counter: number;
  /** Review O3 P2 4: the kit's shift closed; no sale is taken on it. */
  closed?: boolean;
};

export type QueueRecord = {
  eventId: string;
  outletId: string;
  event: OfflineSaleEvent;
  queuedAt: string;
};

export type ParkedRecord = {
  eventId: string;
  outletId: string;
  event: OfflineSaleEvent;
  /** Error code of the cloud's answer (`OFFLINE_EVENT_CONFLICT`). */
  reason: string;
  parkedAt: string;
};

type RecordOf<S extends StoreName> = S extends "kits"
  ? KitRecord
  : S extends "queue"
    ? QueueRecord
    : ParkedRecord;

const KEY_OF: { [S in StoreName]: (value: RecordOf<S>) => string } = {
  kits: (value) => value.outletId,
  queue: (value) => value.eventId,
  parked: (value) => value.eventId,
};

export interface OfflineTx {
  get<S extends StoreName>(
    store: S,
    key: string,
  ): Promise<RecordOf<S> | undefined>;
  getAll<S extends StoreName>(store: S): Promise<RecordOf<S>[]>;
  put<S extends StoreName>(store: S, value: RecordOf<S>): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
}

export interface OfflineBackend {
  /**
   * Runs `body` in one transaction over every store. A readwrite body that
   * throws (or a crash) leaves nothing behind.
   */
  run<T>(
    mode: "readonly" | "readwrite",
    body: (tx: OfflineTx) => Promise<T>,
  ): Promise<T>;
}

/** The browser cannot keep offline sales: the tablet must not sell offline. */
export const OFFLINE_STORAGE_UNAVAILABLE = "OFFLINE_STORAGE_UNAVAILABLE";

// ---- In-memory backend (tests) ------------------------------------------------

type Tables = { [S in StoreName]: Map<string, RecordOf<S>> };

const emptyTables = (): Tables => ({
  kits: new Map(),
  queue: new Map(),
  parked: new Map(),
});

const copyTables = (tables: Tables): Tables => ({
  kits: new Map(structuredClone([...tables.kits])),
  queue: new Map(structuredClone([...tables.queue])),
  parked: new Map(structuredClone([...tables.parked])),
});

/**
 * Same contract as IndexedDB: transactions run one at a time, a readwrite
 * body works on a copy that replaces the tables only when it resolves.
 */
export function createMemoryOfflineBackend(): OfflineBackend & {
  /** Test hook: the stored rows, as a reload would read them. */
  snapshot(): Tables;
} {
  let tables = emptyTables();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    snapshot: () => copyTables(tables),
    run(mode, body) {
      const next = chain.then(async () => {
        const work = copyTables(tables);
        const tx: OfflineTx = {
          get: async (store, key) =>
            structuredClone(work[store].get(key)) as never,
          getAll: async (store) =>
            structuredClone([...work[store].values()]) as never,
          put: async (store, value) => {
            if (mode === "readonly") throw new Error("readonly transaction");
            const key = (KEY_OF[store] as (value: unknown) => string)(value);
            (work[store] as Map<string, unknown>).set(
              key,
              structuredClone(value),
            );
          },
          delete: async (store, key) => {
            if (mode === "readonly") throw new Error("readonly transaction");
            work[store].delete(key);
          },
        };
        const result = await body(tx);
        if (mode === "readwrite") tables = work;
        return result;
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
}

// ---- IndexedDB backend (browser) ------------------------------------------------

const DB_NAME = "legend-pos-offline";
const DB_VERSION = 1;
const STORES: StoreName[] = ["kits", "queue", "parked"];

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains("kits"))
        database.createObjectStore("kits", { keyPath: "outletId" });
      if (!database.objectStoreNames.contains("queue"))
        database.createObjectStore("queue", { keyPath: "eventId" });
      if (!database.objectStoreNames.contains("parked"))
        database.createObjectStore("parked", { keyPath: "eventId" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error(OFFLINE_STORAGE_UNAVAILABLE));
  });
}

/**
 * IndexedDB backend. Asks the browser to keep the storage persistent (no
 * eviction under storage pressure); a refusal is not fatal, the queue still
 * works, but an evicted store means a new epoch at the next kit.
 */
export function createIndexedDbBackend(
  factory: IDBFactory = globalThis.indexedDB,
): OfflineBackend {
  let database: Promise<IDBDatabase> | null = null;
  const connect = () => {
    if (!factory) return Promise.reject(new Error(OFFLINE_STORAGE_UNAVAILABLE));
    database ??= openDatabase(factory).then((opened) => {
      // Another tab upgrading the schema: let go, reopen on the next call.
      opened.onversionchange = () => {
        opened.close();
        database = null;
      };
      return opened;
    });
    database.catch(() => {
      database = null;
    });
    return database;
  };
  void globalThis.navigator?.storage?.persist?.().catch(() => false);
  return {
    async run(mode, body) {
      const opened = await connect();
      const transaction = opened.transaction(STORES, mode, {
        durability: "strict",
      });
      const done = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("transaction aborted"));
        transaction.onerror = () => reject(transaction.error);
      });
      const tx: OfflineTx = {
        get: (store, key) => request(transaction.objectStore(store).get(key)),
        getAll: (store) => request(transaction.objectStore(store).getAll()),
        put: async (store, value) => {
          await request(transaction.objectStore(store).put(value));
        },
        delete: async (store, key) => {
          await request(transaction.objectStore(store).delete(key));
        },
      };
      let result: Awaited<ReturnType<typeof body>>;
      try {
        result = await body(tx);
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // Already finished: the abort handler reported it.
        }
        await done.catch(() => undefined);
        throw error;
      }
      await done;
      return result;
    },
  };
}

let shared: OfflineBackend | null | undefined;

/**
 * The tablet's backend, or null where the browser has no IndexedDB (server
 * render, old browser): such a device never queued an offline sale.
 */
export function defaultOfflineBackend(): OfflineBackend | null {
  if (shared === undefined)
    shared =
      typeof globalThis.indexedDB === "undefined"
        ? null
        : createIndexedDbBackend();
  return shared;
}

/** Replaces the tablet's backend (tests; undefined goes back to the default). */
export function setDefaultOfflineBackend(
  backend: OfflineBackend | null | undefined,
): void {
  shared = backend;
}
