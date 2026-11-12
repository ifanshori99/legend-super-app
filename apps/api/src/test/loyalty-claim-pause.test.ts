import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { openSecret } from "../lib/secrets.ts";
import {
  issueWholeBillClaimTx,
  getPointClaim,
} from "../services/table-claim.service.ts";
import {
  markSplitPartPaidTx,
  expireSplitClaimsTx,
  getSplitClaimByToken,
} from "../services/bill-split.service.ts";
import {
  asTenant,
  createWorld,
  owner,
  seedOrder,
  seedProgram,
} from "./member-loyalty-helpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
afterAll(async () => owner.end());

async function fixture() {
  const world = await createWorld();
  await seedProgram(world.tenantId);
  const zone = randomUUID();
  const table = randomUUID();
  const session = randomUUID();
  const entityB = randomUUID();
  const credential = `guest-${randomUUID()}`;
  const now = new Date();
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity B', false)",
      [entityB, world.tenantId],
    );
    await client.query(
      "UPDATE loyalty_programs SET legal_entity_id = (SELECT legal_entity_id FROM outlets WHERE tenant_id = $1 AND id = $2) WHERE tenant_id = $1",
      [world.tenantId, world.outletA],
    );
    await client.query(
      "UPDATE outlets SET legal_entity_id = $3 WHERE tenant_id = $1 AND id = $2",
      [world.tenantId, world.outletB, entityB],
    );
    await client.query(
      "INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours) VALUES ($1, $2, $3, 'Zone', 'pay_first', '[]')",
      [zone, world.tenantId, world.outletB],
    );
    await client.query(
      "INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout) VALUES ($1, $2, $3, $4, 'T1', 4, 'regular', '{}')",
      [table, world.tenantId, world.outletB, zone],
    );
    await client.query(
      `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status, session_token_hash, session_token_sealed, opened_at, last_activity_at)
       VALUES ($1, $2, $3, $4, 2, 'pay_first', 'open', $5, 'sealed', $6, $6)`,
      [
        session,
        world.tenantId,
        world.outletB,
        table,
        createHash("sha256").update(credential).digest("hex"),
        new Date(now.getTime() + DAY_MS),
      ],
    );
  });
  const orderId = await seedOrder(world.tenantId, {
    outletId: world.outletB,
    channel: "qr",
    profileId: null,
    status: "draft",
  });
  await asTenant(world.tenantId, (client) =>
    client.query(
      "UPDATE orders SET table_session_id = $3, status = 'sent', fired_at = $4 WHERE tenant_id = $1 AND id = $2",
      [world.tenantId, ulidToUuid(orderId), session, now],
    ),
  );
  return { world, session, credential, now, orderId };
}

describe("paused guest claim", () => {
  it.each(["pending", "approved", "failed", "completed"] as const)(
    "migration backfill preserves a live ambiguous claim when refund is %s",
    async (refundStatus) => {
      const f = await fixture();
      await withTenant(db, f.world.context, (tx) =>
        issueWholeBillClaimTx(tx, f.world.context, f.orderId, f.now),
      );
      const intentId = randomUUID();
      const linkId = randomUUID();
      const orderId = ulidToUuid(f.orderId);
      const sqlText = readFileSync(
        new URL("../../drizzle/0405_public_tarantula.sql", import.meta.url),
        "utf8",
      );
      const backfill = sqlText
        .split("--> statement-breakpoint")
        .find(
          (part) =>
            part.includes("WITH entities AS") &&
            part.includes("valid_orders AS"),
        );
      expect(backfill).toBeTruthy();
      await asTenant(f.world.tenantId, async (client) => {
        await client.query(
          "DELETE FROM loyalty_claim_pauses WHERE tenant_id = $1 AND order_id = $2",
          [f.world.tenantId, orderId],
        );
        await client.query(
          `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
          VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, 'seed')`,
          [
            linkId,
            f.world.tenantId,
            f.world.outletB,
            createHash("sha256").update(linkId).digest("hex"),
            `P-${linkId.slice(0, 8)}`,
          ],
        );
        await client.query(
          `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
          VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', 100000, $6, 'paid', $7, '{"method":"qris","qrPayload":"test","issuer":null}', $7)`,
          [
            intentId,
            f.world.tenantId,
            f.world.outletB,
            linkId,
            orderId,
            `refund-test-${intentId}`,
            f.now,
          ],
        );
        await client.query(
          `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
          VALUES ($1, $2, $3, 10000, 'test', $4, 'seed')`,
          [f.world.tenantId, f.world.outletB, intentId, refundStatus],
        );
        await client.query(backfill!);
      });
      const paused = await asTenant(f.world.tenantId, (client) =>
        client.query(
          "SELECT state, remaining_ms FROM loyalty_claim_pauses WHERE tenant_id = $1 AND order_id = $2",
          [f.world.tenantId, orderId],
        ),
      );
      if (refundStatus === "completed") expect(paused.rows).toHaveLength(0);
      else {
        expect(paused.rows).toHaveLength(1);
        expect(paused.rows[0].state).toBe("ambiguous");
        expect(Number(paused.rows[0].remaining_ms)).toBeGreaterThan(0);
      }
    },
  );
  it("freezes the whole-bill TTL at issuance without a guest request, while a later void remains unavailable", async () => {
    const f = await fixture();
    expect(
      await withTenant(db, f.world.context, (tx) =>
        issueWholeBillClaimTx(tx, f.world.context, f.orderId, f.now),
      ),
    ).toBe(true);
    const row = await asTenant(f.world.tenantId, (client) =>
      client.query(
        `SELECT p.paused_at, p.remaining_ms, o.claim_token_hash FROM orders o
       LEFT JOIN loyalty_claim_pauses p ON p.tenant_id = o.tenant_id AND p.order_id = o.id
       WHERE o.tenant_id = $1 AND o.id = $2`,
        [f.world.tenantId, ulidToUuid(f.orderId)],
      ),
    );
    expect(row.rows[0].paused_at).not.toBeNull();
    expect(Number(row.rows[0].remaining_ms)).toBe(DAY_MS);
    expect(row.rows[0].claim_token_hash).toBeTruthy();
    const later = new Date(f.now.getTime() + 25 * 60 * 60 * 1000);
    const paused = await getPointClaim(
      f.world.context,
      f.credential,
      f.session,
      { userId: null },
      later,
    );
    expect(paused.status).not.toBe("expired");
    await asTenant(f.world.tenantId, (client) =>
      client.query(
        "UPDATE orders SET status = 'voided', voided_at = $3 WHERE tenant_id = $1 AND id = $2",
        [f.world.tenantId, ulidToUuid(f.orderId), later],
      ),
    );
    const voided = await getPointClaim(
      f.world.context,
      f.credential,
      f.session,
      { userId: null },
      later,
    );
    expect(voided.status).toBe("unavailable");
  });

  it("freezes a paid split at issuance without a guest request and void invalidation still applies", async () => {
    const f = await fixture();
    const splitId = randomUUID();
    const intentId = randomUUID();
    const linkId = randomUUID();
    await asTenant(f.world.tenantId, async (client) => {
      await client.query(
        `INSERT INTO bill_splits (id, tenant_id, outlet_id, table_session_id, order_id, split_set_id, method, share_index, amount_idr, status) VALUES ($1, $2, $3, $4, $5, $6, 'equal', 0, 100000, 'pending')`,
        [
          splitId,
          f.world.tenantId,
          f.world.outletB,
          f.session,
          ulidToUuid(f.orderId),
          randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by) VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, 'seed')`,
        [
          linkId,
          f.world.tenantId,
          f.world.outletB,
          createHash("sha256").update(linkId).digest("hex"),
          `P-${linkId.slice(0, 8)}`,
        ],
      );
      await client.query(
        `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, bill_split_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at) VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', 100000, $6, 'paid', $7, '{"method":"qris","qrPayload":"test","issuer":null}', $7)`,
        [
          intentId,
          f.world.tenantId,
          f.world.outletB,
          linkId,
          splitId,
          `pause-${intentId}`,
          f.now,
        ],
      );
      await client.query(
        `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at) VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 100000, $5)`,
        [f.world.tenantId, f.world.outletB, intentId, `P-${intentId}`, f.now],
      );
    });
    expect(
      await withTenant(db, f.world.context, (tx) =>
        markSplitPartPaidTx(tx, f.world.context, { intentId, now: f.now }),
      ),
    ).toBe("marked");
    const row = await asTenant(f.world.tenantId, (client) =>
      client.query(
        `SELECT s.status, p.paused_at, p.remaining_ms, s.claim_token_hash, s.claim_token_sealed
       FROM bill_splits s LEFT JOIN loyalty_claim_pauses p ON p.tenant_id = s.tenant_id AND p.split_id = s.id
       WHERE s.tenant_id = $1 AND s.id = $2`,
        [f.world.tenantId, splitId],
      ),
    );
    expect(row.rows[0]).toMatchObject({ status: "paid" });
    expect(row.rows[0].paused_at).not.toBeNull();
    expect(Number(row.rows[0].remaining_ms)).toBe(DAY_MS);
    expect(row.rows[0].claim_token_hash).toBeTruthy();
    // The migration must also freeze a paid split while its parent order is
    // still awaiting other parts, even if a pending refund may later fail.
    const migration = readFileSync(
      new URL("../../drizzle/0405_public_tarantula.sql", import.meta.url),
      "utf8",
    );
    const splitBackfill = migration
      .split("--> statement-breakpoint")
      .find(
        (part) =>
          part.includes("WITH entities AS") &&
          part.includes(
            "INSERT INTO public.loyalty_claim_pauses (tenant_id, outlet_id, split_id",
          ),
      );
    expect(splitBackfill).toBeTruthy();
    await asTenant(f.world.tenantId, async (client) => {
      await client.query(
        "DELETE FROM loyalty_claim_pauses WHERE tenant_id = $1 AND split_id = $2",
        [f.world.tenantId, splitId],
      );
      await client.query(
        "UPDATE orders SET status = 'awaiting_payment' WHERE tenant_id = $1 AND id = $2",
        [f.world.tenantId, ulidToUuid(f.orderId)],
      );
      await client.query(
        `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
        VALUES ($1, $2, $3, 10000, 'test', 'pending', 'seed')`,
        [f.world.tenantId, f.world.outletB, intentId],
      );
      await client.query(splitBackfill!);
    });
    const backfilled = await asTenant(f.world.tenantId, (client) =>
      client.query(
        "SELECT state FROM loyalty_claim_pauses WHERE tenant_id = $1 AND split_id = $2",
        [f.world.tenantId, splitId],
      ),
    );
    expect(backfilled.rows).toEqual([{ state: "ambiguous" }]);
    const token = openSecret(
      row.rows[0].claim_token_sealed,
      `bill-split-claim:${f.world.tenantId}:${splitId}`,
    );
    const later = new Date(f.now.getTime() + 25 * 60 * 60 * 1000);
    await asTenant(f.world.tenantId, (client) =>
      client.query(
        "UPDATE orders SET status = 'voided', voided_at = $3 WHERE tenant_id = $1 AND id = $2",
        [f.world.tenantId, ulidToUuid(f.orderId), later],
      ),
    );
    await withTenant(db, f.world.context, (tx) =>
      expireSplitClaimsTx(tx, f.world.context, f.orderId, later),
    );
    await expect(
      getSplitClaimByToken(f.world.context, token, later),
    ).rejects.toThrow();
    const after = await asTenant(f.world.tenantId, (client) =>
      client.query(
        "SELECT claim_redeemed_at, claim_token_hash FROM bill_splits WHERE tenant_id = $1 AND id = $2",
        [f.world.tenantId, splitId],
      ),
    );
    expect(after.rows[0].claim_redeemed_at).toBeNull();
  });
});
