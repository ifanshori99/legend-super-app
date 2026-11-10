// WS-03 (bead legend-n1mp), work package Y: a table claim and the earn
// consumer.
//
// - F1: a void or refund of the order takes back the points of a table claim
//   (claim rows live only in point_ledger: source_id is the order id for a
//   whole-bill claim, a bill_splits id for a split part). Reverse row, same
//   shape as the normal earn reversal, idempotent on replay.
// - F3: the consumer's daily cap also counts the points a member claimed that
//   business date.
//
// The claim ledger rows are posted through `postLedgerEntry` exactly as
// table-claim.service.ts does (type earn, sourceType table_claim); the events
// are delivered to the real earn consumer.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { postLedgerEntry } from "../services/point-ledger.service.ts";
import {
  DATE,
  NOW,
  asTenant,
  balanceOf,
  createWorld,
  deliver,
  ledgerOf,
  orderPaidEvent,
  orderRefundedEvent,
  orderVoidedEvent,
  owner,
  recordOf,
  seedMember,
  seedOrder,
  seedProgram,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => {
  await owner.end();
});

/** Claim points as the claim service posts them. */
async function claim(
  world: World,
  profileId: string,
  sourceId: string,
  points: number,
): Promise<void> {
  await withTenant(db, world.context, (tx) =>
    postLedgerEntry(
      tx,
      world.context,
      {
        tenantId: world.tenantId,
        customerProfileId: profileId,
        outletId: world.outletA,
        type: "earn",
        points,
        sourceType: "table_claim",
        sourceId,
        expiresAt: new Date("2027-10-15T00:00:00Z"),
        businessDate: DATE,
      },
      NOW,
    ),
  );
}

/** A paid guest order (no member attached) of Rp100.000. */
async function guestOrder(world: World): Promise<string> {
  return seedOrder(world.tenantId, {
    outletId: world.outletA,
    channel: "qr",
    profileId: null,
    grossSalesIdr: 100_000,
  });
}

/** Two bill_splits rows of the order (the FK to the table session is skipped). */
async function seedSplits(
  world: World,
  orderUlid: string,
): Promise<[string, string]> {
  const ids: [string, string] = [randomUUID(), randomUUID()];
  const setId = randomUUID();
  const sessionId = randomUUID();
  await asTenant(world.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    for (const [index, id] of ids.entries())
      await client.query(
        `INSERT INTO bill_splits
           (id, tenant_id, outlet_id, table_session_id, order_id, split_set_id, method,
            share_index, amount_idr, status, paid_at)
         VALUES ($1, $2, $3, $4, (SELECT id FROM orders WHERE id = $5::uuid), $6, 'equal',
                 $7, 50000, 'paid', now())`,
        [
          id,
          world.tenantId,
          world.outletA,
          sessionId,
          ulidToUuid(orderUlid),
          setId,
          index,
        ],
      );
  });
  return ids;
}

const reverseRows = (rows: Awaited<ReturnType<typeof ledgerOf>>) =>
  rows.filter((row) => row.type === "reverse");

describe("legend-n1mp F1: void/refund takes back table-claim points", () => {
  it("void after a whole-bill claim reverses it, and a replay changes nothing", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId, { earnSpendIdr: 1000 });
    const member = await seedMember(world.tenantId);
    const orderUlid = await guestOrder(world);
    await claim(world, member.id, orderUlid, 50);
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);

    const voided = orderVoidedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      voidId: randomUUID(),
      voidedFinalOrder: true,
    });
    await deliver(world, voided);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const ledger = await ledgerOf(world.tenantId, member.id);
    const earn = ledger.find((row) => row.source_type === "table_claim")!;
    const reversed = reverseRows(ledger);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toMatchObject({
      points: "-50",
      source_type: "void",
      reverses_entry_id: earn.id,
    });

    await deliver(world, voided);
    expect(reverseRows(await ledgerOf(world.tenantId, member.id))).toHaveLength(
      1,
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("void reverses every claimed part of a split order", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId, { earnSpendIdr: 1000 });
    const a = await seedMember(world.tenantId);
    const b = await seedMember(world.tenantId);
    const orderUlid = await guestOrder(world);
    const [splitA, splitB] = await seedSplits(world, orderUlid);
    await claim(world, a.id, splitA, 20);
    await claim(world, b.id, splitB, 30);

    const voided = orderVoidedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      voidId: randomUUID(),
      voidedFinalOrder: true,
    });
    await deliver(world, voided);
    expect(await balanceOf(world.tenantId, a.id)).toBe(0);
    expect(await balanceOf(world.tenantId, b.id)).toBe(0);
    expect(reverseRows(await ledgerOf(world.tenantId, a.id))).toHaveLength(1);
    expect(reverseRows(await ledgerOf(world.tenantId, b.id))).toHaveLength(1);

    await deliver(world, voided);
    expect(await balanceOf(world.tenantId, a.id)).toBe(0);
    expect(reverseRows(await ledgerOf(world.tenantId, a.id))).toHaveLength(1);
  });

  it("a full refund reverses the claim, and a replay changes nothing", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId, { earnSpendIdr: 1000 });
    const member = await seedMember(world.tenantId);
    const orderUlid = await guestOrder(world);
    await claim(world, member.id, orderUlid, 50);

    const refunded = orderRefundedEvent(world, {
      orderUlid,
      outletId: world.outletA,
      refundId: randomUUID(),
      grossSalesIdr: 100_000,
    });
    await deliver(world, refunded);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const reversed = reverseRows(await ledgerOf(world.tenantId, member.id));
    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toMatchObject({ points: "-50", source_type: "refund" });

    await deliver(world, refunded);
    expect(reverseRows(await ledgerOf(world.tenantId, member.id))).toHaveLength(
      1,
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });
});

describe("legend-n1mp F3: the daily cap counts claimed points", () => {
  it("cap 100, claim 100: a member-attached order of the same business date books 0", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId, { earnSpendIdr: 1000, dailyCap: 100 });
    const member = await seedMember(world.tenantId);
    await claim(world, member.id, createUlid(), 100);

    const orderUlid = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
      grossSalesIdr: 100_000,
    });
    await deliver(
      world,
      orderPaidEvent(world, { orderUlid, outletId: world.outletA }),
    );
    const record = await recordOf(world.tenantId, orderUlid);
    expect(record?.state).toBe("capped");
    expect(Number(record?.booked_points)).toBe(0);
    expect(Number(record?.capped_points)).toBe(100);
    expect(await balanceOf(world.tenantId, member.id)).toBe(100);
  });
});
