// legend-zm1e6 swap credit of a staff-resolved order issue
// (docs/briefs/sub-swap-kitchen.md, decisions 1 and 2). Written before the
// implementation, so it starts red.
//
// - A staff swap to a CHEAPER menu credits the difference as a voucher. That
//   credit follows the `apology_voucher` approval matrix: above the threshold
//   it needs one approved request; below it, none. A swap to a dearer menu
//   keeps its price_correction rule (covered by order-recovery.test.ts).
// - A GUEST swap credit is unchanged: system credit, no matrix, no approval.
// - The DB refuses a swap with a positive price difference and no approval id
//   (CHECK order_issues_swap_approval_check), whatever code writes the row.
//
// Assumptions where the brief is silent:
// - The shared world seeds a Rp100.000 apology_voucher threshold, but the
//   largest swap credit its catalogue can make is Rp24.000 (kopi x2 + shot
//   -> roti x2). This file lowers the threshold of its own isolated tenant to
//   Rp10.000 before any request: kopi -> roti (credit 24.000) is above it,
//   roti -> teh (credit 6.000) is below it.
// - An approval already spent by another issue is refused with 409 or 422
//   (wrong object and already used are both "refused"; the issue stays open).
// - The 409 APPROVAL_REQUIRED body carries the pending request id somewhere in
//   `error`; the test finds it by UUID (same as apology-voucher.test.ts).
// - A voucher minted for a swap credit is tied to the issue through
//   apology_vouchers.order_issue_id and exposed as order_issues.voucher_id.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const THRESHOLD = 10_000;
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

beforeAll(async () => {
  w = await createWorld();
  await owner.query(
    "UPDATE approval_policies SET threshold_idr = $2 WHERE tenant_id = $1 AND action_type = 'apology_voucher'",
    [w.tenant.tenantId, THRESHOLD],
  );
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

/** Paid order whose kopi line failed; the credit of a swap to roti is above the threshold. */
async function failedKopi() {
  const paid = await w.paidOrder();
  const { rows } = await owner.query<{
    quantity: number;
    line_total_idr: string;
  }>(
    "SELECT quantity, line_total_idr FROM order_items WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, ulidToUuid(paid.kopi.id)],
  );
  const credit =
    Number(rows[0]!.line_total_idr) - PRICES.roti * Number(rows[0]!.quantity);
  expect(credit).toBeGreaterThan(THRESHOLD);
  const issueId = (await w.report(paid.kopi.id)).body.data.id as string;
  return { ...paid, issueId, credit };
}

/** Paid order whose roti line failed; the credit of a swap to teh is below the threshold. */
async function failedRoti() {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
  return { ...paid, issueId, credit: PRICES.roti - PRICES.teh };
}

const staffSwap = (
  issueId: string,
  replacementItemId: string,
  approvalRequestId?: string,
) =>
  w.staffPost(w.supervisor, `/api/order-issues/${issueId}/resolve`, {
    resolution: "swap",
    replacementItemId,
    ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
  });

const issueRow = async (issueId: string) => {
  const { rows } = await owner.query<{
    status: string;
    resolution: string | null;
    voucher_id: string | null;
    approval_request_id: string | null;
    approved_by: string | null;
  }>(
    "SELECT status, resolution, voucher_id, approval_request_id, approved_by FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  return rows[0]!;
};

const voucherRows = async (issueId: string) => {
  const { rows } = await owner.query<{ approval_request_id: string | null }>(
    "SELECT approval_request_id FROM apology_vouchers WHERE tenant_id = $1 AND order_issue_id = $2",
    [w.tenant.tenantId, issueId],
  );
  return rows;
};

const requestsFor = async (issueId: string) => {
  const { rows } = await owner.query<{
    id: string;
    action_type: string;
    object_type: string;
    status: string;
    amount_idr: string;
  }>(
    "SELECT id, action_type, object_type, status, amount_idr FROM approval_requests WHERE tenant_id = $1 AND object_id = $2 ORDER BY created_at",
    [w.tenant.tenantId, issueId],
  );
  return rows;
};

/** The issue is untouched: open, no resolution, no voucher, no event. */
async function expectStillOpen(issueId: string) {
  expect(await issueRow(issueId)).toMatchObject({
    status: "open",
    resolution: null,
    voucher_id: null,
    approval_request_id: null,
  });
  expect(await voucherRows(issueId)).toHaveLength(0);
  expect(await w.outboxRows("order_issue.resolved", issueId)).toHaveLength(0);
}

describe("legend-zm1e6 kredit swap staf di atas ambang matriks apology_voucher", () => {
  it("tanpa approval: 409 APPROVAL_REQUIRED, permintaan approval tersimpan, issue tetap open, voucher tidak terbit", async () => {
    const { issueId, credit } = await failedKopi();
    const response = await staffSwap(issueId, w.ids.roti);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("APPROVAL_REQUIRED");

    // The request survives the refusal (it is not rolled back) and the error
    // names it.
    const found = JSON.stringify(response.body.error).match(UUID_PATTERN) ?? [];
    const requests = await requestsFor(issueId);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      action_type: "apology_voucher",
      object_type: "order_issue",
      status: "pending",
    });
    expect(Number(requests[0]!.amount_idr)).toBe(credit);
    expect(found).toContain(requests[0]!.id);

    await expectStillOpen(issueId);
  });

  it("minta lagi tanpa approval memakai permintaan yang sama, tidak menggandakan", async () => {
    const { issueId } = await failedKopi();
    const first = await staffSwap(issueId, w.ids.roti);
    const second = await staffSwap(issueId, w.ids.roti);
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("APPROVAL_REQUIRED");
    expect(await requestsFor(issueId)).toHaveLength(1);
    await expectStillOpen(issueId);
  });

  it("dengan approval yang disetujui: swap selesai, voucher senilai kredit terbit, approval_request_id tercatat", async () => {
    const { issueId, credit } = await failedKopi();
    const asked = await staffSwap(issueId, w.ids.roti);
    expect(asked.status).toBe(409);
    const [request] = await requestsFor(issueId);
    const requestId = request!.id;

    // Still pending: not enough.
    const pending = await staffSwap(issueId, w.ids.roti, requestId);
    expect([409, 422]).toContain(pending.status);
    await expectStillOpen(issueId);

    await w.approveExisting(requestId);
    const approved = await staffSwap(issueId, w.ids.roti, requestId);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      id: issueId,
      status: "resolved",
      resolution: "swap",
      replacementItemId: w.ids.roti,
      priceDifferenceIdr: -credit,
      voucherId: expect.any(String),
    });

    const row = await issueRow(issueId);
    expect(row).toMatchObject({
      status: "resolved",
      resolution: "swap",
      approval_request_id: requestId,
      approved_by: w.approverUserId,
    });
    expect(row.voucher_id).toBe(approved.body.data.voucherId);
    // The voucher exists, is tied to the issue and carries the approval.
    expect(await voucherRows(issueId)).toEqual([
      { approval_request_id: requestId },
    ]);
    expect(await w.outboxRows("order_issue.resolved", issueId)).toHaveLength(1);
  });

  it("request lama ditolak, kedaluwarsa, atau dibatalkan: minta lagi membuka request baru, bukan id mati", async () => {
    for (const dead of ["rejected", "expired", "cancelled"]) {
      const { issueId } = await failedKopi();
      const first = await staffSwap(issueId, w.ids.roti);
      expect(first.status).toBe(409);
      const [old] = await requestsFor(issueId);
      await owner.query(
        dead === "rejected"
          ? "UPDATE approval_requests SET status = 'rejected', decided_by = $3, decided_at = now(), reason = 'Ditolak' WHERE tenant_id = $1 AND id = $2"
          : `UPDATE approval_requests SET status = '${dead}' WHERE tenant_id = $1 AND id = $2`,
        dead === "rejected"
          ? [w.tenant.tenantId, old!.id, w.approverUserId]
          : [w.tenant.tenantId, old!.id],
      );

      const again = await staffSwap(issueId, w.ids.roti);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("APPROVAL_REQUIRED");
      const requests = await requestsFor(issueId);
      expect(requests).toHaveLength(2);
      const fresh = requests.find((r) => r.id !== old!.id)!;
      expect(fresh.status).toBe("pending");
      expect(JSON.stringify(again.body.error)).toContain(fresh.id);
      expect(JSON.stringify(again.body.error)).not.toContain(old!.id);

      // The new request still replays (no duplicate) and can be approved.
      await staffSwap(issueId, w.ids.roti);
      expect(await requestsFor(issueId)).toHaveLength(2);
      await w.approveExisting(fresh.id);
      const done = await staffSwap(issueId, w.ids.roti, fresh.id);
      expect(done.status).toBe(200);
    }
  });

  it("approval yang sudah dipakai issue lain ditolak, issue kedua tetap open tanpa voucher", async () => {
    const first = await failedKopi();
    await staffSwap(first.issueId, w.ids.roti);
    const [request] = await requestsFor(first.issueId);
    await w.approveExisting(request!.id);
    const used = await staffSwap(first.issueId, w.ids.roti, request!.id);
    expect(used.status).toBe(200);

    const second = await failedKopi();
    const reuse = await staffSwap(second.issueId, w.ids.roti, request!.id);
    expect([409, 422]).toContain(reuse.status);
    await expectStillOpen(second.issueId);
    // The approval still backs exactly one voucher.
    expect(await voucherRows(first.issueId)).toHaveLength(1);
  });

  it("approval aksi lain, nominal lain, atau tak dikenal ditolak dan issue tetap open", async () => {
    const { issueId, credit } = await failedKopi();
    const wrongAction = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: credit,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const wrongAmount = await w.insertApproval({
      actionType: "apology_voucher",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: THRESHOLD,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    for (const approvalId of [
      wrongAction,
      wrongAmount,
      "00000000-0000-4000-8000-000000000000",
    ]) {
      const response = await staffSwap(issueId, w.ids.roti, approvalId);
      expect([404, 409, 422]).toContain(response.status);
    }
    await expectStillOpen(issueId);
  });
});

describe("legend-zm1e6 kredit swap staf di bawah ambang", () => {
  it("tanpa approval: 200, voucher senilai kredit terbit, tidak ada permintaan approval", async () => {
    const { issueId, credit } = await failedRoti();
    expect(credit).toBeLessThan(THRESHOLD);
    const response = await staffSwap(issueId, w.ids.teh);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "resolved",
      resolution: "swap",
      replacementItemId: w.ids.teh,
      priceDifferenceIdr: -credit,
      voucherId: expect.any(String),
    });
    expect(await issueRow(issueId)).toMatchObject({
      status: "resolved",
      approval_request_id: null,
    });
    expect(await voucherRows(issueId)).toEqual([{ approval_request_id: null }]);
    expect(await requestsFor(issueId)).toHaveLength(0);
  });
});

describe("legend-zm1e6 swap tamu tidak berubah", () => {
  it("kredit di atas ambang: tamu menyelesaikan sendiri tanpa matriks dan tanpa approval", async () => {
    const { guest, issueId, credit } = await failedKopi();
    const chosen = await w.as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.roti,
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data).toMatchObject({
      status: "resolved",
      resolution: "swap",
      priceDifferenceIdr: -credit,
      voucherId: expect.any(String),
    });
    expect(await issueRow(issueId)).toMatchObject({
      status: "resolved",
      approval_request_id: null,
    });
    expect(await voucherRows(issueId)).toEqual([{ approval_request_id: null }]);
    expect(await requestsFor(issueId)).toHaveLength(0);
  });
});

describe("legend-zm1e6 CHECK order_issues_swap_approval_check", () => {
  const swapUpdate = (
    issueId: string,
    differenceIdr: number,
    approvalRequestId: string | null,
  ) =>
    owner.query(
      `UPDATE order_issues
       SET resolution = 'swap', replacement_item_id = $3,
           price_difference_idr = $4, approval_request_id = $5
       WHERE tenant_id = $1 AND id = $2`,
      [
        w.tenant.tenantId,
        issueId,
        w.ids.kopi,
        differenceIdr,
        approvalRequestId,
      ],
    );

  it("UPDATE swap dengan selisih positif tanpa approval_request_id ditolak; dengan approval atau selisih tidak positif diterima", async () => {
    const { issueId } = await failedRoti();

    await expect(swapUpdate(issueId, 7_000, null)).rejects.toMatchObject({
      constraint: "order_issues_swap_approval_check",
    });
    expect(await issueRow(issueId)).toMatchObject({ resolution: null });

    // Same row, only the approval differs: accepted.
    const approvalId = await w.insertApproval({
      actionType: "price_correction",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: 7_000,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    await swapUpdate(issueId, 7_000, approvalId);
    expect(await issueRow(issueId)).toMatchObject({
      resolution: "swap",
      approval_request_id: approvalId,
    });

    // A zero or negative difference (credit) needs no approval id at the DB.
    const other = await failedRoti();
    await swapUpdate(other.issueId, 0, null);
    await swapUpdate(other.issueId, -6_000, null);
    expect(await issueRow(other.issueId)).toMatchObject({
      resolution: "swap",
      approval_request_id: null,
    });
  });
});
