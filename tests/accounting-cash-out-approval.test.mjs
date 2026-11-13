// Contract tests for cash-out approval above the limit (founder Q7, 13 Nov
// 2026; docs/briefs/sub-cash-out-approval.md "Kontrak"). No database. The
// HTTP/DB side is apps/api/src/test/accounting-cash-out-approval.test.ts.
//
// Assumptions where the brief names no export:
// - The entry DTO is `acc.cashBankEntrySchema` (exists today) and gains the
//   fields status/approverId/decidedAt/decisionReason/journalEntryId (nullable).
// - Errors are `acc.accountingErrorHttpStatus` / `acc.AccountingError`.
// - Permissions live in the access catalog and the finance role template.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import * as acc from "../packages/shared/src/accounting/index.ts";
import * as access from "../packages/shared/src/access/index.ts";

const id = () => randomUUID();

const entry = (extra = {}) => ({
  id: id(),
  tenantId: id(),
  legalEntityId: id(),
  outletId: null,
  kind: "cash_out",
  entryDate: "2026-11-10",
  amountIdr: 6_000_000,
  bankAccountId: id(),
  toBankAccountId: null,
  counterAccountId: id(),
  description: "Bayar supplier besar",
  reference: "REF-0001",
  status: "pending_approval",
  approverId: null,
  decidedAt: null,
  decisionReason: null,
  journalEntryId: null,
  createdBy: id(),
  createdAt: "2026-11-10T03:00:00.000Z",
  ...extra,
});

describe("cash-out approval contract", () => {
  test("the entry DTO carries the approval fields; pending has no journal", () => {
    assert.ok(acc.cashBankEntrySchema.safeParse(entry()).success);
    assert.ok(
      acc.cashBankEntrySchema.safeParse(
        entry({
          status: "approved",
          approverId: id(),
          decidedAt: "2026-11-10T04:00:00.000Z",
          journalEntryId: id(),
        }),
      ).success,
    );
    assert.ok(
      acc.cashBankEntrySchema.safeParse(
        entry({
          status: "rejected",
          approverId: id(),
          decidedAt: "2026-11-10T04:00:00.000Z",
          decisionReason: "Tagihan tidak valid",
        }),
      ).success,
    );
  });

  test("an unknown status is refused, and the status field is required", () => {
    assert.equal(
      acc.cashBankEntrySchema.safeParse(entry({ status: "done" })).success,
      false,
    );
    const withoutStatus = entry();
    delete withoutStatus.status;
    assert.equal(
      acc.cashBankEntrySchema.safeParse(withoutStatus).success,
      false,
    );
  });

  test("the three new error codes exist with the contract HTTP status", () => {
    const expected = {
      CASH_OUT_SELF_APPROVAL: 403,
      CASH_ENTRY_NOT_PENDING: 409,
      CASH_ENTRY_NOT_FOUND: 404,
    };
    for (const [code, status] of Object.entries(expected)) {
      assert.equal(acc.accountingErrorHttpStatus[code], status, code);
      const error = new acc.AccountingError(code);
      assert.equal(error.status, status);
      assert.ok(error.message.length > 10 && error.message !== code, code);
    }
  });

  test("approve and limit.manage permissions exist, are finance-only and not in front-line roles", () => {
    for (const code of [
      "accounting.cash_bank.approve",
      "accounting.cash_bank.limit.manage",
    ]) {
      assert.ok(access.isPermissionCode(code), `${code} is in the catalog`);
      assert.ok(
        access.roleTemplate("finance").permissions.includes(code),
        `finance template holds ${code}`,
      );
      for (const key of ["cashier", "waiter", "barista_cook", "employee"])
        assert.equal(
          access.roleTemplate(key).permissions.includes(code),
          false,
          `${key} must not hold ${code}`,
        );
    }
  });

  test("the approval policy permission is not opened to finance (limit goes through its own endpoint)", () => {
    assert.equal(
      access
        .roleTemplate("finance")
        .permissions.includes("access.approval_policy.manage"),
      false,
    );
  });
});
