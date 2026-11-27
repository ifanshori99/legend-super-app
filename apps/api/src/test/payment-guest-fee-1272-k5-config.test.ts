// 1272 K5: the guest fee rate lives in the Duitku integration config next to
// the C4a caps. A rate above its cap (or on QRIS, or with no cap) is never
// saved, the form keeps the caps when it saves, and the quote (K1) reads the
// rate the form saved. Pure functions only.
import { describe, expect, it } from "vitest";
import {
  gatewayCredentialIssues,
  integrationConfigSchema,
  type TenantIntegration,
} from "@starter/shared/platform";
import { guestFeeRatesOf } from "../services/payment-guest-fee";
import {
  buildDuitkuUpsertInput,
  duitkuConfigDraft,
  validateDuitkuDraft,
} from "../../../web/src/features/ws05-payment-admin/duitku-credentials-lib";

const BASE = {
  environment: "production",
  notificationEmail: "ops@kopi.example",
  maxFeeBps_va: 0,
  maxFeeFlatIdr_va: 5_000,
  maxFeeBps_ewallet: 300,
  maxFeeFlatIdr_ewallet: 0,
  maxFeeBps_qris: 70,
};

const row = (config: Record<string, unknown>) =>
  ({
    id: "ti_1",
    provider: "duitku",
    config,
    credentials: { secretRef: "sec_1", fields: ["apiKey"], setAt: "x" },
  }) as unknown as TenantIntegration;

const issues = (config: Record<string, unknown>) =>
  gatewayCredentialIssues(
    "duitku",
    config as Parameters<typeof gatewayCredentialIssues>[1],
    undefined,
  );

describe("1272 K5 guest fee config contract", () => {
  it("accepts a rate within the cap", () => {
    const config = { ...BASE, guestFees: { BC: { bps: 0, flatIdr: 4_000 } } };
    expect(integrationConfigSchema.safeParse(config).success).toBe(true);
    expect(issues(config)).toEqual([]);
  });

  it("refuses a rate above the cap, without a cap, on QRIS, or bps >= 10000", () => {
    for (const guestFees of [
      { BC: { bps: 0, flatIdr: 5_001 } },
      { OV: { bps: 301, flatIdr: 0 } },
      { VC: { bps: 10, flatIdr: 0 } }, // card has no cap
      { SP: { bps: 10, flatIdr: 0 } }, // QRIS never carries a fee
      { BC: { bps: 10_000, flatIdr: 0 } },
    ])
      expect(issues({ ...BASE, guestFees })).toEqual(["guestFees"]);
  });

  it("keeps guestFees to Duitku", () => {
    const config = { guestFees: { BC: { bps: 0, flatIdr: 1 } } };
    expect(gatewayCredentialIssues("doit", config as never, undefined)).toEqual(
      ["guestFees"],
    );
    expect(
      gatewayCredentialIssues("email", config as never, undefined),
    ).toEqual(["guestFees"]);
  });

  it("lets only guestFees hold a nested value", () => {
    expect(integrationConfigSchema.safeParse({ other: { a: 1 } }).success).toBe(
      false,
    );
  });
});

describe("1272 K5 Duitku form", () => {
  it("refuses a rate above the cap, without a cap, or malformed", () => {
    const stored = row(BASE);
    const draft = duitkuConfigDraft(stored);
    draft.guestFees.va = { bps: "0", flatIdr: "5001" };
    draft.guestFees.card = { bps: "5", flatIdr: "" };
    draft.guestFees.ewallet = { bps: "1.5", flatIdr: "" };
    const errors = validateDuitkuDraft(draft, {}, true, stored);
    expect(errors["fee:va:flatIdr"]).toBe(
      "paymentAdmin.duitku.errors.feeOverCap",
    );
    expect(errors["fee:card:bps"]).toBe("paymentAdmin.duitku.errors.feeNoCap");
    expect(errors["fee:ewallet:bps"]).toBe(
      "paymentAdmin.duitku.errors.feeInvalid",
    );
    draft.guestFees.va = { bps: "0", flatIdr: "5000" };
    draft.guestFees.card = { bps: "", flatIdr: "" };
    draft.guestFees.ewallet = { bps: "", flatIdr: "" };
    expect(validateDuitkuDraft(draft, {}, true, stored)).toEqual({});
  });

  it("saves rates, keeps the caps, and the K1 quote reads the saved rate", () => {
    const stored = row(BASE);
    const draft = duitkuConfigDraft(stored);
    draft.guestFees.va = { bps: "0", flatIdr: "4000" };
    draft.guestFees.ewallet = { bps: "250", flatIdr: "" };
    const input = buildDuitkuUpsertInput({ outletId: null }, draft, stored);
    expect(issues(input.config)).toEqual([]);
    expect(input.config.maxFeeFlatIdr_va).toBe(5_000);
    const rates = guestFeeRatesOf(input.config);
    expect(rates.get("BC")).toEqual({ bps: 0, flatIdr: 4_000 });
    expect(rates.get("M2")).toEqual({ bps: 0, flatIdr: 4_000 });
    expect(rates.get("OV")).toEqual({ bps: 250, flatIdr: 0 });
    expect(rates.has("VC")).toBe(false);
    expect(rates.has("SP")).toBe(false);
  });

  it("keeps stored per-channel rates of an untouched method and drops a cleared one", () => {
    const stored = row({
      ...BASE,
      guestFees: {
        BC: { bps: 0, flatIdr: 4_000 },
        M2: { bps: 0, flatIdr: 3_000 },
        OV: { bps: 100, flatIdr: 0 },
      },
    });
    const draft = duitkuConfigDraft(stored);
    draft.guestFees.ewallet = { bps: "", flatIdr: "" };
    const input = buildDuitkuUpsertInput({ outletId: null }, draft, stored);
    expect(input.config.guestFees).toEqual({
      BC: { bps: 0, flatIdr: 4_000 },
      M2: { bps: 0, flatIdr: 3_000 },
    });
    const bare = row(BASE);
    const none = buildDuitkuUpsertInput(
      { outletId: null },
      duitkuConfigDraft(bare),
      bare,
    );
    expect("guestFees" in none.config).toBe(false);
  });
});
