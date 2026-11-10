// legend-4qu apology vouchers (PRD §3.9 "Voucher Permintaan Maaf"): a
// supervisor issues a recovery voucher up to the approval-matrix limit, above
// it only with an approved WS-01 request; the code is readable again by staff
// but never stored in plain text. Written from the shared contract
// (qr-order/endpoints.ts: issueApologyVoucher, getApologyVoucher) before the
// implementation, so it starts red.
//
// Assumptions where the contract is silent:
// - The tenant's apology_voucher approval matrix is one row: nothing below
//   Rp100.000 needs approval, from Rp100.000 one approval (see helpers).
// - Every voucher here is tied to an order issue (outlet is then unambiguous).
// - The 409 APPROVAL_REQUIRED body carries the pending request id somewhere
//   in `error` (brief: "dengan requestId"); the test finds it by UUID.
// - An approval of another action type is refused with 409 or 422.
// - Same orderIssueId twice returns the same voucher (200 or 201).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apologyVoucherSchema } from "@starter/shared/qr-order";
import {
  PRICES,
  VOUCHER_APPROVAL_FLOOR_IDR,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { ulidToUuid } from "@starter/shared/core";
import { agent, originHeader } from "./helpers.ts";
import { owner, seededHostname, staffWithRole } from "./floor-test-helpers.ts";

let w: World;
const REASON = "Roti habis, mohon maaf atas ketidaknyamanan";
const BELOW = 20_000;
const ABOVE = VOUCHER_APPROVAL_FLOOR_IDR + 50_000;
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

async function failedItem() {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
  return { ...paid, issueId };
}

const issueVoucher = (body: Record<string, unknown>, who = w.supervisor) =>
  w.staffPost(who, "/api/apology-vouchers", body);

const voucherCount = async (issueId: string) => {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM apology_vouchers WHERE tenant_id = $1 AND order_issue_id = $2",
    [w.tenant.tenantId, issueId],
  );
  return Number(rows[0]!.n);
};

describe("legend-4qu voucher maaf di bawah batas matriks", () => {
  it("supervisor menerbitkan voucher: kontrak terpenuhi, status issued, kadaluarsa sesuai hari", async () => {
    const { issueId } = await failedItem();
    const response = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
      expiresInDays: 14,
    });
    expect(response.status).toBe(201);
    const voucher = apologyVoucherSchema.parse(response.body.data);
    expect(voucher).toMatchObject({
      valueIdr: BELOW,
      status: "issued",
      reason: REASON,
      orderIssueId: issueId,
      issuedBy: w.supervisor.userId,
      approvalRequestId: null,
      redeemedAt: null,
      redemptionOrderId: null,
      outletId: w.tenant.outletId,
    });
    const days =
      (new Date(voucher.expiresAt).getTime() -
        new Date(voucher.issuedAt).getTime()) /
      86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it("expiresInDays default 30 hari", async () => {
    const { issueId } = await failedItem();
    const response = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    expect(response.status).toBe(201);
    const voucher = apologyVoucherSchema.parse(response.body.data);
    const days =
      (new Date(voucher.expiresAt).getTime() -
        new Date(voucher.issuedAt).getTime()) /
      86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("menerbitkan dua kali untuk issue yang sama mengembalikan voucher yang sama", async () => {
    const { issueId } = await failedItem();
    const body = { valueIdr: BELOW, reason: REASON, orderIssueId: issueId };
    const first = await issueVoucher(body);
    const second = await issueVoucher(body);
    expect(first.status).toBe(201);
    expect([200, 201]).toContain(second.status);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.code).toBe(first.body.data.code);
    expect(await voucherCount(issueId)).toBe(1);
  });

  it("kode terbaca lagi lewat GET by code, dan tersimpan hanya terenkripsi/hash", async () => {
    const { issueId } = await failedItem();
    const issued = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    const created = apologyVoucherSchema.parse(issued.body.data);

    const looked = await w.staffGet(
      w.supervisor,
      `/api/apology-vouchers/${created.code}`,
    );
    expect(looked.status).toBe(200);
    expect(apologyVoucherSchema.parse(looked.body.data)).toEqual(created);

    // The plain code is in no column of either voucher table.
    const { rows } = await owner.query<{ doc: string }>(
      `SELECT row_to_json(a)::text AS doc FROM apology_vouchers a WHERE a.tenant_id = $1 AND a.id = $2
       UNION ALL
       SELECT row_to_json(v)::text FROM vouchers v
       WHERE v.tenant_id = $1 AND v.id = (SELECT voucher_id FROM apology_vouchers WHERE id = $2)`,
      [w.tenant.tenantId, created.id],
    );
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.doc).not.toContain(created.code);
    const compact = created.code.replaceAll("-", "");
    for (const row of rows) expect(row.doc).not.toContain(compact);
  });

  it("voucher tercatat di tabel voucher CRM sebagai sumber apology dengan nilai yang sama", async () => {
    const { issueId } = await failedItem();
    const issued = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    const { rows } = await owner.query<{
      source: string;
      value_idr: number;
      valid_until: Date;
    }>(
      `SELECT v.source, v.value_idr, v.valid_until
       FROM vouchers v JOIN apology_vouchers a ON a.voucher_id = v.id AND a.tenant_id = v.tenant_id
       WHERE a.tenant_id = $1 AND a.id = $2`,
      [w.tenant.tenantId, issued.body.data.id],
    );
    expect(rows[0]!.source).toBe("apology");
    expect(Number(rows[0]!.value_idr)).toBe(BELOW);
    expect(rows[0]!.valid_until.toISOString()).toBe(
      new Date(issued.body.data.expiresAt).toISOString(),
    );
  });

  it("voucher yang lewat masa berlaku terbaca berstatus expired", async () => {
    const { issueId } = await failedItem();
    const issued = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    // The contract needs expiresAt > issuedAt: age the issue time as well.
    await owner.query(
      "UPDATE apology_vouchers SET issued_at = now() - interval '5 days' WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, issued.body.data.id],
    );
    await owner.query(
      `UPDATE vouchers SET valid_from = now() - interval '3 days', valid_until = now() - interval '1 day'
       WHERE tenant_id = $1 AND id = (SELECT voucher_id FROM apology_vouchers WHERE id = $2)`,
      [w.tenant.tenantId, issued.body.data.id],
    );
    const looked = await w.staffGet(
      w.supervisor,
      `/api/apology-vouchers/${issued.body.data.code}`,
    );
    expect(looked.status).toBe(200);
    expect(looked.body.data.status).toBe("expired");
  });

  it("GET kode yang tidak ada 404", async () => {
    const looked = await w.staffGet(
      w.supervisor,
      "/api/apology-vouchers/ZZZ-AAAA-BBBB",
    );
    expect(looked.status).toBe(404);
  });
});

describe("legend-4qu voucher maaf di atas batas matriks", () => {
  it("tanpa approval 409 APPROVAL_REQUIRED, permintaan approval terbuka, tidak ada voucher", async () => {
    const { issueId } = await failedItem();
    const response = await issueVoucher({
      valueIdr: ABOVE,
      reason: REASON,
      orderIssueId: issueId,
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("APPROVAL_REQUIRED");
    expect(await voucherCount(issueId)).toBe(0);

    const found = JSON.stringify(response.body.error).match(UUID_PATTERN) ?? [];
    expect(found.length, "requestId in the error body").toBeGreaterThan(0);
    const { rows } = await owner.query<{
      id: string;
      action_type: string;
      status: string;
      amount_idr: string;
    }>(
      "SELECT id, action_type, status, amount_idr FROM approval_requests WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [w.tenant.tenantId, found],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action_type: "apology_voucher",
      status: "pending",
    });
    expect(Number(rows[0]!.amount_idr)).toBe(ABOVE);
  });

  it("dengan approval yang disetujui voucher terbit dan mencatat approvalRequestId", async () => {
    const { issueId } = await failedItem();
    const body = { valueIdr: ABOVE, reason: REASON, orderIssueId: issueId };
    const first = await issueVoucher(body);
    expect(first.status).toBe(409);
    const found = JSON.stringify(first.body.error).match(UUID_PATTERN) ?? [];
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM approval_requests WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [w.tenant.tenantId, found],
    );
    const requestId = rows[0]!.id;

    // Still pending: not enough.
    const pending = await issueVoucher({
      ...body,
      approvalRequestId: requestId,
    });
    expect([409, 422]).toContain(pending.status);
    expect(await voucherCount(issueId)).toBe(0);

    await w.approveExisting(requestId);
    const approved = await issueVoucher({
      ...body,
      approvalRequestId: requestId,
    });
    expect(approved.status).toBe(201);
    expect(apologyVoucherSchema.parse(approved.body.data)).toMatchObject({
      valueIdr: ABOVE,
      status: "issued",
      approvalRequestId: requestId,
      orderIssueId: issueId,
    });
  });

  it("approval untuk aksi lain, nominal lain, atau tak dikenal ditolak dan tidak ada voucher", async () => {
    const { issueId } = await failedItem();
    const body = { valueIdr: ABOVE, reason: REASON, orderIssueId: issueId };

    const refundApproval = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: ABOVE,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const wrongAction = await issueVoucher({
      ...body,
      approvalRequestId: refundApproval,
    });
    expect([409, 422]).toContain(wrongAction.status);

    const smallApproval = await w.insertApproval({
      actionType: "apology_voucher",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: BELOW,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const wrongAmount = await issueVoucher({
      ...body,
      approvalRequestId: smallApproval,
    });
    expect([409, 422]).toContain(wrongAmount.status);

    const unknown = await issueVoucher({
      ...body,
      approvalRequestId: randomUUID(),
    });
    expect([404, 409, 422]).toContain(unknown.status);

    expect(await voucherCount(issueId)).toBe(0);
  });
});

describe("legend-4qu voucher maaf: validasi, izin, isolasi", () => {
  it("nilai nol, alasan pendek, hari di luar 1-90, dan field asing ditolak 422", async () => {
    const { issueId } = await failedItem();
    const base = { valueIdr: BELOW, reason: REASON, orderIssueId: issueId };
    for (const bad of [
      { valueIdr: 0 },
      { reason: "pendek" },
      { expiresInDays: 0 },
      { expiresInDays: 91 },
      { unknownField: true },
    ]) {
      const response = await issueVoucher({ ...base, ...bad });
      expect(response.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await voucherCount(issueId)).toBe(0);
  });

  it("tanpa login 401; staf tanpa order.apology_voucher.issue 403 untuk terbit dan baca", async () => {
    const { issueId } = await failedItem();
    const anonymous = await agent(w.app)
      .post("/api/apology-vouchers")
      .set("Host", w.tenant.hostname)
      .set(originHeader)
      .send({ valueIdr: BELOW, reason: REASON, orderIssueId: issueId });
    expect(anonymous.status).toBe(401);

    const denied = await issueVoucher(
      { valueIdr: BELOW, reason: REASON, orderIssueId: issueId },
      w.floorStaff,
    );
    expect(denied.status).toBe(403);
    expect(await voucherCount(issueId)).toBe(0);

    const issued = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    const read = await w.staffGet(
      w.floorStaff,
      `/api/apology-vouchers/${issued.body.data.code}`,
    );
    // Without the permission the code is not revealed: 404 (403 accepted).
    expect([403, 404]).toContain(read.status);
  });

  it("staf yang scope-nya outlet lain tidak bisa menerbitkan untuk issue outlet ini", async () => {
    const { issueId } = await failedItem();
    const response = await issueVoucher(
      { valueIdr: BELOW, reason: REASON, orderIssueId: issueId },
      w.otherOutletSupervisor,
    );
    expect([403, 404]).toContain(response.status);
    expect(await voucherCount(issueId)).toBe(0);
  });

  it("tenant lain tidak bisa menerbitkan untuk issue tenant ini atau membaca kodenya: 404", async () => {
    const { issueId } = await failedItem();
    const issued = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    const intruder = await staffWithRole(w.app, {
      template: "supervisor",
      label: "Supervisor Tenant Lain",
    });

    const read = await w.staffGet(
      intruder,
      `/api/apology-vouchers/${issued.body.data.code}`,
      seededHostname,
    );
    expect(read.status).toBe(404);

    const { issueId: other } = await failedItem();
    const forged = await w.staffPost(
      intruder,
      "/api/apology-vouchers",
      { valueIdr: BELOW, reason: REASON, orderIssueId: other },
      seededHostname,
    );
    expect(forged.status).toBe(404);
    expect(await voucherCount(other)).toBe(0);
  });

  it("tabel apology_vouchers append-only untuk aplikasi: UPDATE dan DELETE oleh role app ditolak", async () => {
    const { issueId } = await failedItem();
    const issued = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [w.tenant.tenantId],
      );
      await expect(
        client.query("UPDATE apology_vouchers SET reason = $2 WHERE id = $1", [
          issued.body.data.id,
          "Alasan diganti diam-diam",
        ]),
      ).rejects.toThrow(/permission denied/i);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [w.tenant.tenantId],
      );
      await expect(
        client.query("DELETE FROM apology_vouchers WHERE id = $1", [
          issued.body.data.id,
        ]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("legend-4qu voucher dari pilihan tamu", () => {
  it("voucher pilihan tamu bernilai item, punya kode yang sama saat dibaca staf, dan tanpa approval", async () => {
    const { guest, roti, issueId } = await failedItem();
    const chosen = await w.as(guest).choose(issueId, { choice: "voucher" });
    expect(chosen.status).toBe(200);
    const list = await w.as(guest).issues();
    const row = (
      list.body.data as { id: string; voucher: { code: string } }[]
    ).find((item) => item.id === issueId)!;
    const looked = await w.staffGet(
      w.supervisor,
      `/api/apology-vouchers/${row.voucher.code}`,
    );
    expect(looked.status).toBe(200);
    expect(looked.body.data).toMatchObject({
      valueIdr: PRICES.roti,
      approvalRequestId: null,
      orderIssueId: issueId,
      issuedBy: w.supervisor.userId,
    });
    expect(roti.id).toBeTruthy();

    // The issue already has its voucher: staff cannot mint a second one.
    const second = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    expect([200, 201, 409]).toContain(second.status);
    expect(await voucherCount(issueId)).toBe(1);
  });
});

describe("legend-4qu voucher maaf menyelesaikan issue dan approval sekali pakai", () => {
  it("voucher staf dengan orderIssueId menyelesaikan issue: resolved, resolution voucher, tamu melihat kodenya", async () => {
    const { guest, issueId } = await failedItem();
    const issued = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    expect(issued.status).toBe(201);

    const { rows } = await owner.query<{
      status: string;
      resolution: string;
      voucher_id: string | null;
    }>(
      "SELECT status, resolution, voucher_id FROM order_issues WHERE id = $1",
      [issueId],
    );
    expect(rows[0]).toMatchObject({
      status: "resolved",
      resolution: "voucher",
    });
    expect(rows[0]!.voucher_id).toEqual(expect.any(String));

    const list = await w.as(guest).issues();
    const row = (
      list.body.data as {
        id: string;
        status: string;
        resolution: string;
        voucher: { code: string; valueIdr: number };
      }[]
    ).find((item) => item.id === issueId)!;
    expect(row).toMatchObject({ status: "resolved", resolution: "voucher" });
    expect(row.voucher).toMatchObject({
      code: issued.body.data.code,
      valueIdr: BELOW,
    });

    // Replay: same value returns the same voucher, another value is a conflict.
    const same = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    expect([200, 201]).toContain(same.status);
    expect(same.body.data.id).toBe(issued.body.data.id);
    const different = await issueVoucher({
      valueIdr: BELOW + 5_000,
      reason: REASON,
      orderIssueId: issueId,
    });
    expect(different.status).toBe(409);
    expect(await voucherCount(issueId)).toBe(1);
  });

  it("issue yang sudah resolved (pilihan tamu swap) tidak bisa diberi voucher staf: 409", async () => {
    const { guest, issueId } = await failedItem();
    const chosen = await w.as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.kopi,
    });
    expect(chosen.status).toBe(200);
    const response = await issueVoucher({
      valueIdr: BELOW,
      reason: REASON,
      orderIssueId: issueId,
    });
    expect(response.status).toBe(409);
    expect(await voucherCount(issueId)).toBe(0);
  });

  it("satu approval untuk dua voucher berbeda bersamaan: satu 201, satu 409 APPROVAL_ALREADY_USED", async () => {
    // Standalone vouchers (no order issue) are approved against the outlet, so
    // one approval can be presented for two different vouchers at once.
    const body = { valueIdr: ABOVE, reason: REASON };
    const issue = (approvalRequestId?: string) =>
      issueVoucher({ ...body, approvalRequestId }, w.outletSupervisor);
    const open = await issue();
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe("APPROVAL_REQUIRED");
    const found = JSON.stringify(open.body.error).match(UUID_PATTERN) ?? [];
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM approval_requests WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [w.tenant.tenantId, found],
    );
    const requestId = rows[0]!.id;
    await w.approveExisting(requestId);

    const results = await Promise.all([issue(requestId), issue(requestId)]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const loser = results.find((result) => result.status === 409)!;
    expect(loser.body.error.code).toBe("APPROVAL_ALREADY_USED");

    // The spent approval cannot be reused later either.
    const reuse = await issue(requestId);
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("APPROVAL_ALREADY_USED");
    const { rows: used } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM apology_vouchers WHERE tenant_id = $1 AND approval_request_id = $2",
      [w.tenant.tenantId, requestId],
    );
    expect(Number(used[0]!.n)).toBe(1);
  });
});

describe("legend-4qu staf menyelesaikan issue dengan voucher yang ada", () => {
  const standalone = async () => {
    const issued = await issueVoucher(
      { valueIdr: BELOW, reason: REASON },
      w.outletSupervisor,
    );
    expect(issued.status).toBe(201);
    const { rows } = await owner.query<{ voucher_id: string }>(
      "SELECT voucher_id FROM apology_vouchers WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, issued.body.data.id],
    );
    return {
      apologyId: issued.body.data.id as string,
      voucherId: rows[0]!.voucher_id,
    };
  };
  const resolveWith = (issueId: string, voucherId: string) =>
    w.staffPost(w.supervisor, `/api/order-issues/${issueId}/resolve`, {
      resolution: "voucher",
      voucherId,
    });
  const statusOf = async (issueId: string) =>
    (
      await owner.query<{ status: string }>(
        "SELECT status FROM order_issues WHERE id = $1",
        [issueId],
      )
    ).rows[0]!.status;

  it("voucher yang masih berlaku menyelesaikan issue; voucher yang sama untuk issue kedua 409", async () => {
    const first = await failedItem();
    const second = await failedItem();
    const { apologyId } = await standalone();
    const ok = await resolveWith(first.issueId, apologyId);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      status: "resolved",
      resolution: "voucher",
    });
    const reused = await resolveWith(second.issueId, apologyId);
    expect(reused.status).toBe(409);
    expect(await statusOf(second.issueId)).toBe("open");
  });

  it("voucher yang sudah redeemed ditolak 422 dan issue tetap open", async () => {
    const { issueId, order } = await failedItem();
    const { apologyId, voucherId } = await standalone();
    await owner.query(
      `UPDATE vouchers SET status = 'redeemed', redeemed_at = now(), redeemed_order_id = $3
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, voucherId, ulidToUuid(order.id)],
    );
    const response = await resolveWith(issueId, apologyId);
    expect(response.status).toBe(422);
    expect(await statusOf(issueId)).toBe("open");
  });

  it("voucher yang sudah kedaluwarsa ditolak 422 dan issue tetap open", async () => {
    const { issueId } = await failedItem();
    const { apologyId, voucherId } = await standalone();
    await owner.query(
      `UPDATE vouchers SET valid_from = now() - interval '3 days', valid_until = now() - interval '1 day'
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, voucherId],
    );
    const response = await resolveWith(issueId, apologyId);
    expect(response.status).toBe(422);
    expect(await statusOf(issueId)).toBe("open");
  });
});
