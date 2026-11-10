// legend-ts50: member feedback (POST /api/member/feedback, contract
// `submitFeedback`) and isolation of the `feedback` table (design ws08 §2 M4,
// §3 0196; brief 290d "Tes gagal-dulu / Feedback"; work brief 304a).
//
// Assumptions:
// - An order or table session the member does not own answers 404 NOT_FOUND
//   (generic; the same code as an unknown id, so existence never leaks). Never
//   CUSTOMER_NOT_FOUND.
// - Duplicate rule: the FIRST feedback of a kind for an order is 201, every
//   later one from the same member is 409 FEEDBACK_DUPLICATE and leaves one row.
//   Two concurrent submissions end as exactly one 201 and one 409.
// - Invalid bodies (a rating without a score, a complaint without a comment,
//   a client-supplied profile id) answer 400 or 422 and store nothing.
// - A submission names an order or a table session (or both); one naming
//   neither is invalid (400/422).
// - A new feedback is `open`, unassigned, and carries the member's own profile
//   and the order's (or session's) outlet.
// - Members have no read route for feedback: the staff queue answers 403.
// - `feedback.order_id` holds the order UUID (ulidToUuid of the ULID).

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { feedbackSchema } from "@starter/shared/crm";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { memberTenantContext, withMemberScope } from "../db/member-scope.ts";
import { agent, originHeader } from "./helpers";
import {
  seededOutletA,
  seededOutletB,
  seededTenantId,
} from "./floor-test-helpers";
import {
  contextOf,
  createWorld,
  ensureConsentPolicies,
  memberHeaders,
  newMemberUser,
  owner,
  seedOrder,
  seedProgram,
} from "./member-loyalty-helpers.ts";
import {
  feedbackById,
  feedbackOfOrder,
  feedbackOfSession,
  seedFeedback,
  seedTableSession,
} from "./feedback-helpers.ts";

let app: Express;

beforeAll(async () => {
  app = createApp();
  await ensureConsentPolicies();
  await seedProgram(seededTenantId);
});

afterAll(async () => {
  await owner.end();
});

type Member = Awaited<ReturnType<typeof newMemberUser>>;

const activeMember = () =>
  newMemberUser(app, { profile: "active", verifiedWhatsapp: true });

const submit = (member: Member, body: Record<string, unknown>) =>
  member.client
    .post("/api/member/feedback")
    .set(memberHeaders)
    .set(originHeader)
    .send(body);

const ratingFor = (orderUlid: string, overrides = {}) => ({
  kind: "rating",
  rating: 5,
  comment: null,
  tableSessionId: null,
  orderId: orderUlid,
  ...overrides,
});

const complaintFor = (orderUlid: string, overrides = {}) => ({
  kind: "complaint",
  rating: null,
  comment: "Pesanan datang dingin.",
  tableSessionId: null,
  orderId: orderUlid,
  ...overrides,
});

const orderOf = (member: Member, outletId = seededOutletA) =>
  seedOrder(seededTenantId, { outletId, profileId: member.profileId });

describe("legend-ts50 member submits feedback", () => {
  it("legend-ts50 a member rates their own order: 201, stored under their profile and the order's outlet", async () => {
    const member = await activeMember();
    const orderUlid = await orderOf(member, seededOutletB);

    const response = await submit(member, ratingFor(orderUlid, { rating: 4 }));

    expect(response.status).toBe(201);
    const feedback = feedbackSchema.parse(response.body.data);
    expect(feedback).toMatchObject({
      kind: "rating",
      rating: 4,
      status: "open",
      handledBy: null,
      resolvedAt: null,
      customerProfileId: member.profileId,
      orderId: orderUlid,
      outletId: seededOutletB,
    });
    const rows = await feedbackOfOrder(orderUlid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: feedback.id,
      customer_profile_id: member.profileId,
      outlet_id: seededOutletB,
      kind: "rating",
      rating: 4,
      status: "open",
      handled_by: null,
    });
  });

  it("legend-ts50 a member files a complaint with a comment on their own order", async () => {
    const member = await activeMember();
    const orderUlid = await orderOf(member);

    const response = await submit(member, complaintFor(orderUlid));

    expect(response.status).toBe(201);
    expect(feedbackSchema.parse(response.body.data)).toMatchObject({
      kind: "complaint",
      comment: "Pesanan datang dingin.",
      status: "open",
      customerProfileId: member.profileId,
    });
    expect(await feedbackOfOrder(orderUlid)).toHaveLength(1);
  });

  it("legend-ts50 a rating and a complaint for the same order are different kinds, both accepted", async () => {
    const member = await activeMember();
    const orderUlid = await orderOf(member);

    expect((await submit(member, ratingFor(orderUlid))).status).toBe(201);
    expect((await submit(member, complaintFor(orderUlid))).status).toBe(201);

    const rows = await feedbackOfOrder(orderUlid);
    expect(rows.map((row) => row.kind).sort()).toEqual(["complaint", "rating"]);
  });

  it("legend-ts50 a member who joined a table session can leave feedback for that session", async () => {
    const member = await activeMember();
    const sessionId = await seedTableSession([member.userId], seededOutletB);

    const response = await submit(member, {
      kind: "rating",
      rating: 3,
      comment: "Cukup baik",
      tableSessionId: sessionId,
      orderId: null,
    });

    expect(response.status).toBe(201);
    expect(feedbackSchema.parse(response.body.data)).toMatchObject({
      tableSessionId: sessionId,
      customerProfileId: member.profileId,
      outletId: seededOutletB,
    });
    const rows = await feedbackOfSession(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customer_profile_id).toBe(member.profileId);
  });
});

describe("legend-ts50 member feedback is refused", () => {
  it("legend-ts50 an order of another member answers 404 NOT_FOUND, not CUSTOMER_NOT_FOUND, and stores nothing", async () => {
    const a = await activeMember();
    const b = await activeMember();
    const bOrder = await orderOf(b);

    const response = await submit(a, ratingFor(bOrder));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(await feedbackOfOrder(bOrder)).toHaveLength(0);
  });

  it("legend-ts50 an unknown order answers the same 404 NOT_FOUND as another member's order", async () => {
    const a = await activeMember();
    const b = await activeMember();
    const bOrder = await orderOf(b);

    const foreign = await submit(a, ratingFor(bOrder));
    const unknown = await submit(a, ratingFor(createUlid()));

    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");
    expect(unknown.body.error.code).toBe(foreign.body.error.code);
    expect(unknown.status).toBe(foreign.status);
  });

  it("legend-ts50 an order of an anonymous guest (no profile) is not the member's: 404 NOT_FOUND", async () => {
    const member = await activeMember();
    const guestOrder = await seedOrder(seededTenantId, {
      outletId: seededOutletA,
      profileId: null,
      channel: "qr",
    });

    const response = await submit(member, ratingFor(guestOrder));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(await feedbackOfOrder(guestOrder)).toHaveLength(0);
  });

  it("legend-ts50 a table session the member did not join is refused with 404 NOT_FOUND and stores nothing", async () => {
    const outsider = await activeMember();
    const participant = await activeMember();
    const sessionId = await seedTableSession([participant.userId]);

    const response = await submit(outsider, {
      kind: "rating",
      rating: 2,
      comment: null,
      tableSessionId: sessionId,
      orderId: null,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(await feedbackOfSession(sessionId)).toHaveLength(0);
  });

  it("legend-ts50 the same kind for the same order twice: the second is 409 FEEDBACK_DUPLICATE, one row stays", async () => {
    const member = await activeMember();
    const orderUlid = await orderOf(member);

    const first = await submit(member, ratingFor(orderUlid, { rating: 5 }));
    const second = await submit(member, ratingFor(orderUlid, { rating: 1 }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("FEEDBACK_DUPLICATE");
    const rows = await feedbackOfOrder(orderUlid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rating).toBe(5);
  });

  it("legend-ts50 two simultaneous submissions of the same kind end as one 201, one 409, one row", async () => {
    const member = await activeMember();
    const orderUlid = await orderOf(member);

    const [one, two] = await Promise.all([
      submit(member, ratingFor(orderUlid, { rating: 5 })),
      submit(member, ratingFor(orderUlid, { rating: 4 })),
    ]);

    expect([one.status, two.status].sort()).toEqual([201, 409]);
    const loser = one.status === 409 ? one : two;
    expect(loser.body.error.code).toBe("FEEDBACK_DUPLICATE");
    expect(await feedbackOfOrder(orderUlid)).toHaveLength(1);
  });

  // B16: only `active` may send; a `closed` profile is invisible (404), the
  // same as no profile (requireMember, middleware/member.ts).
  it.each([
    ["pending_verification", 403, "MEMBERSHIP_NOT_ACTIVE"],
    ["closed", 404, "CUSTOMER_NOT_FOUND"],
  ] as const)(
    "legend-ts50 a %s membership gets %i %s and nothing is stored",
    async (status, httpStatus, code) => {
      const member = await newMemberUser(app, { profile: status });
      const orderUlid = await orderOf(member);

      const response = await submit(member, ratingFor(orderUlid));

      expect(response.status).toBe(httpStatus);
      expect(response.body.error.code).toBe(code);
      expect(await feedbackOfOrder(orderUlid)).toHaveLength(0);
    },
  );

  it("legend-ts50 a signed-in user without a profile gets 404 CUSTOMER_NOT_FOUND", async () => {
    const user = await newMemberUser(app);
    const orderUlid = await seedOrder(seededTenantId, {
      outletId: seededOutletA,
      profileId: null,
    });

    const response = await submit(user, ratingFor(orderUlid));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("CUSTOMER_NOT_FOUND");
    expect(await feedbackOfOrder(orderUlid)).toHaveLength(0);
  });

  it("legend-ts50 a visitor who is not signed in gets 401", async () => {
    const response = await agent(app)
      .post("/api/member/feedback")
      .set(memberHeaders)
      .set(originHeader)
      .send(ratingFor(createUlid()));

    expect(response.status).toBe(401);
  });

  it("legend-ts50 a rating without a score, a complaint without a comment and an out-of-range score are invalid", async () => {
    const member = await activeMember();
    const orderUlid = await orderOf(member);

    for (const body of [
      ratingFor(orderUlid, { rating: null }),
      complaintFor(orderUlid, { comment: null }),
      ratingFor(orderUlid, { rating: 6 }),
      ratingFor(orderUlid, { rating: 0 }),
      ratingFor(orderUlid, { orderId: null, tableSessionId: null }),
    ]) {
      const response = await submit(member, body);
      expect([400, 422], JSON.stringify(body)).toContain(response.status);
    }
    expect(await feedbackOfOrder(orderUlid)).toHaveLength(0);
  });

  it("legend-ts50 a client cannot choose the owner: a body naming a profile or tenant is invalid and stores nothing", async () => {
    const a = await activeMember();
    const b = await activeMember();
    const orderUlid = await orderOf(a);

    for (const extra of [
      { customerProfileId: b.profileId },
      { tenantId: randomUUID() },
      { status: "resolved" },
    ]) {
      const response = await submit(a, ratingFor(orderUlid, extra));
      expect([400, 422], JSON.stringify(extra)).toContain(response.status);
    }
    expect(await feedbackOfOrder(orderUlid)).toHaveLength(0);
  });
});

describe("legend-ts50 feedback isolation", () => {
  it("LOY-01 with the member scope set, a raw select shows own rows but never another member's or a QR guest's", async () => {
    const a = await activeMember();
    const b = await activeMember();
    const own = await seedFeedback({ profileId: a.profileId });
    const other = await seedFeedback({ profileId: b.profileId });
    const guest = await seedFeedback({ profileId: null });
    const scope = {
      context: memberTenantContext(seededTenantId),
      tenantId: seededTenantId,
      userId: a.userId,
      customerProfileId: a.profileId!,
      status: "active" as const,
    };
    const visible = (id: string) =>
      withMemberScope(db, scope, async (tx) =>
        Number(
          (
            await tx.execute(
              sql`SELECT count(*)::int AS n FROM feedback WHERE id = ${id}`,
            )
          ).rows[0]!.n,
        ),
      );

    expect(await visible(own.id)).toBe(1);
    expect(await visible(other.id)).toBe(0);
    expect(await visible(guest.id)).toBe(0);
    // Staff context (no member GUC) sees all three.
    const staffSees = await withTenant(
      db,
      contextOf(seededTenantId),
      async (tx) =>
        Number(
          (
            await tx.execute(
              sql`SELECT count(*)::int AS n FROM feedback WHERE id IN (${own.id}, ${other.id}, ${guest.id})`,
            )
          ).rows[0]!.n,
        ),
    );
    expect(staffSees).toBe(3);
  });

  it("LOY-01 a member scope cannot insert feedback for another member", async () => {
    const a = await activeMember();
    const b = await activeMember();
    const orderUlid = await orderOf(b);
    const scope = {
      context: memberTenantContext(seededTenantId),
      tenantId: seededTenantId,
      userId: a.userId,
      customerProfileId: a.profileId!,
      status: "active" as const,
    };

    await expect(
      withMemberScope(db, scope, (tx) =>
        tx.execute(sql`
          INSERT INTO feedback (id, tenant_id, outlet_id, customer_profile_id, order_id, kind, rating, status)
          VALUES (${randomUUID()}, ${seededTenantId}, ${seededOutletA}, ${b.profileId},
                  ${ulidToUuid(orderUlid)}, 'rating', 5, 'open')`),
      ),
    ).rejects.toBeDefined();
    expect(await feedbackOfOrder(orderUlid)).toHaveLength(0);
  });

  it("TEN-01 another tenant sees none of this tenant's feedback", async () => {
    const member = await activeMember();
    const row = await seedFeedback({ profileId: member.profileId });
    const other = await createWorld();

    const foreign = await withTenant(db, other.context, async (tx) =>
      Number(
        (
          await tx.execute(
            sql`SELECT count(*)::int AS n FROM feedback WHERE id = ${row.id}`,
          )
        ).rows[0]!.n,
      ),
    );
    expect(foreign).toBe(0);
    expect(await feedbackById(row.id)).not.toBeNull();
  });

  it("LOY-01 a member never reads the staff queue: GET /api/feedback is 403 PERMISSION_DENIED and leaks no feedback id", async () => {
    const a = await activeMember();
    const b = await activeMember();
    const mine = await seedFeedback({ profileId: a.profileId });
    const theirs = await seedFeedback({ profileId: b.profileId });

    const response = await a.client.get("/api/feedback").set(memberHeaders);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PERMISSION_DENIED");
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(mine.id);
    expect(text).not.toContain(theirs.id);
  });

  it("LOY-01 a member cannot change feedback through the staff route: PATCH is 403 PERMISSION_DENIED and the row is unchanged", async () => {
    const a = await activeMember();
    const mine = await seedFeedback({ profileId: a.profileId });

    const response = await a.client
      .patch(`/api/feedback/${mine.id}`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ action: "dismiss" });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PERMISSION_DENIED");
    expect((await feedbackById(mine.id))!.status).toBe("open");
  });
});
