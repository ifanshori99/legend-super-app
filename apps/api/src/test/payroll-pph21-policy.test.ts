// Tenant PPh 21 policy contract (bead legend-y4wp): defaults, version
// resolution by effective date and strict parameters. Storage, permission,
// audit and RLS live in payroll-pph21-policy-db.test.ts.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PPH21_POLICY,
  createPph21PolicyVersionInputSchema,
  pph21PolicyParametersSchema,
  resolvePph21Policy,
} from "@starter/shared/hris/payroll";
import type { BusinessDate } from "@starter/shared/core";

const date = (value: string) => value as BusinessDate;
const v = (
  version: number,
  effectiveFrom: string,
  roundingMode: "down" | "half_up",
) => ({
  version,
  effectiveFrom: date(effectiveFrom),
  parameters: { ...DEFAULT_PPH21_POLICY, roundingMode },
});

describe("PPh 21 tenant policy", () => {
  it("defaults follow the CTO recommendation (founder 2026-11-08)", () => {
    expect(DEFAULT_PPH21_POLICY).toEqual({
      occupationalCostCap: "pro_rata_months",
      noTaxIdSurcharge: "ter_and_annual",
      combinedSpouseStatus: "normalize",
      mixedSchemeAllocation: "proportional",
      roundingMode: "half_up",
    });
    expect(Object.isFrozen(DEFAULT_PPH21_POLICY)).toBe(true);
  });

  it("uses the default when no version covers the date", () => {
    expect(resolvePph21Policy([], date("2026-01-31"))).toBe(
      DEFAULT_PPH21_POLICY,
    );
    expect(
      resolvePph21Policy([v(1, "2027-01-01", "down")], date("2026-12-31")),
    ).toBe(DEFAULT_PPH21_POLICY);
  });

  it("picks the latest version effective on or before the date", () => {
    const versions = [
      v(1, "2024-01-01", "down"),
      v(2, "2025-01-01", "half_up"),
      v(3, "2027-01-01", "down"),
    ];
    expect(resolvePph21Policy(versions, date("2024-12-31")).roundingMode).toBe(
      "down",
    );
    expect(resolvePph21Policy(versions, date("2025-01-01")).roundingMode).toBe(
      "half_up",
    );
    expect(resolvePph21Policy(versions, date("2026-11-30")).roundingMode).toBe(
      "half_up",
    );
    expect(resolvePph21Policy(versions, date("2027-01-01")).roundingMode).toBe(
      "down",
    );
  });

  it("rejects unknown options and extra keys", () => {
    expect(
      pph21PolicyParametersSchema.safeParse({
        ...DEFAULT_PPH21_POLICY,
        occupationalCostCap: "none",
      }).success,
    ).toBe(false);
    expect(
      pph21PolicyParametersSchema.safeParse({
        ...DEFAULT_PPH21_POLICY,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("client input carries no tenant and needs a reason", () => {
    const ok = {
      effectiveFrom: "2027-01-01",
      parameters: DEFAULT_PPH21_POLICY,
      reason: "Saran konsultan pajak",
    };
    expect(createPph21PolicyVersionInputSchema.safeParse(ok).success).toBe(
      true,
    );
    expect(
      createPph21PolicyVersionInputSchema.safeParse({ ...ok, reason: "" })
        .success,
    ).toBe(false);
    expect(
      createPph21PolicyVersionInputSchema.safeParse({
        ...ok,
        tenantId: "00000000-0000-4000-8000-000000000000",
      }).success,
    ).toBe(false);
  });
});
