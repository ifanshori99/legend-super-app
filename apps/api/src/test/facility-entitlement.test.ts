// legend-fjk5 (WS-09, F25): facility entitlement ledger service against
// PostgreSQL with the restricted app role (RLS enforced). Criteria: FAC-04
// (issue only after the condition is met and the source is paid; cancel when
// the source is refunded; expiry), FAC-05 (atomic redemption, one ticket one
// redemption), TEN-01..03 (tenant and outlet isolation).
//
// Assumptions (the brief leaves them open):
// - An exhausted or expired grant is not listed by `getCurrentEntitlements`.
// - Cross-outlet / cross-tenant access answers either with an error or with an
//   empty result; both count as "sees nothing" for reads. Writes must be
//   rejected or find nothing, and never touch the other scope's rows.
// - F6: the tier benefit `sourceRef` must be a valid UUID version 5 (variant
//   8-b) so a ledger row passes `entitlementLedgerEntrySchema` (`z.uuid()`).
// - `linkTicket` is not covered here: it needs a seeded access ticket and the
//   booking flow, which belong to the ticket card.
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { entitlementLedgerEntrySchema } from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { issueTierBenefit } from "../services/facility-entitlement.service.ts";
import {
  asTenant,
  createWorld,
  owner,
  rejection,
} from "./member-loyalty-helpers.ts";
import {
  entitlementsOf,
  inHours,
  ledgerRows,
  outletContext,
  rejectionCode,
  seedFacility,
} from "./facility-entitlement-helpers.ts";

afterAll(async () => {
  await owner.end();
});

/** A world with one facility at outlet A and one customer. */
async function setup() {
  const world = await createWorld();
  const facilityId = await seedFacility(world);
  const customerProfileId = randomUUID();
  return {
    world,
    facilityId,
    customerProfileId,
    svc: entitlementsOf(world),
    key: { facilityId, customerProfileId },
  };
}

describe("FAC-04 issue only after the condition is met and the source is paid", () => {
  it.each(["purchase", "package", "min_spend", "subscription"] as const)(
    "FAC-04 %s unpaid is rejected and writes nothing",
    async (source) => {
      const { world, svc, key } = await setup();
      const result = await svc.issue({
        ...key,
        source,
        paid: false,
        conditionsMet: true,
      });
      expect(result).toEqual({ status: "rejected", reason: "unpaid" });
      expect(await ledgerRows(world.tenantId)).toHaveLength(0);
    },
  );

  it("FAC-04 a paid source whose condition is not met is rejected", async () => {
    const { world, svc, key } = await setup();
    const result = await svc.issue({
      ...key,
      source: "min_spend",
      paid: true,
      conditionsMet: false,
    });
    expect(result).toEqual({
      status: "rejected",
      reason: "conditions_not_met",
    });
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-04 unpaid is reported before an unmet condition", async () => {
    const { svc, key } = await setup();
    const result = await svc.issue({
      ...key,
      source: "package",
      paid: false,
      conditionsMet: false,
    });
    expect(result).toEqual({ status: "rejected", reason: "unpaid" });
  });

  it("FAC-04 tier benefit and staff issue need no payment", async () => {
    const { world, svc, key } = await setup();
    const tier = await svc.issue({
      ...key,
      source: "tier_benefit",
      paid: false,
      conditionsMet: true,
    });
    const staff = await svc.issue({
      ...key,
      source: "staff_issue",
      paid: false,
      conditionsMet: true,
      reason: "Kompensasi keluhan",
      actorUserId: randomUUID(),
    });
    expect(tier.status).toBe("issued");
    expect(staff.status).toBe("issued");
    expect(await ledgerRows(world.tenantId)).toHaveLength(2);
  });

  it("FAC-04 a tier benefit whose condition is not met is rejected", async () => {
    const { svc, key } = await setup();
    const result = await svc.issue({
      ...key,
      source: "tier_benefit",
      paid: false,
      conditionsMet: false,
    });
    expect(result).toEqual({
      status: "rejected",
      reason: "conditions_not_met",
    });
  });

  it("FAC-04 a paid, qualified source writes one grant row and raises the balance", async () => {
    const { world, svc, key, facilityId, customerProfileId } = await setup();
    const expiresAt = inHours(6);
    const result = await svc.issue({
      ...key,
      source: "package",
      sourceRef: "ORDER-1",
      sessions: 3,
      expiresAt,
    });
    if (result.status !== "issued") throw new Error("expected issued");
    expect(result.entry).toMatchObject({
      type: "grant",
      sessions: 3,
      sourceType: "package",
      sourceRef: "ORDER-1",
      facilityId,
      customerProfileId,
      grantEntryId: null,
      accessTicketId: null,
    });
    expect(result.entry.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    const rows = await ledgerRows(world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.entry.id,
      outlet_id: world.outletA,
    });

    const current = await svc.current(key);
    expect(current.balance).toMatchObject({
      availableSessions: 3,
      grantedSessions: 3,
      redeemedSessions: 0,
    });
    expect(current.grants.map((grant) => grant.id)).toEqual([result.entry.id]);
    expect(current.grants[0]).toMatchObject({
      source: "package",
      expiresAt: expiresAt.toISOString(),
    });
  });

  it("FAC-04 issuing the same source twice is a duplicate and writes one grant", async () => {
    const { world, svc, key } = await setup();
    const first = await svc.issue({
      ...key,
      sourceRef: "ORDER-2",
      sessions: 2,
    });
    const second = await svc.issue({
      ...key,
      sourceRef: "ORDER-2",
      sessions: 2,
    });
    expect(first.status).toBe("issued");
    expect(second.status).toBe("duplicate");
    if (first.status === "rejected" || second.status === "rejected")
      throw new Error("unexpected rejection");
    expect(second.entry.id).toBe(first.entry.id);
    expect(await ledgerRows(world.tenantId)).toHaveLength(1);
  });

  it("FAC-04 parallel issues of the same source write exactly one grant", async () => {
    const { world, svc, key } = await setup();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        svc.issue({ ...key, sourceRef: "ORDER-3" }),
      ),
    );
    expect(results.filter((r) => r.status === "issued")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(3);
    expect(await ledgerRows(world.tenantId)).toHaveLength(1);
  });

  it("FAC-04 another source reference or customer issues its own grant", async () => {
    const { world, svc, key, facilityId } = await setup();
    const base = { ...key, source: "package" as const, sourceRef: "ORDER-4" };
    const results = await Promise.all([
      svc.issue(base),
      svc.issue({ ...base, sourceRef: "ORDER-5" }),
      svc.issue({ ...base, customerProfileId: randomUUID() }),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "issued",
      "issued",
      "issued",
    ]);
    expect(await ledgerRows(world.tenantId, { facilityId })).toHaveLength(3);
  });
});

describe("FAC-04 cancel when the source is refunded", () => {
  it("FAC-04 cancels the unredeemed rest and keeps the redeemed sessions", async () => {
    const { world, svc, key } = await setup();
    const issued = await svc.issue({
      ...key,
      sourceRef: "ORDER-C1",
      sessions: 3,
    });
    if (issued.status !== "issued") throw new Error("expected issued");
    await svc.redeem(key);

    const result = await svc.cancel({ sourceRef: "ORDER-C1" });
    expect(result.cancelledSessions).toBe(2);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      type: "cancel",
      sessions: 2,
      grantEntryId: issued.entry.id,
    });

    const { balance } = await svc.current(key);
    expect(balance).toMatchObject({
      availableSessions: 0,
      redeemedSessions: 1,
      cancelledSessions: 2,
    });
    expect(await ledgerRows(world.tenantId)).toHaveLength(3);
  });

  it("FAC-04 replaying the cancel is idempotent and writes nothing", async () => {
    const { world, svc, key } = await setup();
    await svc.issue({ ...key, sourceRef: "ORDER-C2", sessions: 2 });
    const first = await svc.cancel({ sourceRef: "ORDER-C2" });
    const replay = await svc.cancel({ sourceRef: "ORDER-C2" });
    expect(first.cancelledSessions).toBe(2);
    expect(replay).toEqual({ cancelledSessions: 0, entries: [] });
    expect(await ledgerRows(world.tenantId)).toHaveLength(2);
  });

  it("FAC-04 a fully redeemed grant has nothing to cancel", async () => {
    const { world, svc, key } = await setup();
    await svc.issue({ ...key, sourceRef: "ORDER-C3", sessions: 1 });
    await svc.redeem(key);
    const result = await svc.cancel({ sourceRef: "ORDER-C3" });
    expect(result).toEqual({ cancelledSessions: 0, entries: [] });
    expect(await ledgerRows(world.tenantId)).toHaveLength(2);
  });

  it("FAC-04 an unknown source reference cancels nothing", async () => {
    const { world, svc } = await setup();
    expect(await svc.cancel({ sourceRef: "NOPE" })).toEqual({
      cancelledSessions: 0,
      entries: [],
    });
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-04 sourceTypes limits which grants are cancelled", async () => {
    const { svc, key } = await setup();
    await svc.issue({
      ...key,
      source: "staff_issue",
      sourceRef: "REF-X",
      paid: false,
    });
    const skipped = await svc.cancel({
      sourceRef: "REF-X",
      sourceTypes: ["package", "min_spend"],
    });
    expect(skipped.cancelledSessions).toBe(0);
    const cancelled = await svc.cancel({
      sourceRef: "REF-X",
      sourceTypes: ["staff_issue"],
    });
    expect(cancelled.cancelledSessions).toBe(1);
  });

  it("FAC-04 a cancelled grant can no longer be redeemed", async () => {
    const { svc, key } = await setup();
    await svc.issue({ ...key, sourceRef: "ORDER-C4", sessions: 2 });
    await svc.cancel({ sourceRef: "ORDER-C4" });
    expect(await rejectionCode(svc.redeem(key))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-04 cancelling one customer's source leaves another customer's grants alone", async () => {
    const { svc, key, facilityId } = await setup();
    const other = { facilityId, customerProfileId: randomUUID() };
    await svc.issue({ ...key, sourceRef: "ORDER-C5" });
    await svc.issue({ ...other, sourceRef: "ORDER-C6" });
    await svc.cancel({ sourceRef: "ORDER-C5" });
    expect((await svc.current(other)).balance.availableSessions).toBe(1);
  });
});

describe("FAC-05 atomic redemption", () => {
  it("FAC-05 redeeming consumes one session and ties the row to the ticket", async () => {
    const { world, svc, key } = await setup();
    const issued = await svc.issue({ ...key, sessions: 2 });
    if (issued.status !== "issued") throw new Error("expected issued");
    const ticket = createUlid();
    const result = await svc.redeem({ ...key, accessTicketId: ticket });
    expect(result.grantEntryId).toBe(issued.entry.id);
    expect(result.entry).toMatchObject({
      type: "redeem",
      sessions: 1,
      grantEntryId: issued.entry.id,
      accessTicketId: ticket,
      sourceType: "purchase",
    });
    const rows = await ledgerRows(world.tenantId);
    expect(rows.filter((r) => r.type === "redeem")).toHaveLength(1);
    expect(rows.find((r) => r.type === "redeem")?.access_ticket_id).toBe(
      ulidToUuid(ticket),
    );
    expect((await svc.current(key)).balance).toMatchObject({
      availableSessions: 1,
      redeemedSessions: 1,
    });
  });

  it("FAC-05 without any grant the redemption fails with ENTITLEMENT_INSUFFICIENT", async () => {
    const { world, svc, key } = await setup();
    expect(await rejectionCode(svc.redeem(key))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
    expect(await ledgerRows(world.tenantId)).toHaveLength(0);
  });

  it("FAC-05 when the grant is used up the next redemption fails", async () => {
    const { world, svc, key } = await setup();
    await svc.issue({ ...key, sessions: 1 });
    await svc.redeem(key);
    expect(await rejectionCode(svc.redeem(key))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
    expect(
      (await ledgerRows(world.tenantId)).filter((r) => r.type === "redeem"),
    ).toHaveLength(1);
  });

  it("FAC-05 five parallel redemptions of 2 sessions: exactly 2 succeed", async () => {
    const { world, svc, key } = await setup();
    await svc.issue({ ...key, sessions: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => svc.redeem(key)),
    );
    const failed = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(failed).toHaveLength(3);
    for (const result of failed)
      expect((result as PromiseRejectedResult).reason.code).toBe(
        "ENTITLEMENT_INSUFFICIENT",
      );
    const redeems = (await ledgerRows(world.tenantId)).filter(
      (r) => r.type === "redeem",
    );
    expect(redeems).toHaveLength(2);
    expect((await svc.current(key)).balance.availableSessions).toBe(0);
  });

  it("FAC-05 parallel redemptions across two grants of 1 session each: exactly 2 succeed, one per grant", async () => {
    const { world, svc, key } = await setup();
    await svc.issue({ ...key, sourceRef: "ORDER-P1" });
    await svc.issue({ ...key, sourceRef: "ORDER-P2" });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => svc.redeem(key)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const redeems = (await ledgerRows(world.tenantId)).filter(
      (r) => r.type === "redeem",
    );
    expect(new Set(redeems.map((r) => r.grant_entry_id)).size).toBe(2);
  });

  it("FAC-05 the same ticket cannot redeem twice (ENTITLEMENT_ALREADY_REDEEMED)", async () => {
    const { world, svc, key } = await setup();
    await svc.issue({ ...key, sessions: 3 });
    const ticket = createUlid();
    await svc.redeem({ ...key, accessTicketId: ticket });
    expect(
      await rejectionCode(svc.redeem({ ...key, accessTicketId: ticket })),
    ).toBe("ENTITLEMENT_ALREADY_REDEEMED");
    expect(
      (await ledgerRows(world.tenantId)).filter((r) => r.type === "redeem"),
    ).toHaveLength(1);
    expect((await svc.current(key)).balance.availableSessions).toBe(2);
  });

  it("FAC-05 two parallel redemptions with the same ticket: one wins, one is ALREADY_REDEEMED", async () => {
    const { world, svc, key } = await setup();
    await svc.issue({ ...key, sessions: 3 });
    const ticket = createUlid();
    const results = await Promise.allSettled([
      svc.redeem({ ...key, accessTicketId: ticket }),
      svc.redeem({ ...key, accessTicketId: ticket }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as
      PromiseRejectedResult | undefined;
    expect(rejected?.reason.code).toBe("ENTITLEMENT_ALREADY_REDEEMED");
    expect(
      (await ledgerRows(world.tenantId)).filter((r) => r.type === "redeem"),
    ).toHaveLength(1);
  });

  it("FAC-05 the database refuses a redeem row beyond the grant even when written directly", async () => {
    const { world, svc, key, facilityId, customerProfileId } = await setup();
    const issued = await svc.issue({ ...key, sessions: 1 });
    if (issued.status !== "issued") throw new Error("expected issued");
    await svc.redeem(key);
    await rejection(
      asTenant(world.tenantId, (client) =>
        client.query(
          `INSERT INTO entitlement_ledger
             (tenant_id, outlet_id, facility_id, customer_profile_id, type, sessions, source_type,
              source_ref, grant_entry_id, access_ticket_id)
           VALUES ($1, $2, $3, $4, 'redeem', 1, 'purchase', 'direct', $5, $6)`,
          [
            world.tenantId,
            world.outletA,
            facilityId,
            customerProfileId,
            issued.entry.id,
            ulidToUuid(createUlid()),
          ],
        ),
      ),
    );
    expect(
      (await ledgerRows(world.tenantId)).filter((r) => r.type === "redeem"),
    ).toHaveLength(1);
  });

  it("FAC-05 the ledger is append-only for the application role", async () => {
    const { world, svc, key } = await setup();
    await svc.issue({ ...key, sessions: 1 });
    await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(sql`UPDATE entitlement_ledger SET sessions = 99`),
      ),
    );
    await rejection(
      withTenant(db, world.context, (tx) =>
        tx.execute(sql`DELETE FROM entitlement_ledger`),
      ),
    );
    const rows = await ledgerRows(world.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessions).toBe(1);
  });
});

describe("FAC-04 expired grants", () => {
  it("FAC-04 a grant past its expiry cannot be redeemed even before the sweep runs", async () => {
    const { world, svc, key } = await setup();
    await svc.issue({ ...key, sessions: 2, expiresAt: inHours(1) });
    expect(await rejectionCode(svc.redeem({ ...key, at: inHours(2) }))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
    expect(
      (await ledgerRows(world.tenantId)).filter((r) => r.type === "redeem"),
    ).toHaveLength(0);
  });

  it("FAC-04 a grant is expired at the instant of its expiry", async () => {
    const { svc, key } = await setup();
    await svc.issue({ ...key, expiresAt: inHours(1) });
    expect(await rejectionCode(svc.redeem({ ...key, at: inHours(1) }))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-04 before its expiry the same grant redeems", async () => {
    const { svc, key } = await setup();
    await svc.issue({ ...key, expiresAt: inHours(1) });
    const result = await svc.redeem({ ...key, at: inHours(0.5) });
    expect(result.entry.type).toBe("redeem");
  });

  it("FAC-04 redemption skips an expired grant and draws the valid one", async () => {
    const { svc, key } = await setup();
    const expired = await svc.issue({
      ...key,
      sourceRef: "OLD",
      expiresAt: inHours(1),
    });
    const valid = await svc.issue({
      ...key,
      sourceRef: "NEW",
      expiresAt: inHours(10),
    });
    if (expired.status !== "issued" || valid.status !== "issued")
      throw new Error("expected issued");
    const result = await svc.redeem({ ...key, at: inHours(2) });
    expect(result.grantEntryId).toBe(valid.entry.id);
  });

  it("FAC-04 a grant that never expires is redeemable later", async () => {
    const { svc, key } = await setup();
    await svc.issue({
      ...key,
      source: "staff_issue",
      paid: false,
      expiresAt: null,
    });
    const result = await svc.redeem({ ...key, at: inHours(24 * 365) });
    expect(result.entry.type).toBe("redeem");
  });

  it("FAC-04 the sweep expires the unused rest of a due grant exactly once", async () => {
    const { world, svc, key } = await setup();
    const issued = await svc.issue({
      ...key,
      sessions: 3,
      expiresAt: inHours(1),
    });
    if (issued.status !== "issued") throw new Error("expected issued");
    await svc.redeem(key);

    const sweep = await svc.expire(inHours(2));
    expect(sweep.expiredSessions).toBe(2);
    expect(sweep.entries).toHaveLength(1);
    expect(sweep.entries[0]).toMatchObject({
      type: "expire",
      sessions: 2,
      grantEntryId: issued.entry.id,
    });
    expect(
      (await svc.current({ ...key, at: inHours(2) })).balance,
    ).toMatchObject({
      availableSessions: 0,
      redeemedSessions: 1,
      expiredSessions: 2,
    });

    const replay = await svc.expire(inHours(3));
    expect(replay).toEqual({ expiredSessions: 0, entries: [] });
    expect(await ledgerRows(world.tenantId)).toHaveLength(3);
  });

  it("FAC-04 the sweep leaves grants that are not due, never expire or are used up", async () => {
    const { world, svc, key } = await setup();
    await svc.issue({ ...key, sourceRef: "LATER", expiresAt: inHours(10) });
    await svc.issue({
      ...key,
      source: "staff_issue",
      paid: false,
      sourceRef: "FOREVER",
      expiresAt: null,
    });
    await svc.issue({ ...key, sourceRef: "USED", expiresAt: inHours(1) });
    // Draw the due grant first (soonest expiry), so it is used up before it lapses.
    await svc.redeem(key);
    const before = await ledgerRows(world.tenantId);
    const sweep = await svc.expire(inHours(2));
    expect(sweep).toEqual({ expiredSessions: 0, entries: [] });
    expect(await ledgerRows(world.tenantId)).toHaveLength(before.length);
  });

  it("FAC-04 an expired grant is not listed as redeemable", async () => {
    const { svc, key } = await setup();
    const live = await svc.issue({
      ...key,
      sourceRef: "LIVE",
      expiresAt: inHours(10),
    });
    await svc.issue({ ...key, sourceRef: "DEAD", expiresAt: inHours(1) });
    if (live.status !== "issued") throw new Error("expected issued");
    const current = await svc.current({ ...key, at: inHours(2) });
    expect(current.grants.map((grant) => grant.id)).toEqual([live.entry.id]);
  });

  it("FAC-04 grants are listed soonest expiry first", async () => {
    const { svc, key } = await setup();
    const late = await svc.issue({
      ...key,
      sourceRef: "LATE",
      expiresAt: inHours(10),
    });
    const soon = await svc.issue({
      ...key,
      sourceRef: "SOON",
      expiresAt: inHours(2),
    });
    if (late.status !== "issued" || soon.status !== "issued")
      throw new Error("expected issued");
    const current = await svc.current(key);
    expect(current.grants.map((grant) => grant.id)).toEqual([
      soon.entry.id,
      late.entry.id,
    ]);
    expect(current.balance.nextExpiresAt).toBe(inHours(2).toISOString());
  });

  it("FAC-04 a used-up grant is not listed and an empty customer has an empty balance", async () => {
    const { svc, key } = await setup();
    await svc.issue({ ...key, sessions: 1 });
    await svc.redeem(key);
    const current = await svc.current(key);
    expect(current.grants).toEqual([]);
    expect(current.balance.availableSessions).toBe(0);

    const nobody = await svc.current({
      facilityId: key.facilityId,
      customerProfileId: randomUUID(),
    });
    expect(nobody.grants).toEqual([]);
    expect(nobody.balance).toMatchObject({
      availableSessions: 0,
      grantedSessions: 0,
      nextExpiresAt: null,
    });
  });
});

describe("TEN-01..03 isolation", () => {
  it("TEN-01 another tenant sees no balance and cannot redeem, cancel or expire", async () => {
    const a = await setup();
    const b = await createWorld();
    const svcB = entitlementsOf(b);
    const issued = await a.svc.issue({
      ...a.key,
      sourceRef: "ORDER-T1",
      sessions: 2,
    });
    if (issued.status !== "issued") throw new Error("expected issued");

    // Reads through tenant B see nothing (empty or rejected, never A's data).
    let read: Awaited<ReturnType<typeof svcB.current>> | null = null;
    try {
      read = await svcB.current(a.key);
    } catch {
      read = null;
    }
    if (read) {
      expect(read.grants).toEqual([]);
      expect(read.balance.availableSessions).toBe(0);
    }

    // Tenant B has no grant for this facility: the redemption fails.
    expect(await rejectionCode(svcB.redeem(a.key))).toBeTruthy();
    expect(await svcB.cancel({ sourceRef: "ORDER-T1" })).toEqual({
      cancelledSessions: 0,
      entries: [],
    });
    expect(await svcB.expire(inHours(48))).toEqual({
      expiredSessions: 0,
      entries: [],
    });

    const rows = await ledgerRows(a.world.tenantId);
    expect(rows).toHaveLength(1);
    expect((await a.svc.current(a.key)).balance.availableSessions).toBe(2);
  });

  it("TEN-01 tenant B cannot write a ledger row for tenant A's facility", async () => {
    const a = await setup();
    const b = await createWorld();
    await rejection(entitlementsOf(b).issue(a.key));
    expect(await ledgerRows(a.world.tenantId)).toHaveLength(0);
    expect(await ledgerRows(b.tenantId)).toHaveLength(0);
  });

  it("TEN-01 raw reads of the ledger as another tenant return no rows", async () => {
    const a = await setup();
    const b = await createWorld();
    await a.svc.issue(a.key);
    const own = await withTenant(db, a.world.context, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM entitlement_ledger`),
    );
    const foreign = await withTenant(db, b.context, (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM entitlement_ledger WHERE tenant_id = ${a.world.tenantId}`,
      ),
    );
    expect(Number(own.rows[0]!.n)).toBe(1);
    expect(Number(foreign.rows[0]!.n)).toBe(0);
  });

  it("TEN-02 an outlet-scoped caller works in its own outlet", async () => {
    const a = await setup();
    const scopeA = outletContext(a.world.tenantId, a.world.outletA);
    const issued = await a.svc.issue(a.key, scopeA);
    expect(issued.status).toBe("issued");
    expect((await a.svc.redeem(a.key, scopeA)).entry.type).toBe("redeem");
  });

  it("TEN-02 an outlet-scoped caller of another outlet sees and changes nothing", async () => {
    const a = await setup();
    const scopeA = outletContext(a.world.tenantId, a.world.outletA);
    const scopeB = outletContext(a.world.tenantId, a.world.outletB);
    const issued = await a.svc.issue({
      ...a.key,
      sourceRef: "ORDER-O1",
      sessions: 2,
    });
    if (issued.status !== "issued") throw new Error("expected issued");

    let read: Awaited<ReturnType<typeof a.svc.current>> | null = null;
    try {
      read = await a.svc.current(a.key, scopeB);
    } catch {
      read = null;
    }
    if (read) {
      expect(read.grants).toEqual([]);
      expect(read.balance.availableSessions).toBe(0);
    }

    // Raw rows of outlet A are invisible to the outlet B scope.
    const seen = await withTenant(db, scopeB, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM entitlement_ledger`),
    );
    expect(Number(seen.rows[0]!.n)).toBe(0);

    await rejection(a.svc.redeem(a.key, scopeB));
    expect(await a.svc.cancel({ sourceRef: "ORDER-O1" }, scopeB)).toEqual({
      cancelledSessions: 0,
      entries: [],
    });
    expect(await a.svc.expire(inHours(48), scopeB)).toEqual({
      expiredSessions: 0,
      entries: [],
    });
    expect((await a.svc.current(a.key, scopeA)).balance.availableSessions).toBe(
      2,
    );
    expect(await ledgerRows(a.world.tenantId)).toHaveLength(1);
  });

  it("TEN-02 an outlet-scoped caller cannot issue for a facility of another outlet", async () => {
    const a = await setup();
    const scopeB = outletContext(a.world.tenantId, a.world.outletB);
    await rejection(a.svc.issue(a.key, scopeB));
    expect(await ledgerRows(a.world.tenantId)).toHaveLength(0);
  });

  it("TEN-03 each outlet's facility keeps its own balance for the same customer", async () => {
    const a = await setup();
    const facilityB = await seedFacility(a.world, a.world.outletB);
    await a.svc.issue(a.key);
    const keyB = {
      facilityId: facilityB,
      customerProfileId: a.customerProfileId,
    };
    expect((await a.svc.current(keyB)).balance.availableSessions).toBe(0);
    expect(await rejectionCode(a.svc.redeem(keyB))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
    expect((await a.svc.current(a.key)).balance.availableSessions).toBe(1);
    const row = (await ledgerRows(a.world.tenantId))[0]!;
    expect(row.outlet_id).toBe(a.world.outletA);
  });
});

describe("F6 tier benefit sourceRef is a valid UUID", () => {
  const UUID_V5 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  async function tierSetup() {
    const ctx = await setup();
    const ruleId = randomUUID();
    await asTenant(ctx.world.tenantId, (client) =>
      client.query(
        `INSERT INTO entitlement_rules (id, tenant_id, outlet_id, facility_id, type, condition, sessions, validity, is_enabled)
         VALUES ($1, $2, $3, $4, 'tier_benefit', $5, 2, $6, true)`,
        [
          ruleId,
          ctx.world.tenantId,
          ctx.world.outletA,
          ctx.facilityId,
          JSON.stringify({ tierKeys: ["gold"] }),
          JSON.stringify({ kind: "billing_period" }),
        ],
      ),
    );
    const issue = (period: string, customerProfileId = ctx.customerProfileId) =>
      withTenant(db, ctx.world.context, (tx) =>
        issueTierBenefit(tx, ctx.world.context, {
          facilityId: ctx.facilityId,
          customerProfileId,
          ruleId,
          period,
          tierKey: "gold",
          occurredAt: new Date("2026-11-08T03:00:00Z"),
        }),
      );
    return { ...ctx, ruleId, issue };
  }

  it("F6 the issued row's sourceRef has the UUID v5 shape", async () => {
    const { issue } = await tierSetup();
    const result = await issue("2026-11");
    if (result.status !== "issued") throw new Error("expected issued");
    expect(result.entry.sourceRef).toMatch(UUID_V5);
  });

  it("F6 the issued row passes entitlementLedgerEntrySchema", async () => {
    const { issue } = await tierSetup();
    const result = await issue("2026-11");
    if (result.status !== "issued") throw new Error("expected issued");
    const row = result.entry;
    const parsed = entitlementLedgerEntrySchema.safeParse({
      id: row.id,
      tenantId: row.tenantId,
      outletId: row.outletId,
      facilityId: row.facilityId,
      customerProfileId: row.customerProfileId,
      type: row.type,
      sessions: row.sessions,
      sourceType: row.sourceType,
      sourceRef: row.sourceRef,
      accessTicketId: row.accessTicketId ?? null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      occurredAt: row.occurredAt.toISOString(),
      actorUserId: row.actorUserId ?? null,
      reason: row.reason ?? null,
    });
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("F6 the same rule and month issues once, another month issues again", async () => {
    const { issue, world } = await tierSetup();
    expect((await issue("2026-11")).status).toBe("issued");
    expect((await issue("2026-11")).status).toBe("duplicate");
    expect((await issue("2026-12")).status).toBe("issued");
    const grantRows = (await ledgerRows(world.tenantId)).filter(
      (row) => row.type === "grant",
    );
    expect(grantRows).toHaveLength(2);
    expect(new Set(grantRows.map((row) => row.source_ref)).size).toBe(2);
    for (const row of grantRows) expect(row.source_ref).toMatch(UUID_V5);
  });
});
