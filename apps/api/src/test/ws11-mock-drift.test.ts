// Drift between the web report mocks and the API's metric registry (WS-11,
// brief 284 T4 item 8; pattern of the facility test in ms-facility.test.ts).
// Pure: no database. The mock of every family lists the metrics the API
// answers `unavailable`; the list must equal what the registry says, read
// from the registry (never hard-coded), so a source that lands later fails
// here until the mock follows.
import { describe, expect, it } from "vitest";
import {
  ownerDashboardBoardRuns,
  reportCatalog,
  reportMetricByCode,
} from "@starter/shared/dashboard";
import type { MetricUnavailableReason } from "@starter/shared/metrics";
import { metricSourceOf, metricSplitOf } from "../services/metric-sources";
import * as facility from "../../../web/src/features/ws11-reports/mock-families/facility.ts";
import * as finance from "../../../web/src/features/ws11-reports/mock-families/finance.ts";
import * as hr from "../../../web/src/features/ws11-reports/mock-families/hr.ts";
import * as inventoryPurchasing from "../../../web/src/features/ws11-reports/mock-families/inventory-purchasing.ts";
import * as loyaltyCrm from "../../../web/src/features/ws11-reports/mock-families/loyalty-crm.ts";
import * as menuCogs from "../../../web/src/features/ws11-reports/mock-families/menu-cogs.ts";
import * as paymentsTax from "../../../web/src/features/ws11-reports/mock-families/payments-tax.ts";
import * as reservationDelivery from "../../../web/src/features/ws11-reports/mock-families/reservation-delivery.ts";
import * as sales from "../../../web/src/features/ws11-reports/mock-families/sales.ts";
import * as trafficOperations from "../../../web/src/features/ws11-reports/mock-families/traffic-operations.ts";

type Family = {
  name: string;
  prefixes: readonly string[];
  unavailableMetrics: ReadonlySet<string>;
};

const FAMILIES: readonly Family[] = [
  { name: "sales", prefixes: ["sales"], ...sales },
  {
    name: "traffic-operations",
    prefixes: ["traffic", "operations"],
    ...trafficOperations,
  },
  { name: "menu-cogs", prefixes: ["menu", "cogs"], ...menuCogs },
  { name: "payments-tax", prefixes: ["payments", "tax"], ...paymentsTax },
  {
    name: "inventory-purchasing",
    prefixes: ["inventory", "purchasing"],
    ...inventoryPurchasing,
  },
  { name: "finance", prefixes: ["finance"], ...finance },
  { name: "loyalty-crm", prefixes: ["loyalty", "crm"], ...loyaltyCrm },
  {
    name: "reservation-delivery",
    prefixes: ["reservation", "delivery"],
    ...reservationDelivery,
  },
  {
    name: "hr",
    prefixes: ["attendance", "payroll", "performance"],
    ...hr,
  },
  { name: "facility", prefixes: ["facility"], ...facility },
];

/**
 * Why the engine answers a metric `unavailable`, or null. A derived or share
 * source is unavailable when one of its inputs is (the engine's planOf).
 */
function unavailableReason(
  code: string,
  seen: ReadonlySet<string> = new Set(),
): MetricUnavailableReason | null {
  if (seen.has(code)) return null;
  const path = new Set(seen).add(code);
  const source = metricSourceOf(code);
  switch (source.kind) {
    case "unavailable":
      return source.reason;
    case "derived":
      return (
        unavailableReason(source.numerator, path) ??
        unavailableReason(source.denominator, path)
      );
    case "share":
      return unavailableReason(source.of, path);
    default:
      return null;
  }
}

function metricsOf(prefixes: readonly string[]): string[] {
  const codes = new Set<string>();
  for (const report of reportCatalog)
    if (prefixes.some((prefix) => report.code.startsWith(`${prefix}.`)))
      for (const code of report.metrics) codes.add(code);
  return [...codes].sort();
}

describe("web report mocks against the metric registry", () => {
  it("covers every report family of the catalog", () => {
    const known = new Set(FAMILIES.flatMap((family) => family.prefixes));
    const prefixes = new Set(
      reportCatalog.map((report) => report.code.split(".")[0]!),
    );
    expect([...prefixes].filter((prefix) => !known.has(prefix))).toEqual([]);
  });

  for (const family of FAMILIES)
    it(`${family.name}: the mock's unavailable list equals the registry's`, () => {
      const registry = metricsOf(family.prefixes).filter(
        (code) => unavailableReason(code) !== null,
      );
      expect([...family.unavailableMetrics].sort()).toEqual(registry);
    });

  it("lists only metrics the family's reports show", () => {
    for (const family of FAMILIES) {
      const shown = new Set(metricsOf(family.prefixes));
      for (const code of family.unavailableMetrics)
        expect(shown.has(code), `${family.name} ${code}`).toBe(true);
    }
  });

  it("splits a mock marks unsupported are the ones the engine refuses", () => {
    const marked = FAMILIES.flatMap((family) =>
      Object.entries(
        (family as Partial<{ unsupportedSplits: Record<string, string[]> }>)
          .unsupportedSplits ?? {},
      ),
    );
    // tax_payable by outlet (a balance is a tenant figure) and payment_fee by
    // channel (a ledger amount with no channel split).
    expect(marked.map(([code]) => code).sort()).toEqual([
      "payment_fee",
      "tax_payable",
    ]);
    for (const [code, dimensions] of marked)
      for (const dimension of dimensions) {
        const source = metricSourceOf(code);
        expect(source.kind, code).toBe("gl");
        if (source.kind !== "gl") continue;
        const refused =
          (source.gl.kind === "balance" && dimension === "outlet") ||
          (source.gl.kind === "amount" &&
            metricSplitOf(code, dimension as never) === null);
        expect(refused, `${code} by ${dimension}`).toBe(true);
      }
  });
});

describe("owner board fixture against the metric registry", () => {
  it("gives no number to a metric the API answers unavailable", () => {
    for (const [reportCode, run] of Object.entries(ownerDashboardBoardRuns)) {
      for (const definition of run.definitions) {
        const reason = unavailableReason(definition.code);
        const entry = run.availability.find(
          (item) => item.metricCode === definition.code,
        );
        if (reason === null) {
          expect(entry?.status, `${reportCode} ${definition.code}`).toBe(
            "available",
          );
          continue;
        }
        expect(entry, `${reportCode} ${definition.code}`).toMatchObject({
          status: "unavailable",
          reason,
        });
        for (const row of run.rows) {
          const value = row.values.find(
            (item) => item.metricCode === definition.code,
          )?.value;
          expect(value, `${reportCode} ${definition.code}`).toBeNull();
        }
      }
    }
  });

  it("keeps every board metric in the registry", () => {
    for (const run of Object.values(ownerDashboardBoardRuns))
      for (const definition of run.definitions)
        expect(reportMetricByCode.has(definition.code)).toBe(true);
  });
});
