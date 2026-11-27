// O5 follow-up (Keputusan CTO 27 Nov, point 6 a): the service worker keeps
// every chunk of the /pos routes so a client navigation on the offline tablet
// finds its code. The build lists them: the chunk of each /pos route and
// everything it imports, statically or lazily.
import { posPrecacheList } from "../vite-pos-precache";

type Chunk = {
  type: "chunk";
  name: string;
  fileName: string;
  imports: string[];
  dynamicImports: string[];
  viteMetadata?: { importedCss: Set<string> };
};

const chunk = (
  name: string,
  imports: string[] = [],
  dynamicImports: string[] = [],
  css: string[] = [],
): [string, Chunk] => [
  `assets/${name}.js`,
  {
    type: "chunk",
    name,
    fileName: `assets/${name}.js`,
    imports: imports.map((n) => `assets/${n}.js`),
    dynamicImports: dynamicImports.map((n) => `assets/${n}.js`),
    viteMetadata: { importedCss: new Set(css) },
  },
];

describe("posPrecacheList", () => {
  const bundle = Object.fromEntries([
    chunk("pos.shift.tutup", ["shift-parts"], ["blind-count"]),
    chunk("pos.kasir", ["shared"], [], ["assets/kasir.css"]),
    chunk("shift-parts", ["shared"]),
    chunk("blind-count", ["shared"]),
    chunk("shared"),
    chunk("kelola.laporan", ["shared", "recharts"]),
    chunk("recharts"),
    chunk("pos-offline", ["shared"]),
  ]);

  it("lists the /pos route chunks and everything they import", () => {
    expect(posPrecacheList(bundle)).toEqual([
      "/assets/blind-count.js",
      "/assets/kasir.css",
      "/assets/pos.kasir.js",
      "/assets/pos.shift.tutup.js",
      "/assets/shared.js",
      "/assets/shift-parts.js",
    ]);
  });

  it("leaves the code of other areas out", () => {
    const list = posPrecacheList(bundle);
    expect(list).not.toContain("/assets/kelola.laporan.js");
    expect(list).not.toContain("/assets/recharts.js");
  });
});
