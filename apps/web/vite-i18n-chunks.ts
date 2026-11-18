// Vite plugin behind the per-area text catalog (legend-nmn9j). It serves one
// virtual module per chunk, `virtual:i18n/<chunk>` (chunk = core or a route
// area), each exporting `messages`: the catalog namespaces that
// packages/shared/src/i18n/area-manifest.ts assigns to that chunk. Nothing is
// generated into the repository.
//
// - build: the catalog is read once and each chunk is emitted as JSON, so a
//   chunk holds only its own namespaces and the bundler can code-split it.
// - dev server: a chunk imports the real catalog module and picks its
//   namespaces, so editing a text file still hot-reloads.
// - split: false (unit tests): `core` is the whole catalog and the area chunks
//   are empty, so a component rendered without loading chunks sees every text.
//
// The same plugin keeps the whole catalog out of the web bundle (split: true):
// every import that resolves to packages/shared/src/i18n/index.ts, whoever
// writes it (web code through `@starter/shared/i18n`, or shared code such as
// text/schemas.ts through a relative path), is redirected to i18n/runtime.ts.
// That file has the same value exports minus the catalog; `messagesId` and
// `isMessageKey` there read the chunks loaded so far. The API and the unit
// tests do not use this plugin and keep index.ts.
//
// The consumer is apps/web/src/components/i18n.tsx.
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";
import {
  AREA_MANIFEST,
  CATALOG_CHUNKS,
  chunkOfNamespace,
  type CatalogChunk,
} from "../../packages/shared/src/i18n/area-manifest.ts";

const PREFIX = "virtual:i18n/";
const RESOLVED_PREFIX = `\0${PREFIX}`;
const I18N_DIR = resolve(import.meta.dirname, "../../packages/shared/src/i18n");
const INDEX_MODULE = resolve(I18N_DIR, "index");
const RUNTIME_FILE = resolve(I18N_DIR, "runtime.ts");
const CATALOG_FILE = JSON.stringify(
  resolve(import.meta.dirname, "../../packages/shared/src/i18n/messages/id.ts"),
);

// Whole catalog, for unit tests.
function unsplitModule(chunk: CatalogChunk): string {
  return chunk === "core"
    ? `export { id as messages } from ${CATALOG_FILE};`
    : "export const messages = {};";
}

// Dev server: pick namespaces from the live catalog module (hot reload).
function devModule(chunk: CatalogChunk): string {
  const lines = [`import { id } from ${CATALOG_FILE};`];
  if (chunk === "core") {
    lines.push(
      `const area = new Set(${JSON.stringify(Object.keys(AREA_MANIFEST))});`,
      "export const messages = Object.fromEntries(",
      "  Object.entries(id).filter(([namespace]) => !area.has(namespace)),",
      ");",
    );
  } else {
    const own = Object.entries(AREA_MANIFEST)
      .filter(([, owner]) => owner === chunk)
      .map(([namespace]) => namespace);
    lines.push(
      `const namespaces = ${JSON.stringify(own)};`,
      "export const messages = Object.fromEntries(",
      "  namespaces.map((namespace) => [namespace, id[namespace]]),",
      ");",
    );
  }
  return lines.join("\n");
}

export function i18nChunks({ split }: { split: boolean }): Plugin {
  let isBuild = false;
  let catalog: Promise<Record<string, unknown>> | undefined;

  // Build only. The config loader bundles this relative import, so Node never
  // has to load the catalog's TypeScript from the workspace package itself.
  const readCatalog = () =>
    (catalog ??= import("../../packages/shared/src/i18n/messages/id.ts").then(
      (module) => (module as unknown as { id: Record<string, unknown> }).id,
    ));

  return {
    name: "legend-i18n-chunks",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    // Before Vite's own resolver, so the catalog barrel never gets resolved.
    enforce: "pre",
    resolveId(source, importer) {
      if (split) {
        // Same path for both specifiers: one runtime module, one store.
        if (
          source === "@starter/shared/i18n" ||
          source === "@starter/shared/i18n/runtime"
        )
          return RUNTIME_FILE;
        if (
          importer &&
          !importer.startsWith("\0") &&
          /(?:^|\/)i18n\/index(?:\.ts)?$/.test(source) &&
          resolve(dirname(importer), source).replace(/\.ts$/, "") ===
            INDEX_MODULE
        )
          return RUNTIME_FILE;
      }
      if (!source.startsWith(PREFIX)) return null;
      const chunk = source.slice(PREFIX.length);
      return (CATALOG_CHUNKS as readonly string[]).includes(chunk)
        ? `\0${source}`
        : null;
    },
    async load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null;
      const chunk = id.slice(RESOLVED_PREFIX.length) as CatalogChunk;
      if (!split) return unsplitModule(chunk);
      if (!isBuild) return devModule(chunk);

      const full = await readCatalog();
      for (const namespace of Object.keys(AREA_MANIFEST))
        if (!Object.hasOwn(full, namespace))
          this.error(
            `area-manifest.ts lists "${namespace}", which is not a catalog namespace`,
          );
      const own = Object.fromEntries(
        Object.entries(full).filter(
          ([namespace]) => chunkOfNamespace(namespace) === chunk,
        ),
      );
      return `export const messages = JSON.parse(${JSON.stringify(JSON.stringify(own))});`;
    },
  };
}
