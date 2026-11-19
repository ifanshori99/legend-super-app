// Text catalog access for components: const t = useT(); t("common.save").
// Tenant overrides (PRD §7 "override per tenant") are passed to I18nProvider
// once tenant config is resolved; until then the Indonesian catalog applies.
//
// The catalog is split per route area (legend-nmn9j, area-manifest.ts in
// @starter/shared). `core` ships with the app; an area's chunk is loaded by
// its layout's beforeLoad (withI18nChunks) before the screen renders. A key
// whose chunk is not loaded yet shows as the key for a moment, loads its
// chunk, and renders again (see loadOwnerOf).
import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AREA_CHUNKS,
  CATALOG_CHUNKS,
  chunkOfKey,
  createTranslator,
  registerDefaultCatalog,
  type CatalogChunk,
  type CatalogNode,
  type MessageOverrides,
  type Translate,
} from "@starter/shared/i18n/runtime";
import { messages as coreMessages } from "virtual:i18n/core";

type AreaChunk = Exclude<CatalogChunk, "core">;

// Literal specifiers: the bundler turns each one into its own file.
const AREA_LOADERS: Record<
  AreaChunk,
  () => Promise<{ messages: CatalogNode }>
> = {
  public: () => import("virtual:i18n/public"),
  customer: () => import("virtual:i18n/customer"),
  ops: () => import("virtual:i18n/ops"),
  kitchen: () => import("virtual:i18n/kitchen"),
  kelola: () => import("virtual:i18n/kelola"),
  owner: () => import("virtual:i18n/owner"),
  shareholder: () => import("virtual:i18n/shareholder"),
  karyawan: () => import("virtual:i18n/karyawan"),
  platform: () => import("virtual:i18n/platform"),
};

// Module-level store of the chunks fetched so far. On the server it is shared
// by every request and only grows, so it must not decide what a request
// renders: I18nProvider reads core plus the chunks named for that request
// (catalogOf), which is what the client loads before it hydrates.
const loaded = new Map<CatalogChunk, CatalogNode>([["core", coreMessages]]);
const pending = new Map<CatalogChunk, Promise<void>>();
const listeners = new Set<() => void>();
let catalog: CatalogNode = coreMessages;

registerDefaultCatalog(() => catalog);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getCatalog = () => catalog;

function loadChunk(chunk: CatalogChunk): Promise<void> {
  if (loaded.has(chunk) || chunk === "core") return Promise.resolve();
  let request = pending.get(chunk);
  if (!request) {
    request = AREA_LOADERS[chunk]().then(
      (module) => {
        pending.delete(chunk);
        loaded.set(chunk, module.messages);
        // Namespaces never repeat across chunks, so a shallow merge is exact.
        catalog = Object.assign({}, ...loaded.values());
        for (const listener of listeners) listener();
      },
      (error: unknown) => {
        pending.delete(chunk);
        throw error;
      },
    );
    pending.set(chunk, request);
  }
  return request;
}

/** Loads catalog chunks (idempotent). Rejects when a chunk cannot be fetched. */
export async function loadI18nChunks(
  chunks: readonly CatalogChunk[],
): Promise<void> {
  await Promise.all(chunks.map(loadChunk));
}

/** Loads the chunks, then hands `value` back: for `beforeLoad: () => ...`. */
export async function withI18nChunks<T>(
  chunks: readonly CatalogChunk[],
  value: T,
): Promise<T> {
  await loadI18nChunks(chunks);
  return value;
}

/** Area chunks for TanStack route ids such as "/_kelola/kelola/menu". */
export function chunksForRouteIds(routeIds: readonly string[]): AreaChunk[] {
  const found = new Set<AreaChunk>();
  for (const routeId of routeIds) {
    const area = /^\/_([a-z]+)(?:\/|$)/.exec(routeId)?.[1];
    if (area && (AREA_CHUNKS as readonly string[]).includes(area))
      found.add(area as AreaChunk);
  }
  return [...found];
}

function parseChunks(list: string | undefined): CatalogChunk[] {
  return (list?.split(",") ?? []).filter((name): name is CatalogChunk =>
    (CATALOG_CHUNKS as readonly string[]).includes(name),
  );
}

// A missing key is the signal that its chunk may not be loaded: fetch the
// owner and render again once it arrives. Fire and forget; a failed fetch
// leaves the key visible, as any other gap in the catalog.
function loadOwnerOf(key: string): void {
  const owner = chunkOfKey(key);
  if (owner !== "core" && !loaded.has(owner))
    loadChunk(owner).catch(() => undefined);
}

function withFallback(translate: Translate): Translate {
  return (key, vars) => {
    const text = translate(key, vars);
    if (text === key) loadOwnerOf(key);
    return text;
  };
}

const liveT = withFallback(createTranslator());

/**
 * Translator for code outside React (route head(), module-level data): reads
 * the messages loaded at call time, without tenant overrides.
 */
export const defaultT: Translate = liveT;

const I18nContext = createContext<Translate>(defaultT);

// Core plus the named chunks that are loaded; nothing else the store holds.
function catalogOf(chunks: readonly CatalogChunk[]): CatalogNode {
  return Object.assign(
    {},
    coreMessages,
    ...chunks.map((chunk) => loaded.get(chunk)),
  );
}

export function I18nProvider({
  overrides,
  chunks,
  children,
}: {
  overrides?: MessageOverrides;
  /** Chunks of the matched areas, comma separated (`data-i18n-chunks`). */
  chunks?: string;
  children: ReactNode;
}) {
  const live = useSyncExternalStore(subscribe, getCatalog, getCatalog);
  // Server render: only this request's chunks. Browser: everything loaded, so
  // a screen reached later (or a lazily fetched chunk) renders in full.
  const messages = useMemo(
    () =>
      typeof document === "undefined" ? catalogOf(parseChunks(chunks)) : live,
    [live, chunks],
  );
  const t = useMemo(
    () =>
      overrides || messages !== coreMessages
        ? withFallback(createTranslator(messages, overrides))
        : defaultT,
    [messages, overrides],
  );
  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  return useContext(I18nContext);
}

// Hydration must find the chunks the server rendered with, or the first
// client render would print keys where the server printed text. The document
// root carries them (`data-i18n-chunks`, set in routes/__root.tsx), and this
// module does not finish evaluating until they are loaded, which holds the
// client entry (and so hydration) back. A failed fetch falls through to the
// loadOwnerOf safety net.
if (typeof document !== "undefined") {
  await loadI18nChunks(
    parseChunks(document.documentElement.dataset.i18nChunks),
  ).catch(() => undefined);
}
