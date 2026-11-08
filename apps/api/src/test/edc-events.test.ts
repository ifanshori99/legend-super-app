import { describe, expect, it } from "vitest";
import { eventCatalogByName } from "@starter/shared/events";
import {
  edcBankSchema,
  edcTransactionStatusSchema,
  maskedPanSchema,
} from "@starter/shared/edc";
import {
  EDC_TRANSACTION_EVENTS,
  edcTransactionEventPayloadSchema,
} from "@starter/shared/edc/events";

const payload = {
  transactionId: "3f1c2a52-6a4b-4f0e-9c1d-0a1b2c3d4e5f",
  tenantId: "0b5f1f4e-1d6e-4d57-8c0a-1f2e3d4c5b6a",
  outletId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  terminalId: "9b2f1d3a-5c4e-4b6a-8d7f-0e1a2b3c4d5e",
  bank: "bca",
  reference: "POS-1",
  amountIdr: 50000,
  status: "approved",
  trace: "000123",
  approvalCode: "A12345",
  maskedPan: "411111******1111",
  needsReconciliation: false,
};

describe("EDC transaction events", () => {
  it("are all in the catalog under the edc_transaction aggregate", () => {
    const names = EDC_TRANSACTION_EVENTS.map((e) => e.name);
    expect(names).toEqual([
      "edc_transaction.created",
      "edc_transaction.approved",
      "edc_transaction.declined",
      "edc_transaction.failed",
      "edc_transaction.cancelled",
      "edc_transaction.flagged",
    ]);
    for (const name of [...names, "edc_transaction.settled"])
      expect(eventCatalogByName.get(name)?.aggregateType).toBe(
        "edc_transaction",
      );
  });

  it("keeps the payload enums in step with the edc contract", () => {
    const shape = edcTransactionEventPayloadSchema.shape;
    expect(shape.bank.options).toEqual(edcBankSchema.options);
    expect(shape.status.options).toEqual(edcTransactionStatusSchema.options);
  });

  it("accepts a masked PAN and rejects a raw PAN or extra fields", () => {
    expect(maskedPanSchema.safeParse(payload.maskedPan).success).toBe(true);
    expect(edcTransactionEventPayloadSchema.safeParse(payload).success).toBe(
      true,
    );
    expect(
      edcTransactionEventPayloadSchema.safeParse({
        ...payload,
        maskedPan: "4111111111111111",
      }).success,
    ).toBe(false);
    expect(
      edcTransactionEventPayloadSchema.safeParse({ ...payload, pan: "x" })
        .success,
    ).toBe(false);
  });
});
