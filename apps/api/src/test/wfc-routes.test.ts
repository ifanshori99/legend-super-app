// Brief 1270 card W2 (review no. 2): the member WFC routes over HTTP. The
// chain is requireTenantContext -> requireAuth -> requireTrustedOrigin ->
// requireMember; the profile comes from the session only, the body is strict,
// and a claim of another member is invisible. Money paths are proved in
// wfc-sale.test.ts.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { seededOutletA, seededTenantId } from "./floor-test-helpers";
import { agent, originHeader } from "./helpers";
import {
  memberHeaders,
  newMemberUser,
  owner,
  seedProfile,
} from "./member-loyalty-helpers.ts";

let app: Express;

beforeAll(() => {
  app = createApp();
});
afterAll(async () => {
  await owner.end();
});

const activeMember = () =>
  newMemberUser(app, { profile: "active", verifiedWhatsapp: true });

const HOLD = {
  productId: randomUUID(),
  startsAt: "2098-11-08T03:00:00.000Z",
};

/** A claim of another profile of the seeded tenant (fixture: no triggers). */
async function foreignClaim(): Promise<string> {
  const profile = await seedProfile(seededTenantId);
  const id = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO wfc_seat_reservations
         (id, tenant_id, outlet_id, seat_id, product_id, customer_profile_id, kind, access,
          business_date, slot, status, seat_fee_idr, credit_idr, price_idr,
          settings_version_id, floor_per_hour_idr, hold_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'day_pass', 'all_day', '2098-11-08',
               '[2098-11-08T01:00:00Z,2098-11-08T02:00:00Z)', 'pending_payment',
               50000, 20000, 70000, $7, 1, '2098-11-08T00:45:00Z')`,
      [
        id,
        seededTenantId,
        seededOutletA,
        randomUUID(),
        randomUUID(),
        profile.id,
        randomUUID(),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return id;
}

const claimsOfProfile = async (profileId: string | null) =>
  (
    await owner.query(
      "SELECT id FROM wfc_seat_reservations WHERE customer_profile_id = $1",
      [profileId],
    )
  ).rows;

describe("W2 member WFC routes", () => {
  it("no session: 401 on every route", async () => {
    const anon = agent(app);
    for (const res of [
      await anon.get("/api/wfc/claims").set(memberHeaders).set(originHeader),
      await anon
        .get(`/api/wfc/products?outletId=${seededOutletA}`)
        .set(memberHeaders)
        .set(originHeader),
      await anon
        .post("/api/wfc/claims")
        .set(memberHeaders)
        .set(originHeader)
        .send(HOLD),
      await anon
        .post(`/api/wfc/claims/${randomUUID()}/payment`)
        .set(memberHeaders)
        .set(originHeader),
    ])
      expect(res.status).toBe(401);
  });

  it("a write from an untrusted origin is refused before the service runs", async () => {
    const member = await activeMember();
    for (const res of [
      await member.client
        .post("/api/wfc/claims")
        .set(memberHeaders)
        .set({ Origin: "https://evil.example" })
        .send(HOLD),
      await member.client
        .post(`/api/wfc/claims/${randomUUID()}/payment`)
        .set(memberHeaders)
        .set({ Origin: "https://evil.example" }),
    ])
      expect(res.status).toBe(403);
    expect(await claimsOfProfile(member.profileId)).toEqual([]);
  });

  it("a signed-in user without an active membership is refused", async () => {
    const noProfile = await newMemberUser(app);
    const pending = await newMemberUser(app, {
      profile: "pending_verification",
    });
    for (const [user, status, code] of [
      [noProfile, 404, "CUSTOMER_NOT_FOUND"],
      [pending, 403, "MEMBERSHIP_NOT_ACTIVE"],
    ] as const) {
      const res = await user.client
        .post("/api/wfc/claims")
        .set(memberHeaders)
        .set(originHeader)
        .send(HOLD);
      expect(res.status, code).toBe(status);
      expect(res.body.error.code).toBe(code);
      const list = await user.client
        .get("/api/wfc/claims")
        .set(memberHeaders)
        .set(originHeader);
      expect(list.status, code).toBe(status);
    }
  });

  it("the body is strict: no price, method, profile or missing slot is accepted", async () => {
    const member = await activeMember();
    for (const body of [
      { ...HOLD, amountIdr: 1 },
      { ...HOLD, method: "va" },
      { ...HOLD, customerProfileId: randomUUID() },
      { ...HOLD, priceIdr: 1 },
      { productId: HOLD.productId },
      { ...HOLD, date: "2098-11-08" },
      { ...HOLD, productId: "not-a-uuid" },
    ]) {
      const res = await member.client
        .post("/api/wfc/claims")
        .set(memberHeaders)
        .set(originHeader)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }
    expect(await claimsOfProfile(member.profileId)).toEqual([]);
  });

  it("another member's claim is not found, never listed, never refreshed", async () => {
    const member = await activeMember();
    const claimId = await foreignClaim();
    const read = await member.client
      .get(`/api/wfc/claims/${claimId}`)
      .set(memberHeaders)
      .set(originHeader);
    expect(read.status).toBe(404);
    expect(read.body.data).toBeUndefined();
    const refresh = await member.client
      .post(`/api/wfc/claims/${claimId}/payment`)
      .set(memberHeaders)
      .set(originHeader);
    expect(refresh.status).toBe(404);
    const list = await member.client
      .get("/api/wfc/claims")
      .set(memberHeaders)
      .set(originHeader);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
  });

  it("an invalid claim id is 400", async () => {
    const member = await activeMember();
    const read = await member.client
      .get("/api/wfc/claims/not-a-uuid")
      .set(memberHeaders)
      .set(originHeader);
    expect(read.status).toBe(400);
    const refresh = await member.client
      .post("/api/wfc/claims/not-a-uuid/payment")
      .set(memberHeaders)
      .set(originHeader);
    expect(refresh.status).toBe(400);
    expect(refresh.body.error.code).toBe("VALIDATION_FAILED");
  });
});
