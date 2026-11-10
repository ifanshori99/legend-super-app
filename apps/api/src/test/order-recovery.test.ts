// legend-4qu failed-item recovery: ORD-08 (guest is told within 60 s and is
// offered only swap or voucher credit, never a refund) and ORD-09 (manual
// refund only by staff, with an approved approval request and a written
// reason). Written from the shared contract (packages/shared/src/qr-order) and
// docs/PRD.md Alur Y, before the implementation, so it starts red.
//
// Assumptions where the contract is silent:
// - Replacement item that is sold out or unknown is refused with 422 (409 is
//   accepted for sold out). A guest of another table session, or another
//   tenant, gets NOT_FOUND (403 accepted for the same-tenant guest).
// - A staff member outside the item's outlet scope is refused with 403 (404
//   accepted: hiding the row is also a valid refusal).
// - Manual refund approval must have amountIdr equal to the item line total
//   and objectType `order_issue` with objectId = issue id (brief, ORD-09).
//   An approval decided by the acting supervisor himself is refused (422).
// - The realtime pg_notify signal to the guest phone is not asserted here:
//   its channel is internal. The outbox `item.failed` event is the contract.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apologyVoucherSchema,
  guestOrderIssueSchema,
  itemFailedPayloadSchema,
} from "@starter/shared/qr-order";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { ulidToUuid } from "@starter/shared/core";
import { agent } from "./helpers.ts";
import { owner, seededHostname, staffWithRole } from "./floor-test-helpers.ts";

let w: World;
const VOUCHER_CODE = /^[A-Z0-9]{3,6}(-[A-Z0-9]{4,6})+$/;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

type IssueRow = ReturnType<typeof guestOrderIssueSchema.parse>;

async function guestIssue(
  guest: Parameters<World["as"]>[0],
  issueId: string,
): Promise<IssueRow> {
  const list = await w.as(guest).issues();
  expect(list.status).toBe(200);
  const rows = list.body.data as unknown[];
  const row = rows
    .map((item) => guestOrderIssueSchema.parse(item))
    .find((item) => item.id === issueId);
  expect(row, "issue visible to the guest of its session").toBeDefined();
  return row!;
}

// order_issues.order_item_id stores the ULID as a uuid, so rows are counted
// per tenant (the tests of this file run one after another).
async function issueCount(type = "unfulfillable") {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM order_issues WHERE tenant_id = $1 AND type = $2",
    [w.tenant.tenantId, type],
  );
  return Number(rows[0]!.n);
}

/** Well-formed ULID that belongs to no order item. */
const UNKNOWN_ORDER_ITEM_ID = "01M71S3S07CJ1NQ03ZA35E0HF3";

describe("legend-4qu ORD-08 laporan item gagal sesudah bayar", () => {
  it("ORD-08 laporan membuat issue open dan event item.failed dalam 60 detik dengan dua pilihan saja", async () => {
    const { roti } = await w.paidOrder();
    const startedAt = Date.now();
    const reported = await w.report(roti.id);
    expect(reported.status).toBe(201);
    expect(reported.body.data).toMatchObject({
      orderItemId: roti.id,
      type: "unfulfillable",
      status: "open",
      resolution: null,
      reportedBy: w.supervisor.userId,
      employeeId: null,
    });
    const issueId = reported.body.data.id as string;

    const [failed, ...extra] = await w.outboxRows("item.failed", issueId);
    expect(failed, "item.failed event in the outbox").toBeDefined();
    expect(extra).toHaveLength(0);
    expect(failed!.createdAt.getTime() - startedAt).toBeLessThanOrEqual(60_000);
    const payload = itemFailedPayloadSchema.parse(failed!.event.payload);
    expect(payload).toMatchObject({
      orderItemId: roti.id,
      orderIssueId: issueId,
      type: "unfulfillable",
      offeredResolutions: ["swap", "voucher"],
    });
  });

  it("ORD-08 laporan complaint pada item yang sama berdiri sendiri dari unfulfillable", async () => {
    const { roti } = await w.paidOrder();
    const first = await w.report(roti.id);
    const complaint = await w.report(roti.id, {
      type: "complaint",
      reason: "complaint",
      reasonNote: "Rasa kurang pas",
    });
    expect(first.status).toBe(201);
    expect(complaint.status).toBe(201);
    expect(complaint.body.data.id).not.toBe(first.body.data.id);
    expect(complaint.body.data.type).toBe("complaint");
  });

  it("ORD-08 tamu melihat issue sesinya dengan opsi swap dan voucher, tanpa refund", async () => {
    const { guest, roti } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;

    const row = await guestIssue(guest, issueId);
    expect(row).toMatchObject({
      orderItemId: roti.id,
      itemName: "Roti Bakar",
      quantity: 1,
      lineTotalIdr: PRICES.roti,
      type: "unfulfillable",
      status: "open",
      resolution: null,
      voucher: null,
    });
    expect(row.options.voucher).toEqual({
      allowed: true,
      valueIdr: PRICES.roti,
    });
    expect(row.options.swap.allowed).toBe(true);
    const swapIds = row.options.swap.items.map((item) => item.menuItemId);
    // Active and available menu only, not the failed item, not sold out.
    expect(swapIds).toContain(w.ids.kopi);
    expect(swapIds).not.toContain(w.ids.roti);
    expect(swapIds).not.toContain(w.ids.habis);
    const kopi = row.options.swap.items.find(
      (item) => item.menuItemId === w.ids.kopi,
    )!;
    expect(kopi.priceIdr).toBe(PRICES.kopi);
    expect(kopi.differenceIdr).toBe(PRICES.kopi - PRICES.roti);
    expect(JSON.stringify(row)).not.toMatch(/refund/i);

    const options = await w.as(guest).issueOptions(issueId);
    expect(options.status).toBe(200);
    expect(options.body.data).toMatchObject({
      issueId,
      manualRefundOfferedToCustomer: false,
      voucher: { allowed: true, valueIdr: PRICES.roti },
    });
    expect(options.body.data.swap.allowed).toBe(true);
  });

  it("ORD-08 tamu tidak bisa memilih refund: 422", async () => {
    const { guest, roti } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;
    const refund = await w.as(guest).choose(issueId, {
      choice: "manual_refund",
    });
    expect(refund.status).toBe(422);
    expect((await guestIssue(guest, issueId)).status).toBe("open");
  });

  it("ORD-08 tamu memilih ganti menu: harga katalog, selisih dihitung server, issue resolved", async () => {
    const { guest, roti } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;

    const noItem = await w.as(guest).choose(issueId, { choice: "swap" });
    expect(noItem.status).toBe(422);

    const chosen = await w.as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.kopi,
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data).toMatchObject({
      id: issueId,
      status: "resolved",
      resolution: "swap",
      replacementItemId: w.ids.kopi,
      // Kopi 25.000 replaces Roti 18.000 (qty 1): the guest pays 7.000 more.
      priceDifferenceIdr: PRICES.kopi - PRICES.roti,
    });
    expect(chosen.body.data.resolvedAt).toEqual(expect.any(String));

    const seen = await guestIssue(guest, issueId);
    expect(seen).toMatchObject({
      status: "resolved",
      resolution: "swap",
      replacementItemName: "Kopi Susu",
      priceDifferenceIdr: PRICES.kopi - PRICES.roti,
    });
    expect(await w.outboxRows("order_issue.resolved", issueId)).toHaveLength(1);
  });

  it("ORD-08 pengganti habis, tak dikenal, atau item itu sendiri ditolak dan issue tetap open", async () => {
    const { guest, roti } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;

    const soldOut = await w.as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.habis,
    });
    expect([409, 422]).toContain(soldOut.status);
    const unknown = await w.as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: randomUUID(),
    });
    expect([404, 422]).toContain(unknown.status);
    const same = await w.as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.roti,
    });
    expect([409, 422]).toContain(same.status);

    expect((await guestIssue(guest, issueId)).status).toBe("open");
  });

  it("ORD-08 swap ke menu lebih murah: selisih negatif dikreditkan sebagai voucher senilai selisih", async () => {
    const { guest, kopi } = await w.paidOrder();
    const issueId = (
      await w.report(kopi.id, { reasonNote: "Mesin kopi rusak" })
    ).body.data.id as string;

    const chosen = await w.as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.roti,
    });
    expect(chosen.status).toBe(200);
    const difference = chosen.body.data.priceDifferenceIdr as number;
    expect(difference).toBeLessThan(0);
    expect(chosen.body.data.voucherId).toEqual(expect.any(String));

    const seen = await guestIssue(guest, issueId);
    expect(seen.voucher).toMatchObject({
      valueIdr: -difference,
      code: expect.stringMatching(VOUCHER_CODE),
    });
  });

  it("ORD-08 tamu memilih voucher senilai item dan kode terbaca lagi di daftar", async () => {
    const { guest, roti } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;

    const chosen = await w.as(guest).choose(issueId, { choice: "voucher" });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data).toMatchObject({
      id: issueId,
      status: "resolved",
      resolution: "voucher",
      voucherId: expect.any(String),
    });

    const first = await guestIssue(guest, issueId);
    expect(first.status).toBe("resolved");
    expect(first.voucher).toMatchObject({
      valueIdr: PRICES.roti,
      code: expect.stringMatching(VOUCHER_CODE),
    });
    // Reading again shows the same code: it is recoverable, not one-shot.
    const second = await guestIssue(guest, issueId);
    expect(second.voucher?.code).toBe(first.voucher!.code);
    expect(second.voucher?.id).toBe(first.voucher!.id);

    // Staff can look the voucher up by that code: apology source, same value.
    const looked = await w.staffGet(
      w.supervisor,
      `/api/apology-vouchers/${first.voucher!.code}`,
    );
    expect(looked.status).toBe(200);
    const voucher = apologyVoucherSchema.parse(looked.body.data);
    expect(voucher).toMatchObject({
      valueIdr: PRICES.roti,
      status: "issued",
      orderIssueId: issueId,
    });
    expect(await w.outboxRows("order_issue.resolved", issueId)).toHaveLength(1);
  });

  it("ORD-08 pilihan yang sama dua kali idempoten, pilihan berbeda sesudahnya 409", async () => {
    const { guest, roti } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;

    const first = await w.as(guest).choose(issueId, { choice: "voucher" });
    const again = await w.as(guest).choose(issueId, { choice: "voucher" });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.data.voucherId).toBe(first.body.data.voucherId);

    const other = await w.as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.kopi,
    });
    expect(other.status).toBe(409);

    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM apology_vouchers WHERE tenant_id = $1 AND order_issue_id = $2",
      [w.tenant.tenantId, issueId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
    expect(await w.outboxRows("order_issue.resolved", issueId)).toHaveLength(1);
  });

  it("ORD-08 dua pilihan bersamaan: hanya satu menang, satunya 409", async () => {
    const { guest, roti } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;

    const results = await Promise.all([
      w.as(guest).choose(issueId, { choice: "voucher" }),
      w.as(guest).choose(issueId, {
        choice: "swap",
        replacementItemId: w.ids.kopi,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);

    const seen = await guestIssue(guest, issueId);
    expect(seen.status).toBe("resolved");
    const winner = results.find((result) => result.status === 200)!;
    expect(seen.resolution).toBe(winner.body.data.resolution);
    expect(await w.outboxRows("order_issue.resolved", issueId)).toHaveLength(1);
  });
});

describe("legend-4qu laporan: idempoten, validasi, izin, isolasi", () => {
  it("laporan ganda untuk item dan type yang sama saat masih open mengembalikan issue yang ada tanpa event ganda", async () => {
    const { roti } = await w.paidOrder();
    const before = await issueCount();
    const first = await w.report(roti.id);
    const second = await w.report(roti.id);
    expect(first.status).toBe(201);
    expect([200, 201]).toContain(second.status);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await issueCount()).toBe(before + 1);
    expect(await w.outboxRows("item.failed", first.body.data.id)).toHaveLength(
      1,
    );
  });

  it("item pada pesanan belum dibayar tidak bisa dilaporkan: 422 dan tidak ada issue", async () => {
    const { roti } = await w.unpaidOrder();
    const before = await issueCount();
    const reported = await w.report(roti.id);
    expect(reported.status).toBe(422);
    expect(await issueCount()).toBe(before);
  });

  it("item tak dikenal 404, type remake dari jalur tamu ditolak 422, tanpa login 401", async () => {
    const missing = await w.report(UNKNOWN_ORDER_ITEM_ID);
    expect(missing.status).toBe(404);

    const { roti } = await w.paidOrder();
    const remake = await w.report(roti.id, { type: "remake" });
    expect(remake.status).toBe(422);
    const noNote = await w.report(roti.id, { reasonNote: "" });
    expect(noNote.status).toBe(422);

    const anonymous = await w.staffPost(
      { ...w.supervisor, client: agent(w.app) },
      `/api/order-items/${roti.id}/issues`,
      { type: "unfulfillable", reason: "out_of_stock", reasonNote: "Habis" },
    );
    expect(anonymous.status).toBe(401);
  });

  it("staf tanpa order.recovery.handle tidak bisa melapor atau menyelesaikan: 403", async () => {
    const { roti } = await w.paidOrder();
    const before = await issueCount();
    const denied = await w.report(roti.id, {}, w.floorStaff);
    expect(denied.status).toBe(403);
    expect(await issueCount()).toBe(before);

    const issueId = (await w.report(roti.id)).body.data.id as string;
    const resolve = await w.staffPost(
      w.floorStaff,
      `/api/order-issues/${issueId}/resolve`,
      { resolution: "swap", replacementItemId: w.ids.kopi },
    );
    expect(resolve.status).toBe(403);
  });

  it("staf yang scope-nya outlet lain tidak bisa melapor atau menyelesaikan issue outlet ini", async () => {
    const { roti } = await w.paidOrder();
    const before = await issueCount();
    const denied = await w.report(roti.id, {}, w.otherOutletSupervisor);
    expect([403, 404]).toContain(denied.status);
    expect(await issueCount()).toBe(before);

    const issueId = (await w.report(roti.id)).body.data.id as string;
    const resolve = await w.staffPost(
      w.otherOutletSupervisor,
      `/api/order-issues/${issueId}/resolve`,
      { resolution: "swap", replacementItemId: w.ids.kopi },
    );
    expect([403, 404]).toContain(resolve.status);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM order_issues WHERE id = $1",
      [issueId],
    );
    expect(rows[0]!.status).toBe("open");
  });

  it("tenant lain tidak bisa melapor, membaca, atau mengubah issue tenant ini: 404", async () => {
    const { roti, guest } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;
    const intruder = await staffWithRole(w.app, {
      template: "supervisor",
      label: "Supervisor Tenant Lain",
    });

    const report = await w.report(roti.id, {}, intruder);
    // On this tenant's host the intruder holds no role: refused.
    expect([401, 403, 404]).toContain(report.status);
    const reportOnOwnHost = await w.staffPost(
      intruder,
      `/api/order-items/${roti.id}/issues`,
      { type: "unfulfillable", reason: "out_of_stock", reasonNote: "Habis" },
      seededHostname,
    );
    expect(reportOnOwnHost.status).toBe(404);

    const resolve = await w.staffPost(
      intruder,
      `/api/order-issues/${issueId}/resolve`,
      { resolution: "swap", replacementItemId: w.ids.kopi },
      seededHostname,
    );
    expect(resolve.status).toBe(404);

    // A guest token of this tenant does not open on the other tenant's host.
    const crossHost = await agent(w.app)
      .get(`/api/order-issues/${issueId}/options`)
      .set("Host", seededHostname)
      .set("Authorization", `Bearer ${guest.token}`);
    expect([401, 403, 404]).toContain(crossHost.status);

    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM order_issues WHERE id = $1",
      [issueId],
    );
    expect(rows[0]!.status).toBe("open");
  });

  it("tamu meja lain tidak melihat atau memilih issue sesi ini", async () => {
    const { roti, guest } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;
    const stranger = await w.seat();

    const list = await w.as(stranger).issues();
    expect(list.status).toBe(200);
    expect(
      (list.body.data as { id: string }[]).map((row) => row.id),
    ).not.toContain(issueId);

    const options = await w.as(stranger).issueOptions(issueId);
    expect([403, 404]).toContain(options.status);
    const choose = await w.as(stranger).choose(issueId, { choice: "voucher" });
    expect([403, 404]).toContain(choose.status);
    const anonymous = await w.anonymousGuestChoose(issueId, {
      choice: "voucher",
    });
    expect(anonymous.status).toBe(401);

    // The owner's own session still sees it open.
    expect((await guestIssue(guest, issueId)).status).toBe("open");
  });
});

describe("legend-4qu staf menyelesaikan issue", () => {
  it("staf menyelesaikan dengan swap: item pengganti dan selisih tersimpan, event resolved", async () => {
    const { roti, guest } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;

    const resolved = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issueId}/resolve`,
      { resolution: "swap", replacementItemId: w.ids.kopi },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({
      status: "resolved",
      resolution: "swap",
      replacementItemId: w.ids.kopi,
      priceDifferenceIdr: PRICES.kopi - PRICES.roti,
    });
    expect((await guestIssue(guest, issueId)).status).toBe("resolved");
    expect(await w.outboxRows("order_issue.resolved", issueId)).toHaveLength(1);

    // Already resolved: the same choice replays the stored result (no second
    // event); any other resolution is a conflict (409).
    const again = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issueId}/resolve`,
      { resolution: "swap", replacementItemId: w.ids.kopi },
    );
    expect(again.status).toBe(200);
    expect(again.body.data.resolvedAt).toBe(resolved.body.data.resolvedAt);
    const refundApproval = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PRICES.roti,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const refund = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issueId}/resolve`,
      {
        resolution: "manual_refund",
        approvalRequestId: refundApproval,
        reason: "Pelanggan berubah pikiran setelah ganti menu",
      },
    );
    expect(refund.status).toBe(409);
    const guestAfter = await w.as(guest).choose(issueId, { choice: "voucher" });
    expect(guestAfter.status).toBe(409);
    expect(await w.outboxRows("order_issue.resolved", issueId)).toHaveLength(1);
    expect(
      await w.outboxRows("order_issue.manual_refund_approved", issueId),
    ).toHaveLength(0);
  });

  it("staf menyelesaikan dengan voucher maaf yang sudah diterbitkan; voucher itu tak bisa dipakai issue lain", async () => {
    const first = await w.paidOrder();
    const second = await w.paidOrder();
    const firstIssue = (await w.report(first.roti.id)).body.data.id as string;
    const secondIssue = (await w.report(second.roti.id)).body.data.id as string;

    const issued = await w.staffPost(w.supervisor, "/api/apology-vouchers", {
      valueIdr: PRICES.roti,
      reason: "Roti habis, mohon maaf",
      orderIssueId: firstIssue,
    });
    expect(issued.status).toBe(201);
    const voucherId = issued.body.data.id as string;

    const resolved = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${firstIssue}/resolve`,
      { resolution: "voucher", voucherId },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({
      status: "resolved",
      resolution: "voucher",
    });

    const reused = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${secondIssue}/resolve`,
      { resolution: "voucher", voucherId },
    );
    expect(reused.status).toBe(409);

    const unknown = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${secondIssue}/resolve`,
      { resolution: "voucher", voucherId: randomUUID() },
    );
    expect([404, 422]).toContain(unknown.status);
  });
});

describe("legend-4qu ORD-09 refund manual dengan approval dan alasan tertulis", () => {
  const REASON = "Pelanggan menolak ganti menu dan voucher";

  async function failedRoti() {
    const paid = await w.paidOrder();
    const issueId = (await w.report(paid.roti.id)).body.data.id as string;
    return { ...paid, issueId };
  }

  const resolveRefund = (issueId: string, body: Record<string, unknown>) =>
    w.staffPost(w.supervisor, `/api/order-issues/${issueId}/resolve`, {
      resolution: "manual_refund",
      ...body,
    });

  async function stillOpen(issueId: string) {
    const { rows } = await owner.query<{ status: string; resolution: string }>(
      "SELECT status, resolution FROM order_issues WHERE id = $1",
      [issueId],
    );
    expect(rows[0]).toMatchObject({ status: "open", resolution: null });
    expect(
      await w.outboxRows("order_issue.manual_refund_approved", issueId),
    ).toHaveLength(0);
  }

  it("ORD-09 tanpa approval 422", async () => {
    const { issueId } = await failedRoti();
    const response = await resolveRefund(issueId, { reason: REASON });
    expect(response.status).toBe(422);
    await stillOpen(issueId);
  });

  it("ORD-09 alasan kurang dari 10 karakter 422", async () => {
    const { issueId } = await failedRoti();
    const approvalId = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PRICES.roti,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const response = await resolveRefund(issueId, {
      approvalRequestId: approvalId,
      reason: "habis",
    });
    expect(response.status).toBe(422);
    await stillOpen(issueId);
  });

  it("ORD-09 approval tak dikenal, belum disetujui, atau untuk objek lain 422", async () => {
    const { issueId } = await failedRoti();
    const other = await failedRoti();

    const unknown = await resolveRefund(issueId, {
      approvalRequestId: randomUUID(),
      reason: REASON,
    });
    expect([404, 422]).toContain(unknown.status);

    const pending = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PRICES.roti,
      status: "pending",
      requestedBy: w.floorStaff.userId,
    });
    const notApproved = await resolveRefund(issueId, {
      approvalRequestId: pending,
      reason: REASON,
    });
    expect(notApproved.status).toBe(422);

    const forOther = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: other.issueId,
      amountIdr: PRICES.roti,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const wrongObject = await resolveRefund(issueId, {
      approvalRequestId: forOther,
      reason: REASON,
    });
    expect(wrongObject.status).toBe(422);

    const wrongAction = await w.insertApproval({
      actionType: "apology_voucher",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PRICES.roti,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const notARefund = await resolveRefund(issueId, {
      approvalRequestId: wrongAction,
      reason: REASON,
    });
    expect(notARefund.status).toBe(422);

    const wrongAmount = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: 1,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const amountMismatch = await resolveRefund(issueId, {
      approvalRequestId: wrongAmount,
      reason: REASON,
    });
    expect(amountMismatch.status).toBe(422);

    await stillOpen(issueId);
    await stillOpen(other.issueId);
  });

  it("ORD-09 supervisor tidak boleh menyetujui refund-nya sendiri 422", async () => {
    const { issueId } = await failedRoti();
    const selfApproved = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PRICES.roti,
      status: "approved",
      requestedBy: w.floorStaff.userId,
      decidedBy: w.supervisor.userId,
    });
    const response = await resolveRefund(issueId, {
      approvalRequestId: selfApproved,
      reason: REASON,
    });
    expect(response.status).toBe(422);
    await stillOpen(issueId);
  });

  it("ORD-09 approval benar: issue resolved, approvedBy pemutus approval, alasan tersimpan, event untuk modul pembayaran", async () => {
    const { issueId, guest } = await failedRoti();
    const approvalId = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PRICES.roti,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const response = await resolveRefund(issueId, {
      approvalRequestId: approvalId,
      reason: REASON,
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: issueId,
      status: "resolved",
      resolution: "manual_refund",
      approvedBy: w.approverUserId,
      reasonNote: REASON,
    });
    expect(response.body.data.resolvedAt).toEqual(expect.any(String));

    const events = await w.outboxRows(
      "order_issue.manual_refund_approved",
      issueId,
    );
    expect(events).toHaveLength(1);

    // The guest sees it resolved, with no refund wording and no voucher.
    const seen = await guestIssue(guest, issueId);
    expect(seen.status).toBe("resolved");
    expect(seen.voucher).toBeNull();

    // The same approval cannot settle the issue twice (idempotent or refused).
    const again = await resolveRefund(issueId, {
      approvalRequestId: approvalId,
      reason: REASON,
    });
    expect([200, 409]).toContain(again.status);
    expect(
      await w.outboxRows("order_issue.manual_refund_approved", issueId),
    ).toHaveLength(1);
  });

  it("ORD-09 refund manual tidak bisa dilakukan oleh staf tanpa order.recovery.handle", async () => {
    const { issueId } = await failedRoti();
    const approvalId = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PRICES.roti,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const denied = await w.staffPost(
      w.floorStaff,
      `/api/order-issues/${issueId}/resolve`,
      {
        resolution: "manual_refund",
        approvalRequestId: approvalId,
        reason: REASON,
      },
    );
    expect(denied.status).toBe(403);
    await stillOpen(issueId);
  });
});

describe("legend-4qu laporan: pesanan open bill, item void, baris KDS", () => {
  it("item pada pesanan open bill yang belum lunas tidak bisa dilaporkan: 422", async () => {
    const { roti, order } = await w.openBillOrder();
    // The open-bill order is already sent to the kitchen but not paid.
    expect(order.status).toBe("sent");
    const before = await issueCount();
    const reported = await w.report(roti.id);
    expect(reported.status).toBe(422);
    expect(await issueCount()).toBe(before);
  });

  it("item yang sudah void tidak bisa dilaporkan: 422", async () => {
    const { roti } = await w.paidOrder();
    await owner.query(
      "UPDATE order_items SET status = 'voided' WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, ulidToUuid(roti.id)],
    );
    const before = await issueCount();
    const reported = await w.report(roti.id);
    expect(reported.status).toBe(422);
    expect(await issueCount()).toBe(before);
  });

  it("baris remake dan comp dari KDS tidak muncul di daftar tamu, tidak bisa dipilih tamu, dan tidak merusak daftar", async () => {
    const { guest, roti, kopi, order } = await w.paidOrder();
    const kdsBody = (type: "remake" | "comp", orderItemId: string) => ({
      orderItemId,
      type,
      reason: "quality",
      reasonNote: "Rasa kurang pas, dibuat ulang",
      stationId: null,
      employeeId: w.supervisor.userId,
      resolution: null,
      voucherId: null,
      approvedBy: null,
      idempotencyKey: `iss-${randomUUID()}`,
    });
    const kdsReport = (type: "remake" | "comp", orderItemId: string) =>
      w.staffPost(
        w.supervisor,
        `/api/outlets/${w.tenant.outletId}/orders/${order.id}/issues`,
        kdsBody(type, orderItemId),
      );
    // KDS only comps an item that is already voided.
    await owner.query(
      "UPDATE order_items SET status = 'voided' WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, ulidToUuid(kopi.id)],
    );
    const remake = await kdsReport("remake", roti.id);
    expect(remake.status).toBe(201);
    const comp = await kdsReport("comp", kopi.id);
    expect(comp.status, JSON.stringify(comp.body)).toBe(201);
    const remakeId = remake.body.data.id as string;
    const compId = comp.body.data.id as string;

    // A real failed item next to them: the list still works and shows only it.
    const failed = await w.report(roti.id);
    expect(failed.status).toBe(201);
    const list = await w.as(guest).issues();
    expect(list.status).toBe(200);
    const ids = (list.body.data as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(failed.body.data.id);
    expect(ids).not.toContain(remakeId);
    expect(ids).not.toContain(compId);

    const snapshot = async () =>
      (
        await owner.query(
          "SELECT id, status, resolution, voucher_id FROM order_issues WHERE id = ANY($1::uuid[]) ORDER BY id",
          [[remakeId, compId]],
        )
      ).rows;
    const untouched = await snapshot();
    expect(untouched).toHaveLength(2);
    for (const kdsId of [remakeId, compId]) {
      const options = await w.as(guest).issueOptions(kdsId);
      expect([404, 422]).toContain(options.status);
      const chosen = await w.as(guest).choose(kdsId, { choice: "voucher" });
      expect([404, 422]).toContain(chosen.status);
    }
    // The guest attempts changed nothing on the KDS rows.
    expect(await snapshot()).toEqual(untouched);
  });
});

describe("legend-4qu selisih swap memakai total baris item", () => {
  it("kopi x2 dengan extra shot diganti roti: selisih = harga roti x qty dikurangi total baris, negatif dikreditkan voucher", async () => {
    const { guest, kopi } = await w.paidOrder();
    const { rows } = await owner.query<{
      quantity: number;
      line_total_idr: string;
    }>(
      "SELECT quantity, line_total_idr FROM order_items WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, ulidToUuid(kopi.id)],
    );
    const quantity = Number(rows[0]!.quantity);
    const lineTotal = Number(rows[0]!.line_total_idr);
    // The extra shot is part of the line: the total is above price x qty.
    expect(lineTotal).toBeGreaterThan(PRICES.kopi * quantity);
    const expected = PRICES.roti * quantity - lineTotal;
    expect(expected).toBeLessThan(0);

    const issueId = (
      await w.report(kopi.id, { reasonNote: "Mesin kopi rusak" })
    ).body.data.id as string;

    // The guest sees the same difference before choosing.
    const offered = (await guestIssue(guest, issueId)).options.swap.items.find(
      (item) => item.menuItemId === w.ids.roti,
    )!;
    expect(offered.differenceIdr).toBe(expected);

    const chosen = await w.as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.roti,
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data.priceDifferenceIdr).toBe(expected);
    const seen = await guestIssue(guest, issueId);
    expect(seen.voucher?.valueIdr).toBe(-expected);
  });
});
