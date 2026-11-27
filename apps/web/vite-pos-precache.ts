// O5 follow-up (Keputusan CTO 27 Nov, point 6 a): the build lists every file
// the /pos routes need (their chunks plus everything those import, statically
// or lazily, and their styles) in `pos-precache.json`. The service worker
// (public/sw.js) keeps them, so a client navigation on the offline tablet
// finds its code. Chunks are content-hashed, so a new deploy lists new names.
import type { Plugin } from "vite";

type BundleChunk = {
  type: "chunk";
  name: string;
  fileName: string;
  imports: string[];
  dynamicImports: string[];
  viteMetadata?: { importedCss?: Set<string> };
};

/** Route chunks of the till: `pos.*` file routes (the offline shell is separate). */
const POS_ROUTE = /^pos\./;

/** Sorted URL paths of the /pos route chunks and their whole import closure. */
export function posPrecacheList(
  bundle: Record<string, { type: string } | BundleChunk>,
): string[] {
  const chunks = new Map<string, BundleChunk>();
  for (const item of Object.values(bundle))
    if (item.type === "chunk")
      chunks.set((item as BundleChunk).fileName, item as BundleChunk);
  const seen = new Set<string>();
  const files = new Set<string>();
  const visit = (fileName: string) => {
    if (seen.has(fileName)) return;
    seen.add(fileName);
    const chunk = chunks.get(fileName);
    if (!chunk) return;
    files.add(fileName);
    for (const css of chunk.viteMetadata?.importedCss ?? []) files.add(css);
    for (const next of [...chunk.imports, ...chunk.dynamicImports]) visit(next);
  };
  for (const chunk of chunks.values())
    if (POS_ROUTE.test(chunk.name)) visit(chunk.fileName);
  return [...files].map((file) => `/${file}`).sort();
}

export function posPrecache(): Plugin {
  return {
    name: "legend-pos-precache",
    apply: "build",
    generateBundle(_options, bundle) {
      // Client bundle only: the server build has no browser assets.
      if (this.environment?.name !== "client") return;
      this.emitFile({
        type: "asset",
        fileName: "pos-precache.json",
        source: JSON.stringify(posPrecacheList(bundle as never)),
      });
    },
  };
}
