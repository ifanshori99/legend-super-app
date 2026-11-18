// legend-1095 round legend-3dsih: voiding an order that already carries an apology / CRM
// voucher tied to that order (the "given" voucher set of the order: apology vouchers
// through the order's issues, and CRM vouchers on order_issues.voucher_id).
//
//   voucher `issued`     -> cancelled in the SAME transaction as the void (the void
//                           returns the whole order, so the voucher must not stay usable)
//   voucher `redeemed`   -> the void is refused (a used voucher cannot be taken back;
//                           there is no partial use): cloud 409 VOID_APOLOGY_VOUCHER_USED,
//                           edge `void_refused:apology_voucher_exists` (also on replay
//                           and while parked), no void row, voucher untouched
//   `expired`/`cancelled`-> ignored
//   one redeemed among several -> the whole void is refused and nothing is cancelled
//
// Written from docs/briefs/sub-1095.md (section "Ronde 3dsih"), not from the services.
//
// Assumptions (also reported):
// - "Money out" of a voided order = void (the whole paid amount) + cashier refunds +
//   live ORD-09 + ACTIVE vouchers (issued or redeemed). A cancelled / expired voucher
//   is not money out, so the shared `returnedTotal` (which counts every voucher row) is
//   not used here.
// - Redeeming a voucher at another order's checkout is simulated by the same writes
//   the checkout makes, in the documented lock order (lock the OTHER order, then the
//   voucher row, then `UPDATE ... WHERE status = 'issued'`), because a full checkout
//   with a voucher is out of scope of this brief. It returns false when the voucher
//   was no longer issued (the void won).
// - Edge fixtures seed the voucher and its settled issue straight into the tables (CRM
//   shape, order_issues.voucher_id); the apology-voucher shape is covered on the cloud
//   side through the real API. Foreign keys are skipped for the seed only
//   (session_replication_role = replica), as the other 1095 edge fixtures do.
// - Race: a third connection holds the voucher row `FOR UPDATE`; the two requests are
//   started one after the other, the lock is released once both wait (or one already
//   finished), then both are awaited. The outcome may depend on who wins, the
//   invariant may not: never a recorded void AND a redeemed voucher.
// - The cancel-on-void audit and the edge refusal audit are not asserted (the audit
//   table shape is not part of the brief).
//
// Run: LEGEND_TEST_FILES="src/test/refund-1095-void-voucher.test.ts" heavy pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createUlid, tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
import { agent, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  EDGE_PAID,
  edgeKit,
  registerEdgeAppliers,
  registerNode,
  resetEdge,
} from "./refund-1095-edge-helpers.ts";
import {
  ORDER_PAID,
  createPosWorld,
  errorText,
  sum,
  toUuid,
  type PaidOrder,
  type PosWorld,
} from "./refund-1095-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

const short = () => randomUUID().slice(0, 6);

let p: PosWorld;
/** A second tenant (cloud side) with its own paid order and voucher. */
let other: PosWorld;

type Site = { tenant: IsolatedTenant; kit: ReturnType<typeof edgeKit> };
let site: Site;
let siteB: Site;

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function makeSite(app: PosWorld["w"]["app"]): Promise<Site> {
  const tenant = await createIsolatedTenant(`vv-${short()}`);
  const context = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  await withTenant(
    db,
    establishScopedTenantContext(context, { kind: "tenant" }),
    (tx) => seedTenantRoleTemplates(tx, tenant.tenantId),
  );
  const { rows: roleRows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenant.tenantId],
  );
  const ownerRoleId = roleRows[0]!.id;
  const member = async (label: string) => {
    const client = agent(app);
    await signUp(client, label);
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.tenantId, userId, ownerRoleId],
    );
    return userId;
  };
  const requestedBy = await member(`Kasir Edge VV ${short()}`);
  const approvedBy = await member(`Supervisor Edge VV ${short()}`);
  const category = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Edge Void Voucher', 0)",
    [category, tenant.tenantId, tenant.brandId],
  );
  const menuItemId = randomUUID();
  await owner.query(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Latte', true, $5)`,
    [menuItemId, tenant.tenantId, tenant.brandId, category, randomUUID()],
  );
  const node = await registerNode(tenant);
  return {
    tenant,
    kit: edgeKit(tenant, node, { requestedBy, approvedBy, menuItemId }),
  };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // createPosWorld installs process-wide ports for its own tenant: the main world is
  // created last so its till keeps working; `other` is only used through HTTP.
  other = await createPosWorld();
  p = await createPosWorld();
  site = await makeSite(p.w.app);
  siteB = await makeSite(p.w.app);
}, 360_000);

beforeEach(() => {
  registerEdgeAppliers();
});

afterAll(async () => {
  resetEdge();
  // One teardown only: it ends the process-wide test pools, shared by both worlds.
  await p.teardown();
});

// ---- voucher observers / writers (cloud and edge share them) --------------------------

type VoucherState = "issued" | "redeemed" | "expired" | "cancelled";

async function voucherStatus(
  tenantId: string,
  voucherId: string,
): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM vouchers WHERE tenant_id = $1 AND id = $2",
    [tenantId, voucherId],
  );
  return rows[0]!.status;
}

/** Moves a voucher to a non-issued state the way the product does (setup, written directly). */
async function setVoucherState(
  tenantId: string,
  voucherId: string,
  state: Exclude<VoucherState, "issued">,
  usedOnOrderUuid: string,
) {
  if (state === "redeemed")
    await owner.query(
      `UPDATE vouchers SET status = 'redeemed', redeemed_at = now(), redeemed_order_id = $3
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, voucherId, usedOnOrderUuid],
    );
  else if (state === "cancelled")
    await owner.query(
      `UPDATE vouchers SET status = 'cancelled', cancelled_reason = 'uji 1095'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, voucherId],
    );
  else
    await owner.query(
      "UPDATE vouchers SET status = 'expired' WHERE tenant_id = $1 AND id = $2",
      [tenantId, voucherId],
    );
}

/**
 * What a checkout of ANOTHER order does to a voucher: lock that order, lock the voucher,
 * redeem it only if it is still issued. Returns whether it got the voucher.
 */
async function redeemVoucher(
  tenantId: string,
  voucherId: string,
  otherOrderUuid: string,
): Promise<boolean> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT 1 FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, otherOrderUuid],
    );
    await client.query(
      "SELECT 1 FROM vouchers WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, voucherId],
    );
    const updated = await client.query(
      `UPDATE vouchers SET status = 'redeemed', redeemed_at = now(), redeemed_order_id = $3
        WHERE tenant_id = $1 AND id = $2 AND status = 'issued'`,
      [tenantId, voucherId, otherOrderUuid],
    );
    await client.query("COMMIT");
    return updated.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockWaiters(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return rows[0]!.n;
}

/**
 * Holds `vouchers ... FOR UPDATE` of one voucher on its own connection, starts the two
 * requests one after the other, waits until each is blocked (or has already finished),
 * then releases and returns both answers in start order.
 */
async function raceOnVoucher<A, B>(
  tenantId: string,
  voucherId: string,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[A, B]> {
  const holder = await owner.connect();
  const settled = [false, false];
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT 1 FROM vouchers WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, voucherId],
    );
    const baseline = await lockWaiters();
    const waitFor = async (count: number) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if ((await lockWaiters()) >= baseline + count) return;
        if (settled.some(Boolean)) return; // finished without waiting: nothing to wait for
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const a = first().finally(() => (settled[0] = true));
    await waitFor(1);
    const b = second().finally(() => (settled[1] = true));
    await waitFor(2);
    await holder.query("COMMIT");
    return await Promise.all([a, b]);
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
}

// ---- cloud side -----------------------------------------------------------------------

/** A staff apology voucher (through the real API) tied to a fresh issue of `lineId`. */
async function apologyOn(
  world: PosWorld,
  lineId: string,
  valueIdr: number,
): Promise<{ issueId: string; voucherId: string }> {
  const issueId = await world.apologyVoucherFor(lineId, valueIdr);
  const { rows } = await owner.query<{ voucher_id: string }>(
    "SELECT voucher_id FROM apology_vouchers WHERE tenant_id = $1 AND order_issue_id = $2",
    [world.w.tenant.tenantId, issueId],
  );
  expect(rows, "one apology voucher bound to the issue").toHaveLength(1);
  return { issueId, voucherId: rows[0]!.voucher_id };
}

/** A CRM voucher tied to the order through a reported issue (order_issues.voucher_id). */
async function crmVoucherOn(
  paid: PaidOrder,
  lineId: string,
  valueIdr = 10_000,
): Promise<string> {
  const voucherId = await p.crmVoucher(valueIdr);
  const reported = await p.reportWithVoucher(paid, lineId, voucherId);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  return voucherId;
}

/** A paid plain order that became a completed POS sale (the cloud void needs a sale). */
async function posSale(): Promise<PaidOrder> {
  const paid = await p.paidPlainOrder();
  await p.becomePosSale(paid);
  return paid;
}

const status = (voucherId: string, world: PosWorld = p) =>
  voucherStatus(world.w.tenant.tenantId, voucherId);

/**
 * Money out of the order: void (whole paid amount) + cashier refunds + live ORD-09 +
 * ACTIVE vouchers (issued / redeemed) of the given vouchers.
 */
async function moneyOut(
  paid: PaidOrder,
  issueIds: string[],
  voucherIds: string[],
): Promise<number> {
  const { rows } = await owner.query<{ value_idr: string }>(
    `SELECT value_idr FROM vouchers
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status IN ('issued', 'redeemed')`,
    [p.w.tenant.tenantId, voucherIds],
  );
  return (
    (await p.voidCount(paid.orderId)) * ORDER_PAID +
    sum(await p.posRefundRows(paid.orderId)) +
    (await p.recoveryRefundTotal(issueIds)) +
    sum(rows.map((row) => Number(row.value_idr)))
  );
}

function expectUsedRefusal(
  outcome: Awaited<ReturnType<PosWorld["cloudVoid"]>>,
) {
  expect(outcome.ok, "void must be refused").toBe(false);
  if (outcome.ok) return;
  expect(outcome.error.status, errorText(outcome.error)).toBe(409);
  expect(errorText(outcome.error)).toContain("VOID_APOLOGY_VOUCHER_USED");
}

describe("legend-3dsih cloud void of an order with an apology / CRM voucher", () => {
  it("control: a sale without any voucher is voided as before", async () => {
    const paid = await posSale();
    const voided = await p.cloudVoid(paid.orderId);
    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(await p.voidCount(paid.orderId)).toBe(1);
  });

  it("an unused (issued) apology voucher is cancelled by the void; void ok; money out <= paid", async () => {
    const paid = await posSale();
    const { issueId, voucherId } = await apologyOn(p, paid.rotiLine, 10_000);
    expect(await status(voucherId)).toBe("issued");

    const voided = await p.cloudVoid(paid.orderId);
    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(await p.voidCount(paid.orderId)).toBe(1);
    expect(await status(voucherId), "voucher cancelled with the void").toBe(
      "cancelled",
    );
    expect(await moneyOut(paid, [issueId], [voucherId])).toBeLessThanOrEqual(
      ORDER_PAID,
    );
  });

  it("an unused (issued) CRM voucher on the order is cancelled by the void", async () => {
    const paid = await p.paidPlainOrder();
    const voucherId = await crmVoucherOn(paid, paid.kopiLine);
    await p.becomePosSale(paid);

    const voided = await p.cloudVoid(paid.orderId);
    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(await status(voucherId)).toBe("cancelled");
    expect(await moneyOut(paid, [], [voucherId])).toBeLessThanOrEqual(
      ORDER_PAID,
    );
  });

  it("two issued vouchers (apology + CRM): both are cancelled", async () => {
    const paid = await p.paidPlainOrder();
    const crm = await crmVoucherOn(paid, paid.kopiLine);
    const { issueId, voucherId } = await apologyOn(p, paid.rotiLine, 8_000);
    await p.becomePosSale(paid);

    const voided = await p.cloudVoid(paid.orderId);
    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(await status(crm)).toBe("cancelled");
    expect(await status(voucherId)).toBe("cancelled");
    expect(
      await moneyOut(paid, [issueId], [crm, voucherId]),
    ).toBeLessThanOrEqual(ORDER_PAID);
  });

  it("a redeemed apology voucher: void refused 409 VOID_APOLOGY_VOUCHER_USED, no void row, voucher stays redeemed", async () => {
    const paid = await posSale();
    const used = await p.paidPlainOrder(); // where the voucher was spent
    const { voucherId } = await apologyOn(p, paid.rotiLine, 10_000);
    await setVoucherState(
      p.w.tenant.tenantId,
      voucherId,
      "redeemed",
      toUuid(used.orderId),
    );

    const voided = await p.cloudVoid(paid.orderId);
    expectUsedRefusal(voided);
    expect(await p.voidCount(paid.orderId)).toBe(0);
    expect(await status(voucherId)).toBe("redeemed");
  });

  it("a redeemed CRM voucher on the order: void refused 409 VOID_APOLOGY_VOUCHER_USED", async () => {
    const paid = await p.paidPlainOrder();
    const used = await p.paidPlainOrder();
    const voucherId = await crmVoucherOn(paid, paid.kopiLine);
    await p.becomePosSale(paid);
    await setVoucherState(
      p.w.tenant.tenantId,
      voucherId,
      "redeemed",
      toUuid(used.orderId),
    );

    expectUsedRefusal(await p.cloudVoid(paid.orderId));
    expect(await p.voidCount(paid.orderId)).toBe(0);
    expect(await status(voucherId)).toBe("redeemed");
  });

  it("one redeemed among several: the whole void is refused and the issued voucher is NOT cancelled", async () => {
    const paid = await p.paidPlainOrder();
    const used = await p.paidPlainOrder();
    const redeemed = await crmVoucherOn(paid, paid.kopiLine);
    const { voucherId: issued } = await apologyOn(p, paid.rotiLine, 8_000);
    await p.becomePosSale(paid);
    await setVoucherState(
      p.w.tenant.tenantId,
      redeemed,
      "redeemed",
      toUuid(used.orderId),
    );

    expectUsedRefusal(await p.cloudVoid(paid.orderId));
    expect(await p.voidCount(paid.orderId)).toBe(0);
    expect(await status(redeemed)).toBe("redeemed");
    expect(await status(issued), "cancel rolled back with the refusal").toBe(
      "issued",
    );
  });

  it("expired and cancelled vouchers are ignored: the void succeeds and they are left as they were", async () => {
    const paid = await p.paidPlainOrder();
    const expired = await crmVoucherOn(paid, paid.kopiLine);
    const { voucherId: cancelled } = await apologyOn(p, paid.rotiLine, 8_000);
    await p.becomePosSale(paid);
    await setVoucherState(p.w.tenant.tenantId, expired, "expired", "");
    await setVoucherState(p.w.tenant.tenantId, cancelled, "cancelled", "");

    const voided = await p.cloudVoid(paid.orderId);
    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(await status(expired)).toBe("expired");
    expect(await status(cancelled)).toBe("cancelled");
  });

  it("a voucher on order X does not block or change the void of order Y (same tenant)", async () => {
    const x = await p.paidPlainOrder();
    const used = await p.paidPlainOrder();
    const y = await posSale();
    const { voucherId } = await apologyOn(p, x.rotiLine, 10_000);
    await setVoucherState(
      p.w.tenant.tenantId,
      voucherId,
      "redeemed",
      toUuid(used.orderId),
    );

    const voided = await p.cloudVoid(y.orderId);
    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(await p.voidCount(y.orderId)).toBe(1);
    expect(await status(voucherId)).toBe("redeemed");
  });

  it("another tenant's issued voucher is not cancelled by our void", async () => {
    const mine = await posSale();
    const theirs = await other.paidPlainOrder();
    const { voucherId: theirVoucher } = await apologyOn(
      other,
      theirs.rotiLine,
      10_000,
    );
    await apologyOn(p, mine.rotiLine, 10_000);

    const voided = await p.cloudVoid(mine.orderId);
    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(await status(theirVoucher, other)).toBe("issued");
  });
});

describe("legend-3dsih cloud void racing a redeem of the same voucher", () => {
  for (const [label, voidFirst] of [
    ["void starts first", true],
    ["redeem starts first", false],
  ] as const) {
    it(`${label}: never a recorded void AND a redeemed voucher`, async () => {
      const paid = await posSale();
      const checkout = await p.paidPlainOrder(); // the other order that spends the voucher
      const { issueId, voucherId } = await apologyOn(p, paid.rotiLine, 10_000);
      const tenantId = p.w.tenant.tenantId;

      const doVoid = () => p.cloudVoid(paid.orderId);
      const doRedeem = () =>
        redeemVoucher(tenantId, voucherId, toUuid(checkout.orderId));
      const [first, second] = await raceOnVoucher<unknown, unknown>(
        tenantId,
        voucherId,
        voidFirst ? doVoid : doRedeem,
        voidFirst ? doRedeem : doVoid,
      );
      const voidAnswer = (voidFirst ? first : second) as Awaited<
        ReturnType<PosWorld["cloudVoid"]>
      >;
      const redeemed = (voidFirst ? second : first) as boolean;

      const final = await status(voucherId);
      const voids = await p.voidCount(paid.orderId);
      expect(
        voids > 0 && final === "redeemed",
        `void rows ${voids}, voucher ${final}`,
      ).toBe(false);
      if (final === "redeemed") {
        expect(redeemed).toBe(true);
        expect(voids).toBe(0);
        expectUsedRefusal(voidAnswer);
      } else {
        expect(final).toBe("cancelled");
        expect(redeemed, "the voucher was cancelled first").toBe(false);
        expect(voidAnswer.ok, JSON.stringify(voidAnswer)).toBe(true);
        expect(voids).toBe(1);
      }
      expect(await moneyOut(paid, [issueId], [voucherId])).toBeLessThanOrEqual(
        ORDER_PAID,
      );
    });
  }
});

// ---- edge side ------------------------------------------------------------------------

type Order = { ulid: string; uuid: string };

/** An order ingested from the site's edge node, as a completed cloud order. */
async function edgeSale(s: Site = site): Promise<Order> {
  const ulid = createUlid();
  await s.kit.deliver([s.kit.paidEvent(ulid)]);
  expect(await s.kit.ingestOf(ulid)).toMatchObject({ state: "ingested" });
  return { ulid, uuid: ulidToUuid(ulid) };
}

/**
 * A CRM voucher tied to the edge order through a settled issue (order_issues.voucher_id),
 * in the given state. `usedOn` is the other sale the redeemed voucher was spent on.
 */
async function seedEdgeVoucher(
  s: Site,
  order: Order,
  state: VoucherState = "issued",
  usedOn?: Order,
): Promise<string> {
  const { tenantId, outletId } = s.tenant;
  const voucherId = randomUUID();
  await asOwnerTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM order_items WHERE tenant_id = $1 AND order_id = $2 LIMIT 1",
      [tenantId, order.uuid],
    );
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO vouchers (id, tenant_id, promotion_id, customer_profile_id, code_hash,
                             source, value_idr, valid_from, valid_until, status,
                             redeemed_at, redeemed_order_id, cancelled_reason)
       VALUES ($1, $2, NULL, NULL, $3, 'manual', 10000, now() - interval '1 hour', NULL, $4,
               $5, $6, $7)`,
      [
        voucherId,
        tenantId,
        randomBytes(32).toString("hex"),
        state,
        state === "redeemed" ? new Date() : null,
        state === "redeemed" ? (usedOn?.uuid ?? randomUUID()) : null,
        state === "cancelled" ? "uji 1095" : null,
      ],
    );
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, resolution, voucher_id, cost_idr, status, idempotency_key,
         resolved_at)
       VALUES ($1, $2, $3, $4, $5, 'complaint', 'complaint',
         'Pelanggan kecewa, diberi voucher', $6, 'voucher', $7, 0, 'resolved', $8, now())`,
      [
        randomUUID(),
        tenantId,
        outletId,
        order.uuid,
        rows[0]!.id,
        randomUUID(),
        voucherId,
        randomUUID(),
      ],
    );
  });
  return voucherId;
}

const REFUSED = {
  state: "ingested",
  reason: expect.stringMatching(/(^|:)apology_voucher_exists$/),
};

describe("legend-3dsih edge void of an order with a voucher", () => {
  it("control: a lone edge void without any voucher is recorded", async () => {
    const order = await edgeSale();
    await site.kit.deliver([site.kit.voidEvent(order.ulid)]);
    expect(await site.kit.voidRows(order.ulid)).toBe(1);
    expect(await site.kit.ingestOf(order.ulid)).toMatchObject({
      state: "voided",
    });
  });

  it("an issued voucher is cancelled together with the void; the void is recorded", async () => {
    const order = await edgeSale();
    const voucherId = await seedEdgeVoucher(site, order);

    await site.kit.deliver([site.kit.voidEvent(order.ulid)]);
    expect(await site.kit.voidRows(order.ulid)).toBe(1);
    expect(await site.kit.ingestOf(order.ulid)).toMatchObject({
      state: "voided",
    });
    expect(await voucherStatus(site.tenant.tenantId, voucherId)).toBe(
      "cancelled",
    );
  });

  it("a redeemed voucher: the void is refused (apology_voucher_exists), no void row, event parked, voucher untouched", async () => {
    const order = await edgeSale();
    const used = await edgeSale();
    const voucherId = await seedEdgeVoucher(site, order, "redeemed", used);

    await site.kit
      .deliver([site.kit.voidEvent(order.ulid)])
      .catch(() => undefined);
    expect(await site.kit.voidRows(order.ulid)).toBe(0);
    expect(await site.kit.ingestOf(order.ulid)).toMatchObject(REFUSED);
    expect(await site.kit.parkedVoids(order.ulid)).toBe(1);
    expect(await voucherStatus(site.tenant.tenantId, voucherId)).toBe(
      "redeemed",
    );
  });

  it("replay: a refused void stays refused, never throws, never applies (also as deliver([event, event]))", async () => {
    const order = await edgeSale();
    const used = await edgeSale();
    const voucherId = await seedEdgeVoucher(site, order, "redeemed", used);
    const event = site.kit.voidEvent(order.ulid);

    await site.kit.deliver([event]).catch(() => undefined);
    await expect(site.kit.deliver([event])).resolves.toBeUndefined();
    await expect(site.kit.deliver([event, event])).resolves.toBeUndefined();

    expect(await site.kit.voidRows(order.ulid)).toBe(0);
    expect(await site.kit.ingestOf(order.ulid)).toMatchObject(REFUSED);
    expect(await voucherStatus(site.tenant.tenantId, voucherId)).toBe(
      "redeemed",
    );
  });

  it("a later, different void event of the same sale is refused too while the voucher is redeemed", async () => {
    const order = await edgeSale();
    const used = await edgeSale();
    await seedEdgeVoucher(site, order, "redeemed", used);
    await site.kit
      .deliver([site.kit.voidEvent(order.ulid, 2)])
      .catch(() => undefined);
    await site.kit
      .deliver([site.kit.voidEvent(order.ulid, 3)])
      .catch(() => undefined);
    expect(await site.kit.voidRows(order.ulid)).toBe(0);
  });

  it("one redeemed among several: refused as a whole, the issued voucher is NOT cancelled", async () => {
    const order = await edgeSale();
    const used = await edgeSale();
    const redeemed = await seedEdgeVoucher(site, order, "redeemed", used);
    const issued = await seedEdgeVoucher(site, order, "issued");

    await site.kit
      .deliver([site.kit.voidEvent(order.ulid)])
      .catch(() => undefined);
    expect(await site.kit.voidRows(order.ulid)).toBe(0);
    expect(await site.kit.ingestOf(order.ulid)).toMatchObject(REFUSED);
    expect(await voucherStatus(site.tenant.tenantId, redeemed)).toBe(
      "redeemed",
    );
    expect(
      await voucherStatus(site.tenant.tenantId, issued),
      "cancel rolled back with the refusal",
    ).toBe("issued");
  });

  it("expired and cancelled vouchers are ignored: the void is recorded, they stay as they were", async () => {
    const order = await edgeSale();
    const expired = await seedEdgeVoucher(site, order, "expired");
    const cancelled = await seedEdgeVoucher(site, order, "cancelled");

    await site.kit.deliver([site.kit.voidEvent(order.ulid)]);
    expect(await site.kit.voidRows(order.ulid)).toBe(1);
    expect(await voucherStatus(site.tenant.tenantId, expired)).toBe("expired");
    expect(await voucherStatus(site.tenant.tenantId, cancelled)).toBe(
      "cancelled",
    );
  });

  it("isolation: a redeemed voucher on order X does not block the void of order Y (same outlet)", async () => {
    const x = await edgeSale();
    const used = await edgeSale();
    const y = await edgeSale();
    await seedEdgeVoucher(site, x, "redeemed", used);

    await site.kit.deliver([site.kit.voidEvent(y.ulid)]);
    expect(await site.kit.voidRows(y.ulid)).toBe(1);
    expect(await site.kit.ingestOf(y.ulid)).toMatchObject({ state: "voided" });
  });

  it("isolation: another tenant's vouchers are neither cancelled nor refuse our void", async () => {
    const ours = await edgeSale();
    const theirs = await edgeSale(siteB);
    const theirUsed = await edgeSale(siteB);
    const theirIssued = await seedEdgeVoucher(siteB, theirs);
    await seedEdgeVoucher(siteB, theirUsed, "redeemed", theirs);

    await site.kit.deliver([site.kit.voidEvent(ours.ulid)]);
    expect(await site.kit.voidRows(ours.ulid)).toBe(1);
    expect(await voucherStatus(siteB.tenant.tenantId, theirIssued)).toBe(
      "issued",
    );
    expect(await siteB.kit.voidRows(theirs.ulid)).toBe(0);
  });
});

describe("legend-3dsih edge void racing a redeem of the same voucher", () => {
  for (const [label, voidFirst] of [
    ["void starts first", true],
    ["redeem starts first", false],
  ] as const) {
    it(`${label}: never a recorded void AND a redeemed voucher`, async () => {
      const order = await edgeSale();
      const checkout = await edgeSale(); // the other sale that spends the voucher
      const voucherId = await seedEdgeVoucher(site, order);
      const tenantId = site.tenant.tenantId;

      const doVoid = () =>
        site.kit
          .deliver([site.kit.voidEvent(order.ulid)])
          .catch(() => undefined);
      const doRedeem = () => redeemVoucher(tenantId, voucherId, checkout.uuid);
      const [first, second] = await raceOnVoucher<unknown, unknown>(
        tenantId,
        voucherId,
        voidFirst ? doVoid : doRedeem,
        voidFirst ? doRedeem : doVoid,
      );
      const redeemed = (voidFirst ? second : first) as boolean;

      const final = await voucherStatus(tenantId, voucherId);
      const voids = await site.kit.voidRows(order.ulid);
      expect(
        voids > 0 && final === "redeemed",
        `void rows ${voids}, voucher ${final}`,
      ).toBe(false);
      if (final === "redeemed") {
        expect(redeemed).toBe(true);
        expect(voids).toBe(0);
        expect(await site.kit.ingestOf(order.ulid)).toMatchObject(REFUSED);
      } else {
        expect(final).toBe("cancelled");
        expect(redeemed, "the voucher was cancelled first").toBe(false);
        expect(voids).toBe(1);
        expect(await site.kit.ingestOf(order.ulid)).toMatchObject({
          state: "voided",
        });
      }
      expect(voids * EDGE_PAID).toBeLessThanOrEqual(EDGE_PAID);
    });
  }
});
