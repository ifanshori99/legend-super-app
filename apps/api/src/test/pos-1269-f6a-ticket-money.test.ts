// F6a (legend-osqou.33.6, legend-iojd1 money part): facility tickets sold at
// the cashier never pay a guest who keeps (or used) the ticket.
//
//   - a ticket whose session has started is not refunded or voided;
//   - a refund that returns a ticket line gives its full value back, no less;
//   - on a mixed bill (ticket + food) a refund that names the food never pays
//     out the money of the ticket;
//   - a line with a live ticket is not compensated as a failed item (report,
//     swap, voucher, ORD-09 refund);
//   - the door PIN is stored as an HMAC; a PIN digest of the old kind (plain
//     SHA-256) opens nothing any more, its QR still does.

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid, userIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  PIN,
  TICKET_LIST_IDR,
  TICKET_TOTAL_IDR,
  asOwnerTenant,
  authed,
  buildWorld,
  doorCheck,
  errorCode,
  mintCredential,
  newUnit,
  owner,
  paidTicket,
  teardownWorld,
  ticketState,
  type Bought,
  type Staff,
  type World,
} from "./pos-1065-world.ts";

/** Kopi Rp25.000 + PBJT 10%. */
const KOPI_TOTAL_IDR = 27_500;
const MIXED_TOTAL_IDR = TICKET_TOTAL_IDR + KOPI_TOTAL_IDR;

let world: World;
let supervisor: Staff;
let ticketItem: string;

const sessionContext = () =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(world.tenant.tenantId),
    brandId: null,
    source: "session",
  });

beforeAll(async () => {
  world = await buildWorld("f6a");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Supervisor F6a', true, 'supervisor', $3, false, '["tenant","outlet"]')`,
    [
      roleId,
      world.tenant.tenantId,
      JSON.stringify([
        "order.view",
        "order.recovery.handle",
        "kds.remake_comp.record",
        "pos.void.approve",
        "pos.refund.approve",
      ]),
    ],
  );
  const client = agent(world.app);
  await signUp(client, "Supervisor F6a");
  const session = await client.get("/api/auth/get-session");
  supervisor = { client, userId: session.body.user.id as string };
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [world.tenant.tenantId, supervisor.userId, roleId],
  );
  await setStaffPin(
    sessionContext(),
    supervisor.userId,
    { outletId: world.outletA, userId: supervisor.userId },
    { pin: PIN },
  );
  const { rows } = await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query<{ menu_item_id: string }>(
      "SELECT menu_item_id FROM facility_products WHERE tenant_id = $1 AND id = $2",
      [world.tenant.tenantId, world.productId],
    ),
  );
  ticketItem = rows[0]!.menu_item_id;
  // The swap prices its replacement from the dine-in list.
  await asOwnerTenant(world.tenant.tenantId, async (db) => {
    const priceList = randomUUID();
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [priceList, world.tenant.tenantId, world.outletA],
    );
    await db.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        world.tenant.tenantId,
        priceList,
        world.kopiId,
        TICKET_LIST_IDR,
      ],
    );
  });
}, 180_000);

afterAll(async () => {
  await teardownWorld(world);
});

// ---- Helpers --------------------------------------------------------------------

type Line = { id: string; menuItemId: string };
type OrderView = { id: string; status: string; items: Line[] };

const ordersPath = () =>
  `/api/outlets/${encodeURIComponent(world.outletA)}/pos/orders`;

function post(path: string, body: Record<string, unknown>) {
  return authed(
    world,
    world.cashier.client.post(`${ordersPath()}${path}`),
    world.normalA,
  ).send({ idempotencyKey: randomUUID(), ...body });
}

async function readOrder(orderId: string): Promise<OrderView> {
  const read = await authed(
    world,
    world.cashier.client.get(`${ordersPath()}/${orderId}`),
    world.normalA,
  );
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data as OrderView;
}

async function approval(
  action: "void" | "refund",
  orderId: string,
  valueIdr: number,
) {
  const { override } = await createPosOverride(
    sessionContext(),
    world.cashier.userId,
    {
      outletId: world.outletA,
      action,
      valueIdr,
      reason: "Persetujuan uji tiket",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  return { approvedBy: supervisor.userId, overrideId: override.id };
}

async function refund(orderId: string, itemIds: string[], amountIdr: number) {
  return post(`/${orderId}/corrections/refund`, {
    reason: "quality_complaint",
    reasonNote: "Uji refund tiket",
    amountIdr,
    ...(itemIds.length > 0
      ? { items: itemIds.map((itemId) => ({ itemId, quantity: 1 })) }
      : {}),
    ...(await approval("refund", orderId, amountIdr)),
  });
}

async function refundedIdr(orderId: string): Promise<number> {
  const { rows } = await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query<{ total: string }>(
      "SELECT coalesce(sum(amount_idr), 0)::text AS total FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2",
      [world.tenant.tenantId, ulidToUuid(orderId)],
    ),
  );
  return Number(rows[0]!.total);
}

/** Moves the ticket's session: `offsetMinutes` from now (negative = started). */
async function moveStart(ticketUuid: string, offsetMinutes: number) {
  await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query(
      `UPDATE access_tickets
          SET starts_at = now() + make_interval(mins => $3),
              ends_at = now() + make_interval(mins => $3 + 20),
              cleaning_ends_at = now() + make_interval(mins => $3 + 30)
        WHERE tenant_id = $1 AND id = $2`,
      [world.tenant.tenantId, ticketUuid, offsetMinutes],
    ),
  );
}

async function paidMixedOrder(): Promise<{
  orderId: string;
  kopi: string;
  ticketLine: string;
}> {
  const created = await post("", {
    channel: "pos",
    serviceType: "takeaway",
    items: [
      { menuItemId: world.kopiId, quantity: 1, modifierIds: [] },
      { menuItemId: ticketItem, quantity: 1, modifierIds: [] },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  const orderId = (created.body.data as OrderView).id;
  let order = await readOrder(orderId);
  if (order.status === "draft") {
    const submitted = await post(`/${orderId}/submit`, {
      expectedStatus: order.status,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    order = await readOrder(orderId);
  }
  const paid = await post(`/${orderId}/tenders`, {
    method: "cash",
    receivedIdr: MIXED_TOTAL_IDR,
    expectedStatus: order.status,
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  order = await readOrder(orderId);
  const done = await post(`/${orderId}/complete`, {
    expectedStatus: order.status,
  });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  const lineOf = (menuItemId: string) =>
    order.items.find((item) => item.menuItemId === menuItemId)!.id;
  return {
    orderId,
    kopi: lineOf(world.kopiId),
    ticketLine: lineOf(ticketItem),
  };
}

/** Ties an issued ticket (tomorrow's slot) to a paid order line. */
async function linkTicket(orderId: string, itemId: string): Promise<string> {
  const unitId = await newUnit(world);
  const ticketUuid = randomUUID();
  const { tenantId } = world.tenant;
  await asOwnerTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO access_tickets
         (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id, product_id,
          source, starts_at, ends_at, cleaning_ends_at, grace_minutes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'purchase', now() + interval '1 day',
               now() + interval '1 day 20 minutes', now() + interval '1 day 30 minutes', 10, 'issued')`,
      [
        ticketUuid,
        tenantId,
        world.outletA,
        world.facilityId,
        world.areaId,
        unitId,
        world.customerId,
        world.productId,
      ],
    );
    await db.query(
      `INSERT INTO facility_ticket_pos_lines
         (tenant_id, outlet_id, facility_id, access_ticket_id, order_id, order_item_id, status,
          line_total_idr, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'issued', $7, now())`,
      [
        tenantId,
        world.outletA,
        world.facilityId,
        ticketUuid,
        ulidToUuid(orderId),
        ulidToUuid(itemId),
        TICKET_LIST_IDR,
      ],
    );
  });
  return ticketUuid;
}

async function statusOf(ticketUuid: string): Promise<string> {
  const { rows } = await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query<{ status: string }>(
      "SELECT status FROM access_tickets WHERE tenant_id = $1 AND id = $2",
      [world.tenant.tenantId, ticketUuid],
    ),
  );
  return rows[0]!.status;
}

const ticketLineOf = async (bought: Bought) =>
  (await readOrder(bought.orderId)).items[0]!.id;

// ---- Refund after the session started ----------------------------------------------

describe("F6a refund and void after the session started", () => {
  it("F6A-01 a paid ticket whose session has started is refused (409 TICKET_ALREADY_STARTED), refund and void alike, and no money moves", async () => {
    const bought = await paidTicket(world);
    const line = await ticketLineOf(bought);
    await moveStart(ulidToUuid(bought.ticketId), -1);

    const refused = await refund(bought.orderId, [line], TICKET_TOTAL_IDR);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("TICKET_ALREADY_STARTED");
    const voided = await post(`/${bought.orderId}/corrections/void`, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal tiket",
      ...(await approval("void", bought.orderId, TICKET_TOTAL_IDR)),
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(409);
    expect(errorCode(voided.body)).toBe("TICKET_ALREADY_STARTED");

    expect((await ticketState(world, bought.ticketId)).status).toBe("issued");
    expect(await refundedIdr(bought.orderId)).toBe(0);
  });

  it("F6A-02 the same ticket is still refundable one minute before its session", async () => {
    const bought = await paidTicket(world);
    const line = await ticketLineOf(bought);
    await moveStart(ulidToUuid(bought.ticketId), 1);
    const ok = await refund(bought.orderId, [line], TICKET_TOTAL_IDR);
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    expect((await ticketState(world, bought.ticketId)).status).toBe("refunded");
    expect(await refundedIdr(bought.orderId)).toBe(TICKET_TOTAL_IDR);
  });

  it("F6A-03 a refund racing a door check: exactly one wins, never used and paid back", async () => {
    for (let round = 0; round < 3; round += 1) {
      const bought = await paidTicket(world);
      const line = await ticketLineOf(bought);
      const credential = await mintCredential(world, bought);
      const approved = await approval(
        "refund",
        bought.orderId,
        TICKET_TOTAL_IDR,
      );
      const [refunded, opened] = await Promise.all([
        post(`/${bought.orderId}/corrections/refund`, {
          reason: "quality_complaint",
          reasonNote: "Uji balapan pintu",
          amountIdr: TICKET_TOTAL_IDR,
          items: [{ itemId: line, quantity: 1 }],
          ...approved,
        }),
        doorCheck(world, world.normalA, {
          ticketId: bought.ticketId,
          pin: credential.pin,
        }),
      ]);
      const won = [refunded.status < 300, opened.status === 200];
      expect(won.filter(Boolean), JSON.stringify(won)).toHaveLength(1);
      expect((await ticketState(world, bought.ticketId)).status).toBe(
        won[0] ? "refunded" : "in_use",
      );
      expect(await refundedIdr(bought.orderId)).toBe(
        won[0] ? TICKET_TOTAL_IDR : 0,
      );
    }
  });
});

// ---- Full value of the line, and mixed bills ------------------------------------------

describe("F6a refund of a ticket line pays its full value", () => {
  it("F6A-10 Rp1 and one rupiah short are refused (422 TICKET_REFUND_FULL_LINE_REQUIRED): the ticket stays issued and nothing is paid", async () => {
    const bought = await paidTicket(world);
    const line = await ticketLineOf(bought);
    for (const amountIdr of [1, TICKET_TOTAL_IDR - 1]) {
      const refused = await refund(bought.orderId, [line], amountIdr);
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(errorCode(refused.body)).toBe("TICKET_REFUND_FULL_LINE_REQUIRED");
      expect((await ticketState(world, bought.ticketId)).status).toBe("issued");
      expect(await refundedIdr(bought.orderId)).toBe(0);
    }
    const full = await refund(bought.orderId, [line], TICKET_TOTAL_IDR);
    expect(full.status, JSON.stringify(full.body)).toBeLessThan(300);
    expect((await ticketState(world, bought.ticketId)).status).toBe("refunded");
  });

  it("F6A-11 mixed bill: a refund that names the food never pays the ticket's money (422 TICKET_REFUND_OVER_LINES)", async () => {
    const bill = await paidMixedOrder();
    const ticket = await linkTicket(bill.orderId, bill.ticketLine);
    for (const amountIdr of [MIXED_TOTAL_IDR, KOPI_TOTAL_IDR + 1]) {
      const refused = await refund(bill.orderId, [bill.kopi], amountIdr);
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(errorCode(refused.body)).toBe("TICKET_REFUND_OVER_LINES");
    }
    expect(await refundedIdr(bill.orderId)).toBe(0);
    const noItem = await refund(bill.orderId, [], KOPI_TOTAL_IDR);
    expect(errorCode(noItem.body)).toBe("TICKET_REFUND_NEEDS_ITEM");

    const food = await refund(bill.orderId, [bill.kopi], KOPI_TOTAL_IDR);
    expect(food.status, JSON.stringify(food.body)).toBeLessThan(300);
    expect(await statusOf(ticket)).toBe("issued");

    const ticketRefund = await refund(
      bill.orderId,
      [bill.ticketLine],
      TICKET_TOTAL_IDR,
    );
    expect(ticketRefund.status, JSON.stringify(ticketRefund.body)).toBeLessThan(
      300,
    );
    expect(await statusOf(ticket)).toBe("refunded");
    expect(await refundedIdr(bill.orderId)).toBe(MIXED_TOTAL_IDR);
  });

  it("F6A-12 mixed bill: the ticket alone never pays the food's money, and both lines together pay the whole bill", async () => {
    const bill = await paidMixedOrder();
    const ticket = await linkTicket(bill.orderId, bill.ticketLine);
    const over = await refund(
      bill.orderId,
      [bill.ticketLine],
      TICKET_TOTAL_IDR + 1,
    );
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    expect(errorCode(over.body)).toBe("TICKET_REFUND_OVER_LINES");
    const short = await refund(
      bill.orderId,
      [bill.kopi, bill.ticketLine],
      TICKET_TOTAL_IDR - 1,
    );
    expect(errorCode(short.body)).toBe("TICKET_REFUND_FULL_LINE_REQUIRED");
    expect(await statusOf(ticket)).toBe("issued");

    const both = await refund(
      bill.orderId,
      [bill.kopi, bill.ticketLine],
      MIXED_TOTAL_IDR,
    );
    expect(both.status, JSON.stringify(both.body)).toBeLessThan(300);
    expect(await statusOf(ticket)).toBe("refunded");
  });

  it("F6A-13 mixed bill: the food is still refundable after the ticket's session started; the ticket is not", async () => {
    const bill = await paidMixedOrder();
    const ticket = await linkTicket(bill.orderId, bill.ticketLine);
    await moveStart(ticket, -1);
    const both = await refund(
      bill.orderId,
      [bill.kopi, bill.ticketLine],
      MIXED_TOTAL_IDR,
    );
    expect(errorCode(both.body)).toBe("TICKET_ALREADY_STARTED");
    const food = await refund(bill.orderId, [bill.kopi], KOPI_TOTAL_IDR);
    expect(food.status, JSON.stringify(food.body)).toBeLessThan(300);
    expect(await statusOf(ticket)).toBe("issued");
  });
});

// ---- Failed-item paths on a ticket line ----------------------------------------------

function staffPost(path: string, body: Record<string, unknown>) {
  return supervisor.client
    .post(path)
    .set(world.headers)
    .set(originHeader)
    .send(body);
}

const reportFailed = (itemId: string) =>
  staffPost(`/api/order-items/${itemId}/issues`, {
    type: "unfulfillable",
    reason: "out_of_stock",
    reasonNote: "Tidak bisa dilayani",
  });

async function issueCount(itemId: string, status?: string): Promise<number> {
  const { rows } = await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query(
      `SELECT 1 FROM order_issues
        WHERE tenant_id = $1 AND order_item_id = $2
          AND ($3::text IS NULL OR status = $3)`,
      [world.tenant.tenantId, ulidToUuid(itemId), status ?? null],
    ),
  );
  return rows.length;
}

describe("F6a a live ticket line is not a failed item", () => {
  it("F6A-20 the failed-item report is refused (409 TICKET_LIVE_NO_COMPENSATION) and stores nothing; the food line still reports", async () => {
    const bill = await paidMixedOrder();
    await linkTicket(bill.orderId, bill.ticketLine);
    const refused = await reportFailed(bill.ticketLine);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("TICKET_LIVE_NO_COMPENSATION");
    expect(await issueCount(bill.ticketLine)).toBe(0);
    const food = await reportFailed(bill.kopi);
    expect(food.status, JSON.stringify(food.body)).toBeLessThan(300);
  });

  it("F6A-21 an open report on a ticket line cannot be swapped: no voucher, the issue stays open, the ticket stays issued", async () => {
    const bill = await paidMixedOrder();
    const reported = await reportFailed(bill.ticketLine);
    expect(reported.status, JSON.stringify(reported.body)).toBeLessThan(300);
    const ticket = await linkTicket(bill.orderId, bill.ticketLine);
    const swapped = await staffPost(
      `/api/order-issues/${reported.body.data.id as string}/resolve`,
      { resolution: "swap", replacementItemId: world.kopiId },
    );
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(409);
    expect(errorCode(swapped.body)).toBe("TICKET_LIVE_NO_COMPENSATION");
    expect(await issueCount(bill.ticketLine, "open")).toBe(1);
    expect(await statusOf(ticket)).toBe("issued");
  });

  it("F6A-22 a report that names its own swap is refused on a ticket line", async () => {
    const bill = await paidMixedOrder();
    await linkTicket(bill.orderId, bill.ticketLine);
    const refused = await staffPost(
      `/api/outlets/${encodeURIComponent(world.outletA)}/orders/${bill.orderId}/issues`,
      {
        orderItemId: bill.ticketLine,
        type: "complaint",
        reason: "complaint",
        reasonNote: "Minta ditukar kopi",
        stationId: null,
        employeeId: null,
        resolution: "swap",
        replacementItemId: world.kopiId,
        voucherId: null,
        approvedBy: null,
        idempotencyKey: randomUUID(),
      },
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("TICKET_LIVE_NO_COMPENSATION");
    expect(await issueCount(bill.ticketLine)).toBe(0);
  });

  it("F6A-23 an approved ORD-09 refund of a ticket line is refused and writes no refund event", async () => {
    const bill = await paidMixedOrder();
    const reported = await reportFailed(bill.ticketLine);
    expect(reported.status, JSON.stringify(reported.body)).toBeLessThan(300);
    const issueId = reported.body.data.id as string;
    await linkTicket(bill.orderId, bill.ticketLine);
    const approvalId = randomUUID();
    await asOwnerTenant(world.tenant.tenantId, (db) =>
      db.query(
        `INSERT INTO approval_requests
           (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
            object_id, payload, requested_by, source, level, required_levels,
            required_steps, amount_idr, status, request_reason, decided_by, decided_at,
            reason, deadline_at, created_at)
         VALUES ($1, $2, $3, $1, 'order_recovery', 'refund', 'order_issue', $4, '{}', $5, 'user',
                 1, 1, '[]', $6, 'approved', 'Uji refund tiket', $7, now(), 'Disetujui',
                 now() + interval '1 day', now() - interval '1 minute')`,
        [
          approvalId,
          world.tenant.tenantId,
          world.outletA,
          issueId,
          supervisor.userId,
          TICKET_LIST_IDR,
          world.doorStaff.userId,
        ],
      ),
    );
    const refused = await staffPost(`/api/order-issues/${issueId}/resolve`, {
      resolution: "manual_refund",
      approvalRequestId: approvalId,
      reason: "Refund tiket yang disetujui",
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("TICKET_LIVE_NO_COMPENSATION");
    expect(await issueCount(bill.ticketLine, "open")).toBe(1);
  });

  it("F6A-24 refunding the replacement of an already swapped ticket line also refunds the ticket", async () => {
    const bill = await paidMixedOrder();
    const ticket = await linkTicket(bill.orderId, bill.ticketLine);
    // A swap settled before this rule: the food line stands in for the ticket.
    await asOwnerTenant(world.tenant.tenantId, (db) =>
      db.query(
        `INSERT INTO order_issues
           (tenant_id, outlet_id, order_id, order_item_id, type, reason, reason_note, reported_by,
            resolution, replacement_item_id, replacement_order_item_id, price_difference_idr,
            idempotency_key, cost_idr, status, resolved_at)
         VALUES ($1, $2, $3, $4, 'unfulfillable', 'out_of_stock', 'Swap lama', $5, 'swap', $6, $7, 0,
                 $8, 0, 'resolved', now())`,
        [
          world.tenant.tenantId,
          world.outletA,
          ulidToUuid(bill.orderId),
          ulidToUuid(bill.ticketLine),
          supervisor.userId,
          world.kopiId,
          ulidToUuid(bill.kopi),
          randomUUID(),
        ],
      ),
    );
    await moveStart(ticket, -1);
    const refused = await refund(bill.orderId, [bill.kopi], KOPI_TOTAL_IDR);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("TICKET_ALREADY_STARTED");
    expect(await refundedIdr(bill.orderId)).toBe(0);
  });
});

// ---- PIN digest -------------------------------------------------------------------

describe("F6a door PIN digest", () => {
  const plainDigest = (bought: Bought, pin: string) =>
    createHash("sha256")
      .update(`${bought.ticketId}:${pin}`, "utf8")
      .digest("hex");

  it("F6A-30 the stored PIN digest is not the plain SHA-256 of ticket and PIN, and the PIN opens the door", async () => {
    const bought = await paidTicket(world);
    const credential = await mintCredential(world, bought);
    const { rows } = await asOwnerTenant(world.tenant.tenantId, (db) =>
      db.query<{ pin_digest: string }>(
        "SELECT pin_digest FROM access_ticket_credentials WHERE tenant_id = $1 AND access_ticket_id = $2",
        [world.tenant.tenantId, ulidToUuid(bought.ticketId)],
      ),
    );
    expect(rows[0]!.pin_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.pin_digest).not.toBe(plainDigest(bought, credential.pin));
    const opened = await doorCheck(world, world.normalA, {
      ticketId: bought.ticketId,
      pin: credential.pin,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  });

  it("F6A-31 a PIN stored the old way is expired (uniform 403), its QR still opens, and a new print gives a working PIN", async () => {
    const bought = await paidTicket(world);
    const old = await mintCredential(world, bought);
    const makeOld = (pin: string) =>
      asOwnerTenant(world.tenant.tenantId, (db) =>
        db.query(
          "UPDATE access_ticket_credentials SET pin_digest = $3 WHERE tenant_id = $1 AND access_ticket_id = $2",
          [
            world.tenant.tenantId,
            ulidToUuid(bought.ticketId),
            plainDigest(bought, pin),
          ],
        ),
      );
    await makeOld(old.pin);
    const refused = await doorCheck(world, world.normalA, {
      ticketId: bought.ticketId,
      pin: old.pin,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(errorCode(refused.body)).toBe("DOOR_CREDENTIAL_INVALID");
    expect((await ticketState(world, bought.ticketId)).status).toBe("issued");

    const fresh = await mintCredential(world, bought);
    const opened = await doorCheck(world, world.normalA, {
      ticketId: bought.ticketId,
      pin: fresh.pin,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    await makeOld(fresh.pin);
    const byQr = await doorCheck(world, world.normalA, {
      qrToken: fresh.qrToken,
    });
    expect(byQr.status, JSON.stringify(byQr.body)).toBe(200);
  });
});
