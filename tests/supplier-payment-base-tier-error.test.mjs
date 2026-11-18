// legend-98etn: the supplier_payment base-tier rule in the shared contract and
// the catalog text the matrix screen shows for it. Written from the brief, not
// from the implementation.
//   node --test tests/supplier-payment-base-tier-error.test.mjs
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACCESS_ERROR_CODES,
  AccessError,
  accessErrorHttpStatus,
  approvalMatrixSchema,
  supplierPaymentBaseTierMissing,
} from "../packages/shared/src/access/index.ts";
import { createTranslator } from "../packages/shared/src/i18n/index.ts";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import { accessErrorMessage } from "../apps/web/src/features/ws01-access/errors.ts";

const CODE = "SUPPLIER_PAYMENT_BASE_TIER_REQUIRED";
const TEXT =
  "Pembayaran supplier wajib punya tingkat dasar: tingkat 1 untuk semua nominal (batas 0). Tambahkan tingkat 1 dengan batas 0, supaya satu orang tidak bisa membayar supplier sendirian.";
const t = createTranslator();
const row = (thresholdIdr, levels, actionType = "supplier_payment") => ({
  actionType,
  thresholdIdr,
  levels,
});

describe("error code", () => {
  test("is an access error code answering 422", () => {
    assert.ok(ACCESS_ERROR_CODES.includes(CODE));
    assert.equal(accessErrorHttpStatus[CODE], 422);
  });

  test("AccessError carries the Indonesian default message", () => {
    const error = new AccessError(CODE);
    assert.equal(error.code, CODE);
    assert.equal(error.message, TEXT);
  });

  test("catalog key access.error.<CODE> resolves to the Indonesian text", () => {
    assert.equal(t(`access.error.${CODE}`), TEXT);
  });

  test("the matrix screen maps the API error to the catalog text, not the server text", () => {
    const error = new ApiError(422, CODE, "server said something else");
    assert.equal(accessErrorMessage(error, t), TEXT);
  });
});

describe("supplierPaymentBaseTierMissing", () => {
  test("true when supplier_payment rows exist but none is level 1 at floor null/0", () => {
    assert.equal(supplierPaymentBaseTierMissing([row(5_000_000, 1)]), true);
    assert.equal(
      supplierPaymentBaseTierMissing([row(5_000_000, 1), row(5_000_000, 2)]),
      true,
    );
    assert.equal(supplierPaymentBaseTierMissing([row(0, 2)]), true);
    assert.equal(supplierPaymentBaseTierMissing([row(null, 2)]), true);
  });

  test("false with a base tier (floor 0 or null, level 1)", () => {
    assert.equal(supplierPaymentBaseTierMissing([row(0, 1)]), false);
    assert.equal(supplierPaymentBaseTierMissing([row(null, 1)]), false);
    assert.equal(
      supplierPaymentBaseTierMissing([row(0, 1), row(5_000_000, 2)]),
      false,
    );
  });

  test("false when there are no supplier_payment rows; other action types never count", () => {
    assert.equal(supplierPaymentBaseTierMissing([]), false);
    assert.equal(
      supplierPaymentBaseTierMissing([row(100_000, 1, "cash_out")]),
      false,
    );
    assert.equal(
      supplierPaymentBaseTierMissing([
        row(5_000_000, 1),
        row(0, 1, "cash_out"),
      ]),
      true,
    );
  });

  test("the matrix schema backstop still refuses a matrix without a base tier", () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const policy = (thresholdIdr) => ({
      id: "22222222-2222-4222-8222-222222222222",
      actionType: "supplier_payment",
      thresholdIdr,
      approverRoleId: roleId,
      levels: 1,
      requiresDistinctActor: true,
    });
    assert.equal(
      approvalMatrixSchema.safeParse([policy(5_000_000)]).success,
      false,
    );
    assert.equal(approvalMatrixSchema.safeParse([policy(0)]).success, true);
  });
});
