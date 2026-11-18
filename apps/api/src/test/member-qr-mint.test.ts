// weexf: POST /api/member/qr-token mints a redeem token when the member sends
// { orderId, points }, and an attach-only token otherwise. The mint does not
// check the order; the POS does on redeem.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import {
  verifyMemberQrRedeemToken,
  verifyMemberQrToken,
} from "../lib/member-qr-token.ts";
import { originHeader } from "./helpers";
import { seededTenantId } from "./floor-test-helpers";
import {
  ensureConsentPolicies,
  memberHeaders,
  newMemberUser,
  owner,
} from "./member-loyalty-helpers.ts";
import { createIdentityTenant } from "./helpers/identity-isolation.ts";

let app: Express;

beforeAll(async () => {
  app = createApp();
  await ensureConsentPolicies();
});

afterAll(async () => {
  await owner.end();
});

type Member = Awaited<ReturnType<typeof newMemberUser>>;

const mint = (
  member: Pick<Member, "client">,
  body?: object,
  headers: Record<string, string> = memberHeaders,
) => {
  const request = member.client
    .post("/api/member/qr-token")
    .set(headers)
    .set(originHeader);
  return body === undefined ? request : request.send(body);
};

describe("weexf member QR mint", () => {
  it("a member mints a redeem token bound to the order and points", async () => {
    const member = await newMemberUser(app, { profile: "active" });
    const orderId = randomUUID();
    const response = await mint(member, { orderId, points: 150 });
    expect(response.status).toBe(200);
    const verified = verifyMemberQrRedeemToken(
      response.body.data.token,
      seededTenantId,
      new Date(),
    );
    expect(verified).toMatchObject({
      customerProfileId: member.profileId,
      orderId,
      points: 150,
    });
  });

  it("no body (and an empty JSON body) mints an attach token that does not redeem", async () => {
    const member = await newMemberUser(app, { profile: "active" });
    for (const body of [undefined, {}]) {
      const response = await mint(member, body);
      expect(response.status).toBe(200);
      const { token } = response.body.data;
      expect(verifyMemberQrToken(token, seededTenantId, new Date())).toEqual({
        customerProfileId: member.profileId,
      });
      expect(
        verifyMemberQrRedeemToken(token, seededTenantId, new Date()),
      ).toBeNull();
    }
  });

  it("orderId without points, points without orderId, and bad points are 422", async () => {
    const member = await newMemberUser(app, { profile: "active" });
    for (const body of [
      { orderId: randomUUID() },
      { points: 10 },
      { orderId: randomUUID(), points: 0 },
      { orderId: randomUUID(), points: -5 },
      { orderId: randomUUID(), points: 1.5 },
      { orderId: randomUUID(), points: 10, extra: true },
    ]) {
      const response = await mint(member, body);
      expect(response.status).toBe(422);
    }
  });

  it("a member of this tenant cannot mint on another tenant's host", async () => {
    const member = await newMemberUser(app, { profile: "active" });
    const other = await createIdentityTenant(owner, "mint", "mint-other");
    const response = await mint(
      member,
      { orderId: randomUUID(), points: 10 },
      { Host: other.hostname },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.data).toBeUndefined();
  });
});
