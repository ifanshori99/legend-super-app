import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createOutletInputSchema,
  updateOutletInputSchema,
} from "@starter/shared/platform";
import { ulidToUuid } from "@starter/shared/core";
import { createOutlet, updateOutlet } from "../services/org.service.ts";
import { fulfilRedemption } from "../services/reward-redemption.service.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  NOW,
  asTenant,
  balanceOf,
  createWorld,
  deliver,
  orderPaidEvent,
  owner,
  seedMember,
  seedOrder,
  seedProgram,
} from "./member-loyalty-helpers.ts";
import {
  grantPoints,
  key,
  redeemAs,
  redemptionRow,
  scopeOf,
  seedReward,
} from "./member-rewards-helpers.ts";

afterAll(async () => owner.end());

async function worldWithEntityB() {
  const world = await createWorld();
  await seedProgram(world.tenantId);
  const entityB = randomUUID();
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity B', false)",
      [entityB, world.tenantId],
    );
    await client.query(
      "UPDATE outlets SET opening_hours = $2::jsonb WHERE tenant_id = $1",
      [
        world.tenantId,
        JSON.stringify({
          mon: null,
          tue: null,
          wed: null,
          thu: null,
          fri: null,
          sat: null,
          sun: null,
        }),
      ],
    );
  });
  return { world, entityB };
}

async function entityOf(tenantId: string, outletId: string) {
  const result = await asTenant(tenantId, (client) =>
    client.query<{ legal_entity_id: string }>(
      "SELECT legal_entity_id FROM outlets WHERE tenant_id = $1 AND id = $2",
      [tenantId, outletId],
    ),
  );
  return result.rows[0]!.legal_entity_id;
}

describe("outlet changes preserve the effective loyalty entity", () => {
  it("waits for an in-flight AI tenant share lock before moving an outlet", async () => {
    const { world, entityB } = await worldWithEntityB();
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      const holderPid = (
        await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      await holder.query("SELECT id FROM tenants WHERE id = $1 FOR SHARE", [
        world.tenantId,
      ]);
      const pending = updateOutlet(
        world.context,
        world.outletB,
        updateOutletInputSchema.parse({ legalEntityId: entityB }),
        randomUUID(),
      ).then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (!settled && !blocked && Date.now() < deadline) {
        const observed = await owner.query<{ blocked: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked",
          [holderPid],
        );
        blocked = observed.rows[0]!.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await holder.query("COMMIT");
      const outcome = await pending;
      expect(blocked, "outlet change should wait for the AI lock").toBe(true);
      expect(outcome.error).toBeNull();
      expect(outcome.result?.legalEntityId).toBe(entityB);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("returns a retryable conflict if the tenant share lock stays held", async () => {
    const { world, entityB } = await worldWithEntityB();
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM tenants WHERE id = $1 FOR SHARE", [
        world.tenantId,
      ]);
      await expect(
        updateOutlet(
          world.context,
          world.outletB,
          updateOutletInputSchema.parse({ legalEntityId: entityB }),
          randomUUID(),
        ),
      ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_BUSY" });
      expect(await entityOf(world.tenantId, world.outletB)).not.toBe(entityB);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("refuses moving an outlet where a physical reward was fulfilled even when A remains the program entity", async () => {
    const { world, entityB } = await worldWithEntityB();
    const entityA = await entityOf(world.tenantId, world.outletA);
    await asTenant(world.tenantId, (client) =>
      client.query(
        "UPDATE loyalty_programs SET legal_entity_id = $2 WHERE tenant_id = $1",
        [world.tenantId, entityA],
      ),
    );
    const member = await seedMember(world.tenantId);
    await grantPoints(world.tenantId, member.id, 100);
    const reward = await seedReward(world.tenantId, {
      pointsCost: 50,
      stock: 1,
    });
    const redemption = await redeemAs(
      scopeOf(world.tenantId, member),
      reward,
      key(),
    );
    const fulfilled = await withTenant(db, world.context, (tx) =>
      fulfilRedemption(
        tx,
        world.context,
        randomUUID(),
        {
          redemptionCode: redemption.redemptionCode,
          outletId: world.outletB,
        },
        NOW,
      ),
    );
    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.fulfilledOutletId).toBe(world.outletB);
    await expect(
      updateOutlet(
        world.context,
        world.outletB,
        updateOutletInputSchema.parse({ legalEntityId: entityB }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    expect(await entityOf(world.tenantId, world.outletB)).toBe(entityA);
    expect((await redemptionRow(world.tenantId, redemption.id)).status).toBe(
      "fulfilled",
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(50);
  });

  it("refuses moving an outlet with a member earn even if the explicit program entity stays A", async () => {
    const { world, entityB } = await worldWithEntityB();
    const entityA = await entityOf(world.tenantId, world.outletA);
    await asTenant(world.tenantId, (client) =>
      client.query(
        "UPDATE loyalty_programs SET legal_entity_id = $2 WHERE tenant_id = $1",
        [world.tenantId, entityA],
      ),
    );
    const member = await seedMember(world.tenantId);
    const orderId = await seedOrder(world.tenantId, {
      outletId: world.outletB,
      profileId: member.id,
    });
    await deliver(
      world,
      orderPaidEvent(world, { orderUlid: orderId, outletId: world.outletB }),
    );
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
    await expect(
      updateOutlet(
        world.context,
        world.outletB,
        updateOutletInputSchema.parse({ legalEntityId: entityB }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    expect(await entityOf(world.tenantId, world.outletB)).toBe(entityA);
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
  });

  it("refuses moving an outlet whose member paid event is pending while another outlet still anchors A", async () => {
    const { world, entityB } = await worldWithEntityB();
    const entityA = await entityOf(world.tenantId, world.outletA);
    const member = await seedMember(world.tenantId);
    const orderId = await seedOrder(world.tenantId, {
      outletId: world.outletB,
      profileId: member.id,
    });
    const event = orderPaidEvent(world, {
      orderUlid: orderId,
      outletId: world.outletB,
    });
    await asTenant(world.tenantId, async (client) => {
      await client.query(
        "UPDATE loyalty_programs SET legal_entity_id = $2 WHERE tenant_id = $1",
        [world.tenantId, entityA],
      );
      await client.query(
        `INSERT INTO domain_event_outbox (id, tenant_id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status)
         VALUES ($1, $2, $3, $4, 'order', $5, 1, $6::jsonb, 'cloud-sync', 'pending')`,
        [
          randomUUID(),
          world.tenantId,
          world.outletB,
          randomUUID(),
          ulidToUuid(orderId),
          JSON.stringify(event),
        ],
      );
    });
    await expect(
      updateOutlet(
        world.context,
        world.outletB,
        updateOutletInputSchema.parse({ legalEntityId: entityB }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    expect(await entityOf(world.tenantId, world.outletB)).toBe(entityA);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
  });

  it("refuses adding a second entity after points exist and makes no new outlet", async () => {
    const { world, entityB } = await worldWithEntityB();
    const member = await seedMember(world.tenantId);
    await grantPoints(world.tenantId, member.id, 10);
    const input = createOutletInputSchema.parse({
      brandId: world.brandId,
      legalEntityId: entityB,
      code: "TEST-B",
      name: "Outlet B",
      address: "Jl. B",
      openingHours: {
        mon: null,
        tue: null,
        wed: null,
        thu: null,
        fri: null,
        sat: null,
        sun: null,
      },
    });
    await expect(createOutlet(world.context, input)).rejects.toMatchObject({
      status: 409,
      code: "LOYALTY_ENTITY_LOCKED",
    });
    const rows = await asTenant(world.tenantId, (client) =>
      client.query(
        "SELECT id FROM outlets WHERE tenant_id = $1 AND code = 'TEST-B'",
        [world.tenantId],
      ),
    );
    expect(rows.rows).toHaveLength(0);
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
  });

  it("refuses to make the fallback ambiguous after points exist and preserves the balance", async () => {
    const { world, entityB } = await worldWithEntityB();
    const member = await seedMember(world.tenantId);
    await grantPoints(world.tenantId, member.id, 10);
    const original = await entityOf(world.tenantId, world.outletB);
    await expect(
      updateOutlet(
        world.context,
        world.outletB,
        updateOutletInputSchema.parse({ legalEntityId: entityB }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    expect(await entityOf(world.tenantId, world.outletB)).toBe(original);
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
  });

  it("refuses a fallback change while a member paid event is waiting, with no extra points or consumption", async () => {
    const { world, entityB } = await worldWithEntityB();
    const member = await seedMember(world.tenantId);
    const orderId = await seedOrder(world.tenantId, {
      outletId: world.outletA,
      profileId: member.id,
    });
    const event = orderPaidEvent(world, {
      orderUlid: orderId,
      outletId: world.outletA,
    });
    const outboxId = randomUUID();
    await asTenant(world.tenantId, (client) =>
      client.query(
        `INSERT INTO domain_event_outbox (id, tenant_id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status)
       VALUES ($1, $2, $3, $4, 'order', $5, 1, $6::jsonb, 'cloud-sync', 'pending')`,
        [
          outboxId,
          world.tenantId,
          world.outletA,
          randomUUID(),
          ulidToUuid(orderId),
          JSON.stringify(event),
        ],
      ),
    );
    const original = await entityOf(world.tenantId, world.outletB);
    await expect(
      updateOutlet(
        world.context,
        world.outletB,
        updateOutletInputSchema.parse({ legalEntityId: entityB }),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
    expect(await entityOf(world.tenantId, world.outletB)).toBe(original);
    expect(await balanceOf(world.tenantId, member.id)).toBe(0);
    const pending = await asTenant(world.tenantId, (client) =>
      client.query(
        "SELECT status FROM domain_event_outbox WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, outboxId],
      ),
    );
    expect(pending.rows).toEqual([{ status: "pending" }]);
  });

  it("allows an unrelated outlet move when the explicit program entity remains A", async () => {
    const { world, entityB } = await worldWithEntityB();
    const entityA = await entityOf(world.tenantId, world.outletA);
    await asTenant(world.tenantId, (client) =>
      client.query(
        "UPDATE loyalty_programs SET legal_entity_id = $2 WHERE tenant_id = $1",
        [world.tenantId, entityA],
      ),
    );
    const member = await seedMember(world.tenantId);
    await grantPoints(world.tenantId, member.id, 10);
    const result = await updateOutlet(
      world.context,
      world.outletB,
      updateOutletInputSchema.parse({ legalEntityId: entityB }),
      randomUUID(),
    );
    expect(result.legalEntityId).toBe(entityB);
    expect(await balanceOf(world.tenantId, member.id)).toBe(10);
  });

  it("permits an entity change before any loyalty rights or paid events exist", async () => {
    const { world, entityB } = await worldWithEntityB();
    const result = await updateOutlet(
      world.context,
      world.outletB,
      updateOutletInputSchema.parse({ legalEntityId: entityB }),
      randomUUID(),
    );
    expect(result.legalEntityId).toBe(entityB);
  });
});
