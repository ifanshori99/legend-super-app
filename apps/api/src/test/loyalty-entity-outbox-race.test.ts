import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createUlid, idr, ulidToUuid } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { appendOutbox } from "../services/core-outbox.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { updateLoyaltyProgram } from "../services/loyalty-program.service.ts";
import {
  asTenant,
  createWorld,
  orderPaidEvent,
  owner,
  seedMember,
  seedOrder,
  seedProgram,
} from "./member-loyalty-helpers.ts";

afterAll(async () => owner.end());

describe("loyalty entity update and member payment race", () => {
  it("keeps an order event committed when its producer holds the order during an entity update", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId);
    const entityA = (
      await asTenant(world.tenantId, (client) =>
        client.query(
          "SELECT legal_entity_id FROM outlets WHERE tenant_id = $1 AND id = $2",
          [world.tenantId, world.outletA],
        ),
      )
    ).rows[0].legal_entity_id as string;
    const entityB = randomUUID();
    const outletB = randomUUID();
    await asTenant(world.tenantId, async (client) => {
      await client.query(
        "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity B', false)",
        [entityB, world.tenantId],
      );
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, 'Outlet B', 'Jl. B', 'Asia/Jakarta', '{}', 'active')`,
        [
          outletB,
          world.tenantId,
          world.brandId,
          entityB,
          `RB-${outletB.slice(0, 6).toUpperCase()}`,
        ],
      );
    });
    const input = {
      name: "Poin Member",
      earnRate: { spendIdr: idr(10_000), points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: idr(100),
      isActive: true,
      legalEntityId: entityA,
    };
    await updateLoyaltyProgram(world.context, randomUUID(), input);
    const member = await seedMember(world.tenantId);
    const orderId = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
    });
    const event = orderPaidEvent(world, {
      orderUlid: orderId,
      outletId: world.outletA,
    });
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const producer = withTenant(db, world.context, async (tx) => {
      await tx.execute(
        sql`SELECT id FROM orders WHERE tenant_id = ${world.tenantId} AND id = ${ulidToUuid(orderId)} FOR UPDATE`,
      );
      ready();
      await proceed;
      await appendOutbox(tx, world.context, {
        id: createUlid(),
        event,
        destination: "cloud-sync",
        direction: null,
        peerId: null,
      });
    });
    try {
      await held;
      await expect(
        updateLoyaltyProgram(world.context, randomUUID(), {
          ...input,
          legalEntityId: entityB,
        }),
      ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_BUSY" });
    } finally {
      release();
    }
    await producer;
    const events = await asTenant(world.tenantId, (client) =>
      client.query(
        "SELECT status FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'order.paid'",
        [world.tenantId, ulidToUuid(orderId)],
      ),
    );
    expect(events.rows).toEqual([{ status: "pending" }]);
    await expect(
      updateLoyaltyProgram(world.context, randomUUID(), {
        ...input,
        legalEntityId: entityB,
      }),
    ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
  });

  it.each(["order", "intent"] as const)(
    "refuses an entity update while the payment %s is locked, then confirms the payment",
    async (lockedSource) => {
      const world = await createWorld();
      await seedProgram(world.tenantId);
      const entityA = (
        await asTenant(world.tenantId, (client) =>
          client.query(
            "SELECT legal_entity_id FROM outlets WHERE tenant_id = $1 AND id = $2",
            [world.tenantId, world.outletA],
          ),
        )
      ).rows[0].legal_entity_id as string;
      const entityB = randomUUID();
      const outletB = randomUUID();
      await asTenant(world.tenantId, async (client) => {
        await client.query(
          "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity B', false)",
          [entityB, world.tenantId],
        );
        await client.query(
          `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
           VALUES ($1, $2, $3, $4, $5, 'Outlet B', 'Jl. B', 'Asia/Jakarta', '{}', 'active')`,
          [
            outletB,
            world.tenantId,
            world.brandId,
            entityB,
            `RB-${outletB.slice(0, 6).toUpperCase()}`,
          ],
        );
      });
      const input = {
        name: "Poin Member",
        earnRate: { spendIdr: idr(10_000), points: 1 },
        expiryMonths: 12,
        rollingMonths: 12,
        pointValueIdr: idr(100),
        isActive: true,
        legalEntityId: entityA,
      };
      await updateLoyaltyProgram(world.context, randomUUID(), input);
      const member = await seedMember(world.tenantId);
      const orderId = await seedOrder(world.tenantId, {
        outletId: world.outletA,
        channel: "qr",
        profileId: member.id,
        status: "draft",
      });
      const linkId = randomUUID();
      const intentId = randomUUID();
      await asTenant(world.tenantId, async (client) => {
        await client.query(
          `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
           VALUES ($1, $2, $3, $4, $5, 100000, 100000, 0, 'seed')`,
          [
            linkId,
            world.tenantId,
            world.outletA,
            randomBytes(32).toString("hex"),
            `RACE-${linkId.slice(0, 8)}`,
          ],
        );
        await client.query(
          `UPDATE orders SET status = 'awaiting_payment', payment_link_id = $3, payment_link_token_sealed = 'sealed'
           WHERE tenant_id = $1 AND id = $2`,
          [world.tenantId, ulidToUuid(orderId), linkId],
        );
        await client.query(
          `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider, amount_idr, idempotency_key, status, instructions, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', 100000, $6, 'pending', '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour')`,
          [
            intentId,
            world.tenantId,
            world.outletA,
            linkId,
            ulidToUuid(orderId),
            `race-${intentId}`,
          ],
        );
      });
      let release!: () => void;
      let ready!: () => void;
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = asTenant(world.tenantId, async (client) => {
        if (lockedSource === "order")
          await client.query(
            "SELECT id FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
            [world.tenantId, ulidToUuid(orderId)],
          );
        else
          await client.query(
            "SELECT id FROM payment_intents WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
            [world.tenantId, intentId],
          );
        ready();
        await proceed;
      });
      await held;
      const payment = confirmPayment(world.context, intentId, {
        source: "verified_webhook",
        method: "qris",
        amountIdr: 100_000,
        providerRef: `WEBHOOK-${intentId}`,
        at: new Date().toISOString(),
      });
      try {
        await expect(
          updateLoyaltyProgram(world.context, randomUUID(), {
            ...input,
            legalEntityId: entityB,
          }),
        ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_BUSY" });
      } finally {
        release();
      }
      await holder;
      expect((await payment).status).toBe("paid");
      const facts = await asTenant(world.tenantId, async (client) => ({
        intent: (
          await client.query(
            "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
            [world.tenantId, intentId],
          )
        ).rows,
        events: (
          await client.query(
            "SELECT event->>'name' AS name FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'payment.paid'",
            [world.tenantId, intentId],
          )
        ).rows,
      }));
      expect(facts.intent).toEqual([{ status: "paid" }]);
      expect(facts.events).toEqual([{ name: "payment.paid" }]);
      await expect(
        updateLoyaltyProgram(world.context, randomUUID(), {
          ...input,
          legalEntityId: entityB,
        }),
      ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    },
  );
});
