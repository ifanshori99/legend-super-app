// Sales gate (bead legend-10nex, founder Q57). Written from the design
// contract (edge/sales-gate.ts), not from the implementation:
//   installSalesGateProvider(p | null), getSalesGateState(),
//   assertCatalogSalesAllowed(), CATALOG_SALES_BLOCK_AFTER_MS,
//   setSalesGateEdgeModeForTests(fn | null).
//
// Assumptions:
//  - CoreError code CATALOG_STALE_BLOCKED carries the Indonesian message from
//    the contract and is also what the HTTP layer maps (423, tested elsewhere).
//  - A provider state with `blocked: false` lets the sale through even when
//    `stale24h` is true (that is how an active owner override looks).
import { afterEach, describe, expect, it } from "vitest";
import { CoreError } from "@starter/shared/core";
import {
  assertCatalogSalesAllowed,
  CATALOG_SALES_BLOCK_AFTER_MS,
  getSalesGateState,
  installSalesGateProvider,
  setSalesGateEdgeModeForTests,
  type SalesGateState,
} from "./sales-gate.ts";

const BLOCKED_MESSAGE =
  "Penjualan ditahan: katalog belum tersinkron lebih dari 24 jam. Minta owner untuk mengizinkan.";

const allow: SalesGateState = {
  blocked: false,
  stale24h: false,
  reason: null,
  staleSince: null,
  staleStreams: [],
  override: null,
};
const stale: SalesGateState = {
  blocked: true,
  stale24h: true,
  reason: "CATALOG_STALE_24H",
  staleSince: new Date("2026-11-10T01:00:00.000Z"),
  staleStreams: ["price_lists"],
  override: null,
};
const overridden: SalesGateState = {
  ...stale,
  blocked: false,
  override: {
    id: "ovr-1",
    grantedBy: "user-owner",
    grantedAt: new Date("2026-11-11T02:00:00.000Z"),
    untilAt: new Date("2026-11-11T06:00:00.000Z"),
    reason: "Internet toko mati",
  },
};

afterEach(() => {
  installSalesGateProvider(null);
  setSalesGateEdgeModeForTests(null);
});

function thrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("legend-10nex sales gate constants", () => {
  it("holds sales after 24 hours", () => {
    expect(CATALOG_SALES_BLOCK_AFTER_MS).toBe(24 * 60 * 60_000);
  });
});

describe("legend-10nex cloud (non-edge) processes are never gated", () => {
  it("allows a sale without any provider", () => {
    setSalesGateEdgeModeForTests(() => false);
    expect(getSalesGateState().blocked).toBe(false);
    expect(() => assertCatalogSalesAllowed()).not.toThrow();
  });

  it("ignores even a provider that says blocked", () => {
    setSalesGateEdgeModeForTests(() => false);
    installSalesGateProvider(() => stale);
    expect(getSalesGateState().blocked).toBe(false);
    expect(() => assertCatalogSalesAllowed()).not.toThrow();
  });
});

describe("legend-10nex edge process", () => {
  it("fails closed when no provider is installed (GATE_UNAVAILABLE)", () => {
    setSalesGateEdgeModeForTests(() => true);
    const state = getSalesGateState();
    expect(state.blocked).toBe(true);
    expect(state.reason).toBe("GATE_UNAVAILABLE");
    const error = thrown(() => assertCatalogSalesAllowed());
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("CATALOG_STALE_BLOCKED");
  });

  it("allows a sale while the catalog is fresh", () => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(() => allow);
    expect(getSalesGateState()).toMatchObject({ blocked: false, reason: null });
    expect(() => assertCatalogSalesAllowed()).not.toThrow();
  });

  it("refuses a sale after 24 hours without sync, with the Indonesian message", () => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(() => stale);
    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      stale24h: true,
      reason: "CATALOG_STALE_24H",
      staleStreams: ["price_lists"],
    });
    const error = thrown(() => assertCatalogSalesAllowed());
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("CATALOG_STALE_BLOCKED");
    expect((error as CoreError).message).toBe(BLOCKED_MESSAGE);
  });

  it("allows a sale while an owner override is active, and still reports the stale catalog", () => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(() => overridden);
    const state = getSalesGateState();
    expect(state.blocked).toBe(false);
    expect(state.stale24h).toBe(true);
    expect(state.override?.grantedBy).toBe("user-owner");
    expect(() => assertCatalogSalesAllowed()).not.toThrow();
  });

  it("reads the provider on every call (an override granted a moment ago applies at once)", () => {
    setSalesGateEdgeModeForTests(() => true);
    let current = stale;
    installSalesGateProvider(() => current);
    expect(() => assertCatalogSalesAllowed()).toThrow();
    current = overridden;
    expect(() => assertCatalogSalesAllowed()).not.toThrow();
    current = stale; // override expired
    expect(() => assertCatalogSalesAllowed()).toThrow();
  });

  it("removing the provider fails closed again", () => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(() => allow);
    installSalesGateProvider(null);
    expect(getSalesGateState().reason).toBe("GATE_UNAVAILABLE");
  });
});

// F5 (architect): only the 24-hour rule may say "24 jam"; the other holds must
// not blame the catalog age.
describe("legend-10nex hold messages match their reason", () => {
  const message = (reason: SalesGateState["reason"]) => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(() => ({
      ...stale,
      stale24h: reason === "CATALOG_STALE_24H",
      reason,
      staleStreams: [],
    }));
    const error = thrown(() => assertCatalogSalesAllowed());
    expect(error).toBeInstanceOf(CoreError);
    return (error as CoreError).message;
  };

  it("keeps the 24-hour text for CATALOG_STALE_24H", () => {
    expect(message("CATALOG_STALE_24H")).toBe(BLOCKED_MESSAGE);
  });

  it.each(["GATE_UNAVAILABLE", "CLOCK_REGRESSED", "TAX_NOT_SYNCED"] as const)(
    "%s does not say the catalog is over 24 hours old",
    (reason) => {
      const text = message(reason as SalesGateState["reason"]);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/24 jam/i);
      expect(text).not.toBe(BLOCKED_MESSAGE);
    },
  );

  it("TAX_NOT_SYNCED names the tax and does not send the cashier to the owner", () => {
    const text = message("TAX_NOT_SYNCED");
    expect(text).toMatch(/pajak/i);
    expect(text).not.toMatch(/owner/i);
  });

  it("no provider installed (GATE_UNAVAILABLE) uses the same non-24h text", () => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(null);
    const error = thrown(() => assertCatalogSalesAllowed());
    expect((error as CoreError).message).not.toMatch(/24 jam/i);
  });
});
