// The `?demo=<seed>` switch for the ordering mock. Only the mock engine and the
// ws02-edge mock (status: cloud out of reach on "offline") read the seed
// (VITE_API_MOCK=true); components never do. The seeds feed the
// mockup screens and their states.
//
// Plain TypeScript: Node tests load it directly.

/**
 * "kosong": catalog, tables and calls are empty. "offline": the connection is
 * edge-only and the catalog is the cached one from 14.08. "gagal": the reads
 * fail. "memuat": the reads never finish.
 */
export const ORDER_DEMO_SEEDS = [
  "kosong",
  "offline",
  "gagal",
  "memuat",
] as const;
export type OrderDemoSeed = (typeof ORDER_DEMO_SEEDS)[number];

/** The raw `?demo=` value of the current page; null on the server or without one. */
export function readDemoSeed(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("demo");
  } catch {
    return null;
  }
}

export function orderDemoSeed(raw: string | null): OrderDemoSeed | null {
  return raw !== null && (ORDER_DEMO_SEEDS as readonly string[]).includes(raw)
    ? (raw as OrderDemoSeed)
    : null;
}
