// Catalog-freshness sales gate on the edge (legend-10nex). Pure helpers and
// the constants for the notice and the owner override form (copy lives in the
// shared catalog, namespace `catalogSales`). The edge
// decides (salesGate.blocked); the web only shows it and lets an owner allow
// sales. The API re-checks the owner role on every grant.
import type { CatalogFreshness } from "@starter/shared/edge";

/** Permission the owner override route requires (owners only). */
export const CATALOG_OVERRIDE_PERMISSION = "device.registry.manage";

/** API error code of a sale refused because the catalog is over 24 hours old. */
export const CATALOG_STALE_BLOCKED = "CATALOG_STALE_BLOCKED";

/** Same bounds as the API: integer minutes 1..1440, reason 3..500 characters. */
export const OVERRIDE_MINUTES_OPTIONS = [30, 60, 240, 480, 1440] as const;
export const OVERRIDE_DEFAULT_MINUTES = 240;
export const OVERRIDE_REASON_MIN = 3;
export const OVERRIDE_REASON_MAX = 500;

export type SalesGateView = {
  blocked: boolean;
  stale24h: boolean;
  reason:
    | "CATALOG_STALE_24H"
    | "CLOCK_REGRESSED"
    | "GATE_UNAVAILABLE"
    | "TAX_NOT_SYNCED"
    | null;
  staleSince: string | null;
  staleStreams: string[];
  override: { grantedAt: string; untilAt: string } | null;
  /** Promo and voucher are off because promo data is over 24 hours old. */
  promoDisabled?: boolean;
};

/** The edge answers `salesGate` next to the existing freshness fields. */
export function salesGateOf(
  freshness: CatalogFreshness | undefined,
): SalesGateView | null {
  const withGate = freshness as
    (CatalogFreshness & { salesGate?: SalesGateView }) | undefined;
  return withGate?.salesGate ?? null;
}

export function isCatalogSalesBlockedError(error: unknown): error is {
  code: typeof CATALOG_STALE_BLOCKED;
  message: string;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === CATALOG_STALE_BLOCKED
  );
}

export function formatHourMinute(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} menit`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} jam` : `${minutes} menit`;
}
