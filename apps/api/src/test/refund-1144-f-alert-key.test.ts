// (brief 1144, putaran 2, second opinion ronde 16 P2-1): the stable alert id of one provider
// refund report. Pure function, no database: the id differs per tenant and per refund id, and is
// the same across retries and across alert types (event names).

import { describe, expect, it } from "vitest";
import {
  reconHoldAlertId,
  type ReconHoldFiledAlert,
} from "../services/payment-provider-refunded-alert";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333";
const INTEGRATION = "44444444-4444-4444-8444-444444444444";

const held = (
  refundId: string,
  overrides: Partial<ReconHoldFiledAlert> = {},
): Pick<ReconHoldFiledAlert, "intentId" | "dedupKey" | "stableRefund"> => ({
  intentId: INTENT,
  dedupKey: "any",
  stableRefund: { integrationId: INTEGRATION, refundId },
  ...overrides,
});

const SWITCHED_OFF = "payment.provider_refund_switched_off";
const UNMATCHED = "payment.provider_refund_unmatched";

describe("1144-f stable refund report alert id", () => {
  it("1144-f-01 same across retries and alert types, whatever dedupKey or amount", () => {
    const first = reconHoldAlertId(TENANT_A, SWITCHED_OFF, held("RF-1"));
    expect(reconHoldAlertId(TENANT_A, SWITCHED_OFF, held("RF-1"))).toBe(first);
    expect(reconHoldAlertId(TENANT_A, UNMATCHED, held("RF-1"))).toBe(first);
    expect(
      reconHoldAlertId(
        TENANT_A,
        UNMATCHED,
        held("RF-1", { dedupKey: "other-key-123" }),
      ),
    ).toBe(first);
  });

  it("1144-f-02 differs per tenant", () => {
    expect(reconHoldAlertId(TENANT_A, UNMATCHED, held("RF-1"))).not.toBe(
      reconHoldAlertId(TENANT_B, UNMATCHED, held("RF-1")),
    );
  });

  it("1144-f-03 differs per refund id, integration and intent", () => {
    const base = reconHoldAlertId(TENANT_A, UNMATCHED, held("RF-1"));
    expect(reconHoldAlertId(TENANT_A, UNMATCHED, held("RF-2"))).not.toBe(base);
    expect(
      reconHoldAlertId(
        TENANT_A,
        UNMATCHED,
        held("RF-1", {
          stableRefund: { integrationId: null, refundId: "RF-1" },
        }),
      ),
    ).not.toBe(base);
    expect(
      reconHoldAlertId(
        TENANT_A,
        UNMATCHED,
        held("RF-1", { intentId: "55555555-5555-4555-8555-555555555555" }),
      ),
    ).not.toBe(base);
  });

  it("1144-f-04 without a stable refund the event name and dedupKey still count", () => {
    const plain = { intentId: INTENT, dedupKey: "k" };
    expect(reconHoldAlertId(TENANT_A, SWITCHED_OFF, plain)).not.toBe(
      reconHoldAlertId(TENANT_A, UNMATCHED, plain),
    );
    expect(reconHoldAlertId(TENANT_A, UNMATCHED, plain)).toBe(
      reconHoldAlertId(TENANT_A, UNMATCHED, plain),
    );
  });
});
