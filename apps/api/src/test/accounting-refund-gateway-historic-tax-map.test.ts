// Fail-first regression tests for legend-5i6k1 (docs/briefs/sub-codex-money.md,
// card B): the guard that keeps a refund payout from crediting a tax or service
// charge account must use the CURRENT and the HISTORICAL account map together.
//
// Scenario (from the brief): a QRIS (gateway) sale books its tax on account A.
// Later the mappings change. A gateway refund of Rp 100.000 must then be parked
// as ACCOUNT_MAPPING_MISSING, never posted: otherwise the payout credit
// (customer_deposit, owed until the payout) lands on a tax account.
//
// Assumptions (the brief does not pin them, stated here):
// - Case 1 is the brief literally: tax_payable_pbjt AND customer_deposit are
//   both remapped to a new account B. Case 2 is my addition, the sharper one
//   for "historical": tax_payable_pbjt moves to B while customer_deposit moves
//   onto A, the account the sale booked its tax on. Both must park.
// - Parked code is ACCOUNT_MAPPING_MISSING and the row is retryable, so the
//   sweep can post the same event once the mapping is fixed (same convention as
//   accounting-refund-payout-map-race.test.ts, case 2).
// - The gateway tender names a payment intent whose receipt (payment.paid) is
//   posted. Since legend-2jyr/27mt the refund is split per intent: a refund of a
//   posted-receipt intent credits customer_deposit (owed until a payout), while
//   an intentless tender (or an intent without receipt) only reverses
//   gateway_clearing and has no payout to guard. The payout-credit guard under
//   test therefore needs the intent, else no refund ever credits customer_deposit.
// - Money proof: no journal row is added by the parked delivery, neither the
//   tax account A nor B moves, exactly one parked row exists, and after the
//   mapping is restored the sweep posts the refund exactly once (payout credit
//   == sale total, never more).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { retryParkedAutoJournals } from "../services/accounting-auto-journal-consumer.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  asTenant,
  balanceOf,
  contextOf,
  createUlid,
  deliver,
  journalCount,
  orderPaid,
  orderRefunded,
  owner,
  post,
  seedPosOrder,
  totalOf,
  ulidToUuid,
  makeWorld,
  type Sale,
  type World,
} from "./accounting-tax-split-helpers.ts";

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

/** Gross 90.000 + PBJT 10.000 = 100.000, all paid by QRIS. */
const TAX = 10_000;
const sale: Sale = {
  grossSalesIdr: 90_000,
  snapshots: { pbjt: { baseIdr: 90_000, taxIdr: TAX, rateBp: 1000 } },
};
const SALE_TOTAL = totalOf(sale); // 100.000

/** A paid QRIS intent with its payment link (as accounting-auto-journal-refund-split). */
async function seedIntent(world: World): Promise<string> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      world.tenant.id,
      world.outletId,
      randomBytes(32).toString("hex"),
      `HT-${linkId.slice(0, 8)}`,
      SALE_TOTAL,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
        status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', $7,
             '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [
      intentId,
      world.tenant.id,
      world.outletId,
      linkId,
      SALE_TOTAL,
      `ht-${intentId}`,
      "2026-10-15T05:00:00.000Z",
    ],
  );
  return intentId;
}

function paymentPaid(world: World, intentId: string): EventEnvelope {
  const id = createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenant.id,
    outletId: world.outletId,
    name: "payment.paid",
    version: 1,
    aggregateType: "payment",
    aggregateId: intentId,
    sequence: 1,
    occurredAt: "2026-10-15T05:00:00.000Z",
    actor: { type: "system" },
    idempotencyKey: `ht-test-${id}`,
    payloadSchemaRef: "payment.paid.v1",
    payload: {
      intentId,
      method: "qris",
      provider: "doit",
      receivedIdr: SALE_TOTAL,
      paidAt: "2026-10-15T05:00:00.000Z",
      late: false,
    },
  });
}

/**
 * The sale: one captured QRIS tender of a paid intent whose receipt is posted
 * (journal 1: Dr gateway_clearing, Cr customer_deposit), paid event in gateway.
 */
async function seedGatewaySale(
  world: World,
): Promise<{ orderUlid: string; paid: EventEnvelope }> {
  const orderUlid = createUlid();
  await seedPosOrder(world, orderUlid, sale);
  const intentId = await seedIntent(world);
  await post(world, paymentPaid(world, intentId));
  // seedPosOrder books a cash tender; make it a gateway tender.
  // The order is already final (immutable trigger), so switch triggers off for
  // this one seeding statement; setup only, same rows the sale would have had.
  await asTenant(world.tenant, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE pos_order_tenders
          SET method = 'qris', provider = 'doit', received_idr = NULL, change_idr = NULL,
              payment_intent_id = $3
        WHERE tenant_id = $1 AND order_id = $2`,
      [world.tenant.id, ulidToUuid(orderUlid), intentId],
    );
  });
  const event = orderPaid(world, orderUlid, sale);
  const paid = {
    ...event,
    payload: {
      ...(event.payload as Record<string, unknown>),
      paidCashIdr: 0,
      paidGatewayIdr: SALE_TOTAL,
      tenders: [{ method: "qris", amountIdr: SALE_TOTAL }],
    },
  } as EventEnvelope;
  return { orderUlid, paid };
}

/** order.refunded of the whole sale, paid back through the gateway. */
function gatewayRefund(world: World, orderUlid: string): EventEnvelope {
  const event = orderRefunded(world, orderUlid, createUlid(), {
    grossSalesIdr: sale.grossSalesIdr,
    taxIdr: TAX,
  });
  return {
    ...event,
    payload: {
      ...(event.payload as Record<string, unknown>),
      amountIdr: SALE_TOTAL,
      refundCashIdr: 0,
      refundGatewayIdr: SALE_TOTAL,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines: [{ method: "qris", amountIdr: SALE_TOTAL }],
    },
  } as EventEnvelope;
}

const outcomeOf = (result: { status: string; code?: string }): string =>
  result.status === "parked" ? `parked:${result.code}` : result.status;

/** A new account B in the same chart (a tax account the sale never used). */
async function newAccount(world: World, code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, $3, 'Utang Pajak Baru', 'liability', 'current_liability') RETURNING id`,
    [world.tenant.id, world.entity, code],
  );
  return rows[0]!.id;
}

async function mapRole(
  world: World,
  role: "tax_payable_pbjt" | "customer_deposit",
  accountId: string,
): Promise<void> {
  await owner.query(
    `UPDATE account_mappings SET account_id = $4
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3`,
    [world.tenant.id, world.entity, role, accountId],
  );
}

async function accountBalance(
  world: World,
  accountId: string,
): Promise<{ debit: number; credit: number }> {
  const { rows } = await owner.query<{ debit: string; credit: string }>(
    `SELECT coalesce(sum(debit_idr), 0)::text AS debit, coalesce(sum(credit_idr), 0)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, accountId],
  );
  return { debit: Number(rows[0]!.debit), credit: Number(rows[0]!.credit) };
}

async function parkedRows(world: World) {
  return asTenant(world.tenant, (client) =>
    client.query<{ error_code: string; retryable: boolean }>(
      "SELECT error_code, retryable FROM auto_journal_parked WHERE tenant_id = $1",
      [world.tenant.id],
    ),
  );
}

/** Credit booked on customer_deposit by refund journals, over the ledger. */
async function refundPayoutCredit(world: World): Promise<number> {
  const { rows } = await owner.query<{ credit: string }>(
    `SELECT coalesce(sum(l.credit_idr), 0)::text AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.tenant_id = $1 AND e.source_type = 'refund'
        AND l.account_id = $2`,
    [world.tenant.id, world.accounts.customer_deposit],
  );
  return Number(rows[0]!.credit);
}

describe("legend-5i6k1 gateway refund vs current + historical tax account", () => {
  it("control: with the original mapping the gateway refund of Rp 100.000 posts and credits customer_deposit only", async () => {
    const world = await makeWorld();
    const { orderUlid, paid } = await seedGatewaySale(world);
    expect(outcomeOf(await deliver(world, paid))).toBe("posted");
    const result = await deliver(world, gatewayRefund(world, orderUlid));
    expect(outcomeOf(result)).toBe("posted");
    expect(await refundPayoutCredit(world)).toBe(SALE_TOTAL);
    // Tax account: credited TAX by the sale, debited TAX by the refund.
    expect(
      await accountBalance(world, world.accounts.tax_payable_pbjt),
    ).toEqual({ debit: TAX, credit: TAX });
  });

  it("case 1: pbjt and customer_deposit both remapped to a new account B after the sale: the refund is parked ACCOUNT_MAPPING_MISSING, nothing credits B", async () => {
    const world = await makeWorld();
    const accountA = world.accounts.tax_payable_pbjt;
    const { orderUlid, paid } = await seedGatewaySale(world);
    expect(outcomeOf(await deliver(world, paid))).toBe("posted");
    const accountB = await newAccount(
      world,
      `2999${Math.floor(Math.random() * 90 + 10)}`,
    );
    await mapRole(world, "tax_payable_pbjt", accountB);
    await mapRole(world, "customer_deposit", accountB);
    const before = {
      a: await accountBalance(world, accountA),
      b: await accountBalance(world, accountB),
    };

    const result = await deliver(world, gatewayRefund(world, orderUlid));

    expect(outcomeOf(result)).toBe("parked:ACCOUNT_MAPPING_MISSING");
    // No party paid more: no refund journal, no line on A or B.
    expect(await journalCount(world)).toBe(2);
    expect(await accountBalance(world, accountA)).toEqual(before.a);
    expect(await accountBalance(world, accountB)).toEqual(before.b);
    // Parked exactly once.
    const parked = (await parkedRows(world)).rows;
    expect(parked.map((row) => row.error_code)).toEqual([
      "ACCOUNT_MAPPING_MISSING",
    ]);
    expect(parked[0]!.retryable).toBe(true);

    // Delivering the same event again does not park a second row.
    await deliver(world, gatewayRefund(world, orderUlid));
    expect(await journalCount(world)).toBe(2);
  });

  it("case 2: customer_deposit remapped onto account A (the account the sale booked tax on), pbjt moved to B: the refund is parked, A is not credited", async () => {
    const world = await makeWorld();
    const accountA = world.accounts.tax_payable_pbjt;
    const { orderUlid, paid } = await seedGatewaySale(world);
    expect(outcomeOf(await deliver(world, paid))).toBe("posted");
    const accountB = await newAccount(
      world,
      `2998${Math.floor(Math.random() * 90 + 10)}`,
    );
    await mapRole(world, "tax_payable_pbjt", accountB);
    await mapRole(world, "customer_deposit", accountA);
    const before = {
      a: await accountBalance(world, accountA),
      b: await accountBalance(world, accountB),
    };

    const result = await deliver(world, gatewayRefund(world, orderUlid));

    // Already refused today (with AUTO_JOURNAL_PAYLOAD_INVALID), so this case is
    // a regression guard, not fail-first: only "parked, never posted" is pinned.
    expect(result.status).toBe("parked");
    expect(await journalCount(world)).toBe(2);
    expect(await accountBalance(world, accountA)).toEqual(before.a);
    expect(await accountBalance(world, accountB)).toEqual(before.b);
    expect((await parkedRows(world)).rows).toHaveLength(1);
  });

  it("case 3: after the mapping is restored the sweep posts the refund exactly once; payout credit equals the sale total, never more", async () => {
    const world = await makeWorld();
    const { orderUlid, paid } = await seedGatewaySale(world);
    expect(outcomeOf(await deliver(world, paid))).toBe("posted");
    const accountB = await newAccount(
      world,
      `2997${Math.floor(Math.random() * 90 + 10)}`,
    );
    await mapRole(world, "tax_payable_pbjt", accountB);
    await mapRole(world, "customer_deposit", accountB);
    const result = await deliver(world, gatewayRefund(world, orderUlid));
    expect(outcomeOf(result)).toBe("parked:ACCOUNT_MAPPING_MISSING");

    await mapRole(world, "tax_payable_pbjt", world.accounts.tax_payable_pbjt);
    await mapRole(world, "customer_deposit", world.accounts.customer_deposit);
    const later = (hours: number) =>
      new Date(Date.now() + hours * 60 * 60 * 1000);
    expect(
      await retryParkedAutoJournals(contextOf(world.tenant), later(48)),
    ).toEqual({ posted: 1, stillParked: 0, failed: 0 });
    expect((await parkedRows(world)).rows).toEqual([]);
    expect(await journalCount(world)).toBe(3);
    expect(
      (await retryParkedAutoJournals(contextOf(world.tenant), later(96)))
        .posted,
    ).toBe(0);
    expect(await journalCount(world)).toBe(3);

    expect(await refundPayoutCredit(world)).toBe(SALE_TOTAL);
    // Outlet not at a loss: the gateway money taken in is still in clearing,
    // the customer is owed it back once, tax lines net to zero.
    expect(await balanceOf(world, "customer_deposit")).toBe(-SALE_TOTAL);
    expect(await balanceOf(world, "tax_payable_pbjt")).toBe(0);
  });
});
