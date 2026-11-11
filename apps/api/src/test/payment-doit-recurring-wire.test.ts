// Bead 6c6: schema parsing of the ASSUMED DOIT recurring wire contract. Pure:
// parsers only, no DB and no network.
import { describe, expect, it } from "vitest";
import {
  doitRecurringPlanSchema,
  doitRecurringSubscriptionSchema,
  isDoitRecurringEvent,
  parseDoitInvoiceEvent,
} from "../services/payment-doit-recurring-wire";

const invoice = {
  id: "inv_1",
  subscription_id: "sub_1",
  plan_id: "plan_1",
  amount: 150000,
  currency: "IDR",
  period_start: "2026-11-01",
  period_end: "2026-11-30",
  hosted_url: "https://pay.doit.id/i/inv_1",
  status: "open",
};

function envelope(
  overrides: Record<string, unknown> = {},
  type = "invoice.created",
) {
  return {
    id: "evt_1",
    type,
    created_at: "2026-11-01T00:00:00.000Z",
    data: { invoice: { ...invoice, ...overrides } },
  };
}

describe("isDoitRecurringEvent", () => {
  it("accepts only the two invoice events", () => {
    expect(isDoitRecurringEvent("invoice.created")).toBe(true);
    expect(isDoitRecurringEvent("invoice.paid")).toBe(true);
    expect(isDoitRecurringEvent("payment.paid")).toBe(false);
    expect(isDoitRecurringEvent("invoice.voided")).toBe(false);
  });
});

describe("parseDoitInvoiceEvent", () => {
  it("parses invoice.created and invoice.paid", () => {
    const created = parseDoitInvoiceEvent(envelope());
    expect(created?.type).toBe("invoice.created");
    expect(created?.data.invoice.paid_at).toBeNull();
    const paid = parseDoitInvoiceEvent(
      envelope(
        { status: "paid", paid_at: "2026-11-02T03:04:05.000Z" },
        "invoice.paid",
      ),
    );
    expect(paid?.data.invoice.status).toBe("paid");
    expect(paid?.data.invoice.paid_at).toBe("2026-11-02T03:04:05.000Z");
  });

  it("drops unknown fields", () => {
    const parsed = parseDoitInvoiceEvent(envelope({ card_number: "4111" }));
    expect(parsed?.data.invoice).not.toHaveProperty("card_number");
  });

  it("turns a zoneless paid_at into null instead of failing", () => {
    const parsed = parseDoitInvoiceEvent(
      envelope(
        { status: "paid", paid_at: "2026-11-02T03:04:05" },
        "invoice.paid",
      ),
    );
    expect(parsed?.data.invoice.paid_at).toBeNull();
  });

  it.each([
    ["an unknown event type", envelope({}, "invoice.refunded")],
    ["a payment event", envelope({}, "payment.paid")],
    ["a null body", null],
    ["a missing invoice", { ...envelope(), data: {} }],
    ["a zero amount", envelope({ amount: 0 })],
    ["a negative amount", envelope({ amount: -1 })],
    ["a fractional amount", envelope({ amount: 1000.5 })],
    ["a string amount", envelope({ amount: "150000" })],
    ["a foreign currency", envelope({ currency: "USD" })],
    ["an unknown status", envelope({ status: "pending" })],
    ["a missing subscription id", envelope({ subscription_id: undefined })],
    ["an impossible date", envelope({ period_start: "2026-02-31" })],
    ["a datetime period", envelope({ period_start: "2026-11-01T00:00:00Z" })],
    [
      "a period ending before it starts",
      envelope({ period_end: "2026-10-31" }),
    ],
    ["an http hosted url", envelope({ hosted_url: "http://pay.doit.id/i/1" })],
    [
      "a hosted url with credentials",
      envelope({ hosted_url: "https://a:b@x.id/" }),
    ],
  ])("rejects %s", (_name, body) => {
    expect(parseDoitInvoiceEvent(body)).toBeNull();
  });
});

describe("HTTP answer schemas", () => {
  it("parses a plan and rejects a free or fractional one", () => {
    expect(
      doitRecurringPlanSchema.parse({
        id: "plan_1",
        amount: 1000,
        interval: "week",
      }),
    ).toEqual({ id: "plan_1", amount: 1000, interval: "week" });
    expect(
      doitRecurringPlanSchema.safeParse({
        id: "p",
        amount: 0,
        interval: "month",
      }).success,
    ).toBe(false);
    expect(
      doitRecurringPlanSchema.safeParse({
        id: "p",
        amount: 1,
        interval: "year",
      }).success,
    ).toBe(false);
  });

  it("parses a subscription; a bad first invoice url becomes null", () => {
    expect(
      doitRecurringSubscriptionSchema.parse({
        id: "sub_1",
        plan_id: "plan_1",
        status: "pending",
        first_invoice_url: "https://pay.doit.id/i/1",
      }).first_invoice_url,
    ).toBe("https://pay.doit.id/i/1");
    expect(
      doitRecurringSubscriptionSchema.parse({
        id: "sub_1",
        plan_id: "plan_1",
        status: "pending",
        first_invoice_url: "http://insecure",
      }).first_invoice_url,
    ).toBeNull();
    expect(
      doitRecurringSubscriptionSchema.parse({
        id: "s",
        plan_id: "p",
        status: "x",
      }).first_invoice_url,
    ).toBeNull();
  });
});
