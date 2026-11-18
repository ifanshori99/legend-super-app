// EDC agent contract (bead legend-apt): masked PAN only, final statuses are
// terminal, `unknown` resolves only through the terminal, domain errors map
// to core codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as edc from "../packages/shared/src/edc/index.ts";
import { CoreError } from "../packages/shared/src/core/index.ts";

test("maskedPanSchema accepts receipt masks and refuses a full PAN", () => {
  for (const ok of ["411111******1111", "************1111", "XXXX1234"])
    assert.equal(edc.maskedPanSchema.safeParse(ok).success, true, ok);
  for (const bad of ["4111111111111111", "4111111*****1111", "1111", ""])
    assert.equal(edc.maskedPanSchema.safeParse(bad).success, false, bad);
});

test("EDC-03 final statuses never move and unknown never becomes pending", () => {
  for (const status of edc.edcFinalStatuses) {
    assert.equal(edc.isEdcFinalStatus(status), true);
    for (const to of edc.edcTransactionStatusSchema.options)
      assert.equal(edc.canTransitionEdc(status, to), false, `${status}->${to}`);
  }
  assert.equal(edc.canTransitionEdc("unknown", "pending"), false);
  assert.equal(edc.canTransitionEdc("pending", "unknown"), true);
  assert.equal(edc.canTransitionEdc("unknown", "approved"), true);
  assert.equal(edc.isEdcFinalStatus("unknown"), false);
});

test("edcPaymentRequestSchema wants a positive whole-rupiah amount", () => {
  const base = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    outletId: "22222222-2222-4222-8222-222222222222",
    terminalId: "33333333-3333-4333-8333-333333333333",
    reference: "BILL-1",
    idempotencyKey: "edc-key-0001",
    amountIdr: 125000,
    method: "card",
  };
  assert.equal(edc.edcPaymentRequestSchema.safeParse(base).success, true);
  for (const amountIdr of [0, -1, 1000.5])
    assert.equal(
      edc.edcPaymentRequestSchema.safeParse({ ...base, amountIdr }).success,
      false,
      String(amountIdr),
    );
  assert.equal(
    edc.edcPaymentRequestSchema.safeParse({ ...base, extra: 1 }).success,
    false,
  );
});

test("ECR results refuse card data beyond a masked PAN", () => {
  assert.equal(
    edc.ecrResultSchema.safeParse({
      outcome: "approved",
      maskedPan: "4111111111111111",
    }).success,
    false,
  );
  const parsed = edc.ecrInquiryResultSchema.parse({ outcome: "not_found" });
  assert.equal(parsed.approvalCode, null);
});

test("EdcError is a CoreError with a stable reason", () => {
  const error = new edc.EdcError("EDC_STATUS_UNKNOWN");
  assert.ok(error instanceof CoreError);
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.status, 409);
  assert.equal(error.reason, "EDC_STATUS_UNKNOWN");
  assert.equal(
    new edc.EdcError("EDC_PROVIDER_UNKNOWN").code,
    "SERVICE_UNAVAILABLE",
  );
  const transport = new edc.EcrTransportError("timeout", "no answer");
  assert.equal(transport.kind, "timeout");
});

test("terminal free text never keeps a card-number-like digit run", () => {
  const parsed = edc.ecrResultSchema.parse({
    outcome: "approved",
    message: "CARD 4111 1111 1111 1111 OK, ref 4111-1111-1111-1111",
    amountIdr: 1000,
  });
  assert.doesNotMatch(parsed.message ?? "", /\d(?:[\s/_-]*\d){11,}/);
  for (const message of [
    "CARD 4111  1111  1111  1111 OK",
    "CARD 4111 - 1111 - 1111 - 1111 OK",
    "CARD 4111\t1111 -\t1111  - 1111 OK",
    "CARD 4111/1111/1111/1111 OK",
    "CARD 4111_1111_1111_1111 OK",
    "CARD 4111\n1111\n1111\n1111 OK",
  ]) {
    const masked = edc.ecrResultSchema.parse({
      outcome: "approved",
      message,
      amountIdr: 1000,
    });
    assert.doesNotMatch(masked.message ?? "", /\d(?:[\s/_-]*\d){11,}/);
  }
  assert.equal(
    edc.ecrResultSchema.parse({ outcome: "declined", message: "RC 51" })
      .message,
    "RC 51",
  );
  assert.equal(
    edc.ecrResultSchema.safeParse({ outcome: "approved", trace: "bad-trace" })
      .success,
    false,
  );
});
