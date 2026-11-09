// legend-x9w2: `settlement.reconciled.provider` is an allow-list of gateway
// providers (docs/design/auto-journals.md section 4). EDC bank codes and
// `edc_<bank>` are rejected: EDC payouts use `edc_transaction.settled`.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_SETTLEMENT_PROVIDERS,
  settlementReconciledPayloadSchema,
} from "@starter/shared/payment";

function payload(provider: string) {
  return {
    settlementId: randomUUID(),
    provider,
    outletId: randomUUID(),
    settledOn: "2026-11-09",
    grossIdr: 100_000,
    feeIdr: 700,
    netSettledIdr: 99_300,
  };
}

describe("settlement.reconciled provider allow-list (legend-x9w2)", () => {
  it("lists the gateway providers doit and duitku", () => {
    expect([...GATEWAY_SETTLEMENT_PROVIDERS]).toEqual(["doit", "duitku"]);
  });

  for (const provider of ["doit", "duitku"]) {
    it(`accepts ${provider}`, () => {
      expect(
        settlementReconciledPayloadSchema.safeParse(payload(provider)).success,
      ).toBe(true);
    });
  }

  for (const provider of [
    "bca",
    "mandiri",
    "bni",
    "bjb",
    "edc_bca",
    "xendit",
  ]) {
    it(`rejects ${provider}`, () => {
      expect(
        settlementReconciledPayloadSchema.safeParse(payload(provider)).success,
      ).toBe(false);
    });
  }
});
