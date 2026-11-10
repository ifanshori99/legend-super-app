// legend-ts50: the staff feedback queue (GET /api/feedback, PATCH
// /api/feedback/:feedbackId; contract `listFeedback`, `updateFeedback`,
// `transitionFeedback`; permission `crm.feedback.manage`). Design ws08 §3 0196,
// brief 290d "Tes gagal-dulu / Feedback", work brief 304a.
//
// Assumptions:
// - Who holds `crm.feedback.manage`: owner (tenant scope) and outlet_manager
//   (outlet scope). A cashier does not. A member session never does.
// - Missing permission is 403 PERMISSION_DENIED; no session is 401.
// - Status machine follows `transitionFeedback`: start_review (open ->
//   in_review), resolve (in_review -> resolved), close (resolved -> closed),
//   dismiss (open or in_review -> closed). Anything else is 409
//   FEEDBACK_TRANSITION_INVALID (crm errors.ts) and leaves the row unchanged.
//   A closed or resolved item carries `resolvedAt`; any item that left `open`
//   carries `handledBy` = the acting staff user (feedbackSchema invariants).
// - CONTRACT GAP: `updateFeedbackInputSchema` has only `action`. "handled_note
//   is stored" needs an optional nullable `handledNote` (max 2000) in the PATCH
//   body; these tests send it. Without that field the note tests fail.
// - An unknown feedback id is 404 NOT_FOUND; a malformed id or unknown action
//   is 400 or 422.
// - An outlet-scoped manager sees only their outlet's feedback (outlet RLS);
//   PATCH on another outlet's item is 403 or 404, and the row is unchanged.
// - The shared seeded tenant may hold rows from other tests, so list checks
//   look for specific ids rather than exact totals. The empty-queue state is
//   therefore not asserted over HTTP.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { feedbackSchema } from "@starter/shared/crm";
import { createApp } from "../app";
import { agent, originHeader } from "./helpers";
import {
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
import {
  ensureConsentPolicies,
  memberHeaders,
  newMemberUser,
  owner,
  seedProgram,
} from "./member-loyalty-helpers.ts";
import { feedbackById, seedFeedback } from "./feedback-helpers.ts";

let app: Express;
let admin: Staff;

beforeAll(async () => {
  app = createApp();
  await ensureConsentPolicies();
  await seedProgram(seededTenantId);
  admin = await staffWithRole(app, {
    template: "owner",
    label: "Owner Antrean Feedback",
  });
});

afterAll(async () => {
  await owner.end();
});

const list = (staff: Staff, query = "") =>
  staff.client.get(`/api/feedback${query}`).set(memberHeaders);

const act = (
  staff: Staff,
  id: string,
  body: Record<string, unknown>,
) =>
  staff.client
    .patch(`/api/feedback/${id}`)
    .set(memberHeaders)
    .set(originHeader)
    .send(body);

const idsOf = (response: { body: { data: { id: string }[] } }) =>
  response.body.data.map((item) => item.id);

describe("legend-ts50 staff feedback queue: list", () => {
  it("legend-ts50 staff with crm.feedback.manage sees every member's feedback and guest feedback, in the contract shape", async () => {
    const a = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const b = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const rowA = await seedFeedback({ profileId: a.profileId });
    const rowB = await seedFeedback({
      profileId: b.profileId,
      kind: "complaint",
      outletId: seededOutletB,
    });
    const guest = await seedFeedback({ profileId: null });

    const response = await list(admin, "?limit=100");

    expect(response.status).toBe(200);
    expect(response.body.meta).toHaveProperty("nextCursor");
    for (const item of response.body.data) feedbackSchema.parse(item);
    const ids = idsOf(response);
    expect(ids).toEqual(expect.arrayContaining([rowA.id, rowB.id, guest.id]));
    const guestItem = response.body.data.find(
      (item: { id: string }) => item.id === guest.id,
    );
    expect(guestItem.customerProfileId).toBeNull();
    const itemB = response.body.data.find(
      (item: { id: string }) => item.id === rowB.id,
    );
    expect(itemB).toMatchObject({
      customerProfileId: b.profileId,
      kind: "complaint",
      status: "open",
      outletId: seededOutletB,
    });
  });

  it("legend-ts50 the list filters by kind, status and outlet", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const rating = await seedFeedback({
      profileId: member.profileId,
      kind: "rating",
      outletId: seededOutletA,
    });
    const complaint = await seedFeedback({
      profileId: member.profileId,
      kind: "complaint",
      outletId: seededOutletB,
    });
    const reviewed = await seedFeedback({
      profileId: member.profileId,
      kind: "complaint",
      outletId: seededOutletB,
    });
    expect((await act(admin, reviewed.id, { action: "start_review" })).status).toBe(
      200,
    );

    const complaints = await list(admin, "?kind=complaint&limit=100");
    expect(complaints.status).toBe(200);
    expect(idsOf(complaints)).toEqual(
      expect.arrayContaining([complaint.id, reviewed.id]),
    );
    expect(idsOf(complaints)).not.toContain(rating.id);
    expect(
      complaints.body.data.every(
        (item: { kind: string }) => item.kind === "complaint",
      ),
    ).toBe(true);

    const inReview = await list(admin, "?status=in_review&limit=100");
    expect(idsOf(inReview)).toContain(reviewed.id);
    expect(idsOf(inReview)).not.toContain(complaint.id);
    expect(
      inReview.body.data.every(
        (item: { status: string }) => item.status === "in_review",
      ),
    ).toBe(true);

    const atOutletA = await list(admin, `?outletId=${seededOutletA}&limit=100`);
    expect(idsOf(atOutletA)).toContain(rating.id);
    expect(idsOf(atOutletA)).not.toContain(complaint.id);
    expect(
      atOutletA.body.data.every(
        (item: { outletId: string }) => item.outletId === seededOutletA,
      ),
    ).toBe(true);
  });

  it("legend-ts50 the list is paged: a page of one gives a cursor, and the next page continues without repeats", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    await seedFeedback({ profileId: member.profileId });
    await seedFeedback({ profileId: member.profileId });

    const first = await list(admin, "?limit=1");
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));

    const second = await list(
      admin,
      `?limit=1&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
  });

  it("legend-ts50 an unknown status or kind filter is invalid (400 or 422)", async () => {
    for (const query of ["?status=bogus", "?kind=bogus"]) {
      const response = await list(admin, query);
      expect([400, 422], query).toContain(response.status);
    }
  });
});

describe("legend-ts50 staff feedback queue: access", () => {
  it("legend-ts50 staff without crm.feedback.manage (cashier) get 403 PERMISSION_DENIED on list and update", async () => {
    const cashier = await staffWithRole(app, {
      template: "cashier",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Kasir Antrean Feedback",
    });
    const item = await seedFeedback({ profileId: null });

    const listed = await list(cashier);
    expect(listed.status).toBe(403);
    expect(listed.body.error.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(listed.body)).not.toContain(item.id);

    const patched = await act(cashier, item.id, { action: "start_review" });
    expect(patched.status).toBe(403);
    expect(patched.body.error.code).toBe("PERMISSION_DENIED");
    expect((await feedbackById(item.id))!.status).toBe("open");
  });

  it("legend-ts50 a member session gets 403 PERMISSION_DENIED on the staff queue", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const item = await seedFeedback({ profileId: member.profileId });

    const listed = await member.client.get("/api/feedback").set(memberHeaders);
    expect(listed.status).toBe(403);
    expect(listed.body.error.code).toBe("PERMISSION_DENIED");

    const patched = await member.client
      .patch(`/api/feedback/${item.id}`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ action: "dismiss" });
    expect(patched.status).toBe(403);
    expect(patched.body.error.code).toBe("PERMISSION_DENIED");
    expect((await feedbackById(item.id))!.status).toBe("open");
  });

  it("legend-ts50 a visitor who is not signed in gets 401", async () => {
    const listed = await agent(app).get("/api/feedback").set(memberHeaders);
    expect(listed.status).toBe(401);
    const patched = await agent(app)
      .patch(`/api/feedback/${randomUUID()}`)
      .set(memberHeaders)
      .set(originHeader)
      .send({ action: "dismiss" });
    expect(patched.status).toBe(401);
  });

  it("legend-ts50 an outlet manager sees and handles only their own outlet's feedback", async () => {
    const manager = await staffWithRole(app, {
      template: "outlet_manager",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Manajer Outlet Feedback",
    });
    const atA = await seedFeedback({
      profileId: null,
      outletId: seededOutletA,
    });
    const atB = await seedFeedback({
      profileId: null,
      outletId: seededOutletB,
    });

    const listed = await list(manager, "?limit=100");
    expect(listed.status).toBe(200);
    expect(idsOf(listed)).toContain(atA.id);
    expect(idsOf(listed)).not.toContain(atB.id);

    expect((await act(manager, atA.id, { action: "start_review" })).status).toBe(
      200,
    );
    const foreign = await act(manager, atB.id, { action: "start_review" });
    expect([403, 404]).toContain(foreign.status);
    expect((await feedbackById(atB.id))!.status).toBe("open");
  });

  it("TEN-01 a scoped manager never sees another outlet's feedback, even when the filter names that outlet", async () => {
    const manager = await staffWithRole(app, {
      template: "outlet_manager",
      scopeType: "outlet",
      scopeId: seededOutletA,
      label: "Manajer Filter Outlet",
    });
    const atB = await seedFeedback({
      profileId: null,
      outletId: seededOutletB,
    });

    const response = await list(manager, `?outletId=${seededOutletB}&limit=100`);

    expect([200, 403]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain(atB.id);
  });
});

describe("legend-ts50 staff feedback queue: status changes", () => {
  it("legend-ts50 start_review assigns the item to the acting staff and stores the handling note", async () => {
    const item = await seedFeedback({ profileId: null, kind: "complaint" });

    const response = await act(admin, item.id, {
      action: "start_review",
      handledNote: "Dicek ke dapur.",
    });

    expect(response.status).toBe(200);
    const updated = feedbackSchema.parse(response.body.data);
    expect(updated).toMatchObject({
      id: item.id,
      status: "in_review",
      handledBy: admin.userId,
      handledNote: "Dicek ke dapur.",
      resolvedAt: null,
    });
    expect(await feedbackById(item.id)).toMatchObject({
      status: "in_review",
      handled_by: admin.userId,
      handled_note: "Dicek ke dapur.",
      resolved_at: null,
    });
  });

  it("legend-ts50 the full path open -> in_review -> resolved -> closed works and sets the resolution time", async () => {
    const item = await seedFeedback({ profileId: null, kind: "complaint" });

    const review = await act(admin, item.id, { action: "start_review" });
    expect(review.body.data.status).toBe("in_review");
    const resolve = await act(admin, item.id, {
      action: "resolve",
      handledNote: "Pelanggan diberi penggantian.",
    });
    expect(resolve.status).toBe(200);
    expect(feedbackSchema.parse(resolve.body.data)).toMatchObject({
      status: "resolved",
      handledNote: "Pelanggan diberi penggantian.",
    });
    expect(resolve.body.data.resolvedAt).toEqual(expect.any(String));
    const close = await act(admin, item.id, { action: "close" });
    expect(close.status).toBe(200);
    expect(close.body.data.status).toBe("closed");

    const row = await feedbackById(item.id);
    expect(row!.status).toBe("closed");
    expect(row!.resolved_at).not.toBeNull();
    expect(row!.handled_by).toBe(admin.userId);
  });

  it("legend-ts50 dismiss closes an open item, and an in-review one", async () => {
    const open = await seedFeedback({ profileId: null });
    const reviewed = await seedFeedback({ profileId: null });
    await act(admin, reviewed.id, { action: "start_review" });

    const first = await act(admin, open.id, {
      action: "dismiss",
      handledNote: "Bukan keluhan.",
    });
    const second = await act(admin, reviewed.id, { action: "dismiss" });

    for (const response of [first, second]) {
      expect(response.status).toBe(200);
      expect(feedbackSchema.parse(response.body.data).status).toBe("closed");
      expect(response.body.data.resolvedAt).toEqual(expect.any(String));
      expect(response.body.data.handledBy).toBe(admin.userId);
    }
    expect((await feedbackById(open.id))!.handled_note).toBe("Bukan keluhan.");
  });

  it.each([
    ["open", "resolve", []],
    ["open", "close", []],
    ["in_review", "start_review", ["start_review"]],
    ["in_review", "close", ["start_review"]],
    ["resolved", "start_review", ["start_review", "resolve"]],
    ["resolved", "resolve", ["start_review", "resolve"]],
    ["resolved", "dismiss", ["start_review", "resolve"]],
    ["closed", "start_review", ["dismiss"]],
    ["closed", "close", ["dismiss"]],
    ["closed", "dismiss", ["dismiss"]],
  ] as const)(
    "legend-ts50 a %s item refuses %s with 409 FEEDBACK_TRANSITION_INVALID and stays unchanged",
    async (from, action, path) => {
      const item = await seedFeedback({ profileId: null });
      for (const step of path)
        expect((await act(admin, item.id, { action: step })).status).toBe(200);
      const before = await feedbackById(item.id);
      expect(before!.status).toBe(from);

      const response = await act(admin, item.id, {
        action,
        handledNote: "Tidak boleh tersimpan",
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("FEEDBACK_TRANSITION_INVALID");
      expect(await feedbackById(item.id)).toEqual(before);
    },
  );

  it("legend-ts50 two staff starting the same review at once: one wins with 200, the other gets 409", async () => {
    const other = await staffWithRole(app, {
      template: "owner",
      label: "Owner Kedua Feedback",
    });
    const item = await seedFeedback({ profileId: null });

    const [one, two] = await Promise.all([
      act(admin, item.id, { action: "start_review" }),
      act(other, item.id, { action: "start_review" }),
    ]);

    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const loser = one.status === 409 ? one : two;
    expect(loser.body.error.code).toBe("FEEDBACK_TRANSITION_INVALID");
    const winner = one.status === 200 ? admin : other;
    expect((await feedbackById(item.id))!.handled_by).toBe(winner.userId);
  });

  it("legend-ts50 an unknown feedback id answers 404 NOT_FOUND", async () => {
    const response = await act(admin, randomUUID(), {
      action: "start_review",
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("legend-ts50 a malformed id, an unknown action, a missing action and a client-set status are invalid", async () => {
    const item = await seedFeedback({ profileId: null });

    expect([400, 422]).toContain(
      (await act(admin, "not-a-uuid", { action: "dismiss" })).status,
    );
    for (const body of [
      { action: "reopen" },
      {},
      { action: "dismiss", status: "resolved" },
      { action: "dismiss", handledNote: "x".repeat(2001) },
    ]) {
      const response = await act(admin, item.id, body);
      expect([400, 422], JSON.stringify(body).slice(0, 60)).toContain(
        response.status,
      );
    }
    expect((await feedbackById(item.id))!.status).toBe("open");
  });
});
