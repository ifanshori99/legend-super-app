import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getSplitClaim,
  getSplitClaimByToken,
  markSplitPartPaidTx,
} from "../services/bill-split.service.ts";
import { claimSessionPoints } from "../services/table-claim.service.ts";
import {
  asTenant,
  createWorld,
  owner,
  seedMember,
  seedOrder,
  seedProgram,
} from "./member-loyalty-helpers.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
afterAll(async () => owner.end());

describe("paused split claim token belongs to the payer", () => {
  it("returns only the verified payer's paused token before close; the token works after recovery and close, with no earlier redemption", async () => {
    const world = await createWorld();
    await seedProgram(world.tenantId);
    const zone = randomUUID();
    const table = randomUUID();
    const session = randomUUID();
    const entityB = randomUUID();
    const split = randomUUID();
    const intent = randomUUID();
    const link = randomUUID();
    const credential = `guest-${randomUUID()}`;
    const payerSecret = `payer-${randomUUID()}`;
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
        "INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status, session_token_hash, session_token_sealed, opened_at, last_activity_at) VALUES ($1, $2, $3, $4, 2, 'pay_first', 'open', $5, 'sealed', $6, $6)",
        [session, world.tenantId, world.outletB, table, hash(credential), now],
      );
    });
    const order = await seedOrder(world.tenantId, {
      outletId: world.outletB,
      channel: "qr",
      profileId: null,
      status: "draft",
    });
    await asTenant(world.tenantId, async (client) => {
      await client.query(
        "UPDATE orders SET table_session_id = $3, status = 'sent', fired_at = $4 WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, ulidToUuid(order), session, now],
      );
      await client.query(
        "INSERT INTO bill_splits (id, tenant_id, outlet_id, table_session_id, order_id, split_set_id, method, share_index, amount_idr, status, payment_intent_id, payer_secret_hash) VALUES ($1, $2, $3, $4, $5, $6, 'equal', 0, 100000, 'pending', $7, $8)",
        [
          split,
          world.tenantId,
          world.outletB,
          session,
          ulidToUuid(order),
          randomUUID(),
          intent,
          hash(payerSecret),
        ],
      );
      await client.query(
        "INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by) VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, 'seed')",
        [
          link,
          world.tenantId,
          world.outletB,
          hash(link),
          `P-${link.slice(0, 8)}`,
        ],
      );
      await client.query(
        'INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, bill_split_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at) VALUES ($1, $2, $3, $4, $5, \'qris\', \'doit\', 100000, $6, \'paid\', $7, \'{"method":"qris","qrPayload":"test","issuer":null}\', $7)',
        [
          intent,
          world.tenantId,
          world.outletB,
          link,
          split,
          `pause-${intent}`,
          now,
        ],
      );
      await client.query(
        "INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at) VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 100000, $5)",
        [world.tenantId, world.outletB, intent, `P-${intent}`, now],
      );
    });
    expect(
      await withTenant(db, world.context, (tx) =>
        markSplitPartPaidTx(tx, world.context, { intentId: intent, now }),
      ),
    ).toBe("marked");
    const lookup = (secret: string) =>
      getSplitClaim(world.context, credential, session, split, secret, now);
    await expect(lookup(`payer-${randomUUID()}`)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      getSplitClaim(
        world.context,
        `guest-${randomUUID()}`,
        session,
        split,
        payerSecret,
        now,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const paused = await lookup(payerSecret);
    expect(paused.status).toBe("unavailable");
    expect(paused.claimableUntil).toBeNull();
    expect(paused.claimToken).toMatch(/^sc_/);
    const token = paused.claimToken!;
    await expect(
      getSplitClaimByToken(world.context, token, now),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const member = await seedMember(world.tenantId);
    await expect(
      claimSessionPoints(
        world.context,
        credential,
        session,
        { userId: member.userId, claimToken: token },
        now,
      ),
    ).rejects.toMatchObject({ code: "CLAIM_NOT_AVAILABLE" });
    const before = await asTenant(world.tenantId, (client) =>
      client.query(
        "SELECT claim_redeemed_at FROM bill_splits WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, split],
      ),
    );
    expect(before.rows[0].claim_redeemed_at).toBeNull();

    // Test-only reconciliation of the paused right; the production manual
    // reconciliation path is a separate work item.
    await asTenant(world.tenantId, async (client) => {
      await client.query(
        "UPDATE loyalty_claim_pauses SET state = 'active', resume_deadline = $3 WHERE tenant_id = $1 AND split_id = $2",
        [world.tenantId, split, new Date(now.getTime() + 3_600_000)],
      );
      await client.query(
        "UPDATE table_sessions SET status = 'closed', closed_at = $3, closed_reason = 'paid_and_cleaned', session_token_hash = $4 WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, session, now, hash(`rotated-${randomUUID()}`)],
      );
    });
    const recovered = await getSplitClaimByToken(world.context, token, now);
    expect(recovered.status).toBe("available");
    expect(recovered.claimToken).toBe(token);
  });
});
