// Catalog sales gate (legend-10nex, founder Q57). On an edge process, a
// critical catalog stream without a successful sync for over 24 hours holds
// sales until an owner allows them for a limited time. The runtime installs a
// provider that combines the freshness snapshot (catalog-freshness.ts) with
// the cached active owner override. The check is synchronous and in memory so
// it can run before any order or payment write.
//
//   cloud process     never gated.
//   edge, no provider fail closed: blocked with reason GATE_UNAVAILABLE.
//   edge, tax never synced: TAX_NOT_SYNCED; no owner override lifts it.
//   edge, wall clock booted far behind the saved high water: CLOCK_REGRESSED.
import { CoreError } from "@starter/shared/core";
import { env } from "../config/env.ts";

export const CATALOG_SALES_BLOCK_AFTER_MS = 24 * 60 * 60_000;

export type SalesGateState = {
  /** True when tax was never synced, or the 24 h rule hit and no override is active. */
  blocked: boolean;
  /** The 24 h rule hit (even when overridden). */
  stale24h: boolean;
  reason:
    | "CATALOG_STALE_24H"
    | "GATE_UNAVAILABLE"
    | "CLOCK_REGRESSED"
    | "TAX_NOT_SYNCED"
    | null;
  /** Oldest last success (or tracking start) among the offending streams. */
  staleSince: Date | null;
  staleStreams: string[];
  override: {
    id: string;
    grantedBy: string;
    grantedAt: Date;
    untilAt: Date;
    reason: string;
  } | null;
};

export type SalesGateProvider = () => SalesGateState;

let provider: SalesGateProvider | null = null;
let isEdgeMode: () => boolean = () => env.EDGE_MODE;

export function installSalesGateProvider(p: SalesGateProvider | null): void {
  provider = p;
}

/** Test seam: override how edge mode is read (null restores `env.EDGE_MODE`). */
export function setSalesGateEdgeModeForTests(fn: (() => boolean) | null): void {
  isEdgeMode = fn ?? (() => env.EDGE_MODE);
}

const OPEN: SalesGateState = {
  blocked: false,
  stale24h: false,
  reason: null,
  staleSince: null,
  staleStreams: [],
  override: null,
};

export function getSalesGateState(): SalesGateState {
  if (!isEdgeMode()) return { ...OPEN, staleStreams: [] };
  if (!provider)
    return {
      ...OPEN,
      staleStreams: [],
      blocked: true,
      reason: "GATE_UNAVAILABLE",
    };
  try {
    return provider();
  } catch {
    // A broken provider must never let a sale through.
    return {
      ...OPEN,
      staleStreams: [],
      blocked: true,
      reason: "GATE_UNAVAILABLE",
    };
  }
}

/** Throws CATALOG_STALE_BLOCKED when sales are held. Call before any write. */
export function assertCatalogSalesAllowed(): void {
  const state = getSalesGateState();
  if (!state.blocked) return;
  const message =
    state.reason === "GATE_UNAVAILABLE"
      ? "Penjualan ditahan: database lokal edge belum bisa dibaca. Hubungi teknisi; penjualan dibuka lagi otomatis setelah sistem pulih."
      : state.reason === "TAX_NOT_SYNCED"
        ? "Penjualan ditahan: aturan pajak belum tersinkron ke perangkat ini. Sambungkan internet; penjualan dibuka otomatis setelah pajak tersinkron."
        : state.reason === "CLOCK_REGRESSED"
          ? "Penjualan ditahan: jam perangkat mundur dari waktu terakhir yang tercatat. Perbaiki jam perangkat atau minta owner untuk mengizinkan."
          : "Penjualan ditahan: katalog belum tersinkron lebih dari 24 jam. Minta owner untuk mengizinkan.";
  throw new CoreError("CATALOG_STALE_BLOCKED", message);
}
