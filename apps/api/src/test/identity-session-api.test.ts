// Session policies (PRD v1.7 §3 F6 "Sesi & Perangkat"): customer sessions last
// 90 days, management sessions end after 30 idle minutes, and a session can be
// revoked per device. Runs against the disposable PostgreSQL server; the
// service is the same one the API uses.

import { Pool } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { SESSION_ACTIVITY_WRITE_SECONDS } from "@starter/shared/identity";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import {
  loadSessionRow,
  sessionPolicy,
  toWireSession,
  touchSession,
} from "../services/identity-session.service";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const PASSWORD = "Test-password-123!";
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const createdUserIds = new Set<string>();

afterAll(async () => {
  if (createdUserIds.size > 0)
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      [...createdUserIds],
    ]);
  await owner.end();
});

async function signIn(
  email: string,
): Promise<{ cookie: string; userId: string }> {
  const response = await request(app)
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  createdUserIds.add(response.body.user.id);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return {
    cookie: cookies.map((value) => value.split(";")[0]).join("; "),
    userId: response.body.user.id as string,
  };
}

async function sessionIdOf(cookie: string): Promise<string> {
  const response = await request(app)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  expect(response.status).toBe(200);
  return response.body.session.id as string;
}

describe("session policy (§3 F6 Sesi & Perangkat)", () => {
  it("F6 customer sessions are created with a 90-day lifetime", async () => {
    const client = agent(app);
    const email = await signUp(client, "Pelanggan");
    const { cookie } = await signIn(email);
    const row = await loadSessionRow(await sessionIdOf(cookie));
    expect(row).not.toBeNull();
    const lifetime = row!.expiresAt.getTime() - row!.createdAt.getTime();
    // 90 days, allowing a second of clock skew in the cookie round trip.
    expect(Math.abs(lifetime - 90 * DAY_MS)).toBeLessThan(2000);
    expect(row!.kind).toBe("customer");
  });

  it("F6 a database clock behind the API clock never fails the session contract", async () => {
    const client = agent(app);
    const email = await signUp(client, "Jam Bergeser");
    const { cookie } = await signIn(email);
    const row = await loadSessionRow(await sessionIdOf(cookie));
    expect(row).not.toBeNull();
    // last_seen_at (DB clock) a few ms before created_at (API clock).
    const skewed = {
      ...row!,
      lastSeenAt: new Date(row!.createdAt.getTime() - 5),
    };
    const wire = toWireSession(skewed);
    expect(wire.lastSeenAt).toBe(row!.createdAt.toISOString());
  });

  it("F6 management sessions end after 30 idle minutes", async () => {
    const client = agent(app);
    const email = await signUp(client, "Manajer Idle");
    const { cookie } = await signIn(email);
    const sessionId = await sessionIdOf(cookie);
    await owner.query(
      "UPDATE session SET kind = 'management', created_at = now() - interval '40 minutes', last_seen_at = now() - interval '31 minutes' WHERE id = $1",
      [sessionId],
    );
    const idle = await loadSessionRow(sessionId);
    expect(
      sessionPolicy({
        row: idle!,
        management: true,
        mfaRequired: false,
        now: new Date(),
      }).gate,
    ).toBe("expired");

    await owner.query(
      "UPDATE session SET last_seen_at = now() - interval '10 minutes' WHERE id = $1",
      [sessionId],
    );
    const active = await loadSessionRow(sessionId);
    const policy = sessionPolicy({
      row: active!,
      management: true,
      mfaRequired: false,
      now: new Date(),
    });
    expect(policy.gate).toBe("ok");
    expect(policy.session.kind).toBe("management");
  });

  it("F6 activity upgrades a customer session to management and pushes its idle deadline", async () => {
    const client = agent(app);
    const email = await signUp(client, "Naik Ke Manajemen");
    const { cookie } = await signIn(email);
    const sessionId = await sessionIdOf(cookie);
    const row = await loadSessionRow(sessionId);

    const now = new Date();
    await touchSession({ row: row!, management: true, now });
    const upgraded = await loadSessionRow(sessionId);
    expect(upgraded!.kind).toBe("management");
    expect(
      Math.abs(
        upgraded!.expiresAt.getTime() - (now.getTime() + 30 * MINUTE_MS),
      ),
    ).toBeLessThan(2000);

    const later = new Date(now.getTime() + 10 * MINUTE_MS);
    await touchSession({ row: upgraded!, management: true, now: later });
    const renewed = await loadSessionRow(sessionId);
    expect(
      Math.abs(
        renewed!.expiresAt.getTime() - (later.getTime() + 30 * MINUTE_MS),
      ),
    ).toBeLessThan(2000);
  });

  it("F6 touching a customer session keeps its 90-day end", async () => {
    const client = agent(app);
    const email = await signUp(client, "Pelanggan Aktif");
    const { cookie } = await signIn(email);
    const sessionId = await sessionIdOf(cookie);
    const row = await loadSessionRow(sessionId);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("customer");
    // touchSession decides on the wire clock, which clamps last_seen_at up to
    // created_at when the database clock trails the API clock (toWireSession).
    // Measure the injected activity instant from that same clock and step a
    // whole window past the activity throttle, so neither clock skew nor the
    // exact `elapsed >= 60 s` boundary can decide whether the write happens.
    // A write is required: the test asserts the activity was recorded.
    const lastSeenAt = Date.parse(toWireSession(row!).lastSeenAt);
    const later = new Date(
      lastSeenAt + 2 * SESSION_ACTIVITY_WRITE_SECONDS * 1000,
    );
    await touchSession({ row: row!, management: false, now: later });
    const touched = await loadSessionRow(sessionId);
    expect(touched).not.toBeNull();
    expect(touched!.expiresAt.getTime()).toBe(row!.expiresAt.getTime());
    expect(touched!.lastSeenAt.getTime()).toBe(later.getTime());
  });

  it("F6 a database clock behind the API clock still records customer activity without moving the 90-day end", async () => {
    const client = agent(app);
    const email = await signUp(client, "Jam Bergeser Aktif");
    const { cookie } = await signIn(email);
    const sessionId = await sessionIdOf(cookie);
    // Reproduce the skew the flaky run hit: last_seen_at (DB clock) is stamped
    // before created_at (API clock), so the wire clamp raises the value the
    // activity throttle measures from.
    await owner.query(
      "UPDATE session SET last_seen_at = created_at - interval '5 milliseconds' WHERE id = $1",
      [sessionId],
    );
    const row = await loadSessionRow(sessionId);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("customer");
    const lastSeenAt = Date.parse(toWireSession(row!).lastSeenAt);
    const later = new Date(
      lastSeenAt + 2 * SESSION_ACTIVITY_WRITE_SECONDS * 1000,
    );
    await touchSession({ row: row!, management: false, now: later });
    const touched = await loadSessionRow(sessionId);
    expect(touched).not.toBeNull();
    expect(touched!.expiresAt.getTime()).toBe(row!.expiresAt.getTime());
    expect(touched!.lastSeenAt.getTime()).toBe(later.getTime());
  });

  it("AUTH-05 extends a live management session, while GET /api/auth/me is non-activity", async () => {
    const client = agent(app);
    const email = await signUp(client, "Aktivitas Manajer");
    const { cookie } = await signIn(email);
    const id = await sessionIdOf(cookie);
    await owner.query(
      "UPDATE session SET kind = 'management', created_at = now() - interval '40 minutes', last_seen_at = now() - interval '28 minutes', expires_at = now() + interval '2 minutes' WHERE id = $1",
      [id],
    );
    const before = await loadSessionRow(id);
    await request(app).get("/api/auth/me").set("Cookie", cookie);
    const afterGet = await loadSessionRow(id);
    expect(afterGet!.lastSeenAt.getTime()).toBe(before!.lastSeenAt.getTime());
    expect(afterGet!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());

    const response = await request(app)
      .post("/api/auth/sessions/current/activity")
      .set(originHeader)
      .set("Cookie", cookie);
    expect(response.status).toBe(204);
    const after = await loadSessionRow(id);
    expect(after!.lastSeenAt.getTime()).toBeGreaterThan(
      before!.lastSeenAt.getTime(),
    );
    expect(after!.expiresAt.getTime()).toBeGreaterThan(
      before!.expiresAt.getTime(),
    );
    const again = await request(app)
      .post("/api/auth/sessions/current/activity")
      .set(originHeader)
      .set("Cookie", cookie);
    expect(again.status).toBe(204);
    expect((await loadSessionRow(id))!.lastSeenAt.getTime()).toBe(
      after!.lastSeenAt.getTime(),
    );
  });

  it("AUTH-05 refuses unauthenticated, customer and untrusted-origin activity", async () => {
    const path = "/api/auth/sessions/current/activity";
    expect((await request(app).post(path).set(originHeader)).status).toBe(401);
    const email = await signUp(agent(app), "Pelanggan Aktivitas");
    const { cookie } = await signIn(email);
    expect(
      (await request(app).post(path).set(originHeader).set("Cookie", cookie))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(path)
          .set("Origin", "https://evil.example")
          .set("Cookie", cookie)
      ).status,
    ).toBe(403);
  });

  it("AUTH-05 cannot resurrect an idle, expired or revoked session", async () => {
    const email = await signUp(agent(app), "Manajer Kedaluwarsa");
    const { cookie } = await signIn(email);
    const id = await sessionIdOf(cookie);
    const path = "/api/auth/sessions/current/activity";
    await owner.query(
      "UPDATE session SET kind = 'management', created_at = now() - interval '40 minutes', last_seen_at = now() - interval '31 minutes' WHERE id = $1",
      [id],
    );
    expect(
      (await request(app).post(path).set(originHeader).set("Cookie", cookie))
        .status,
    ).toBe(401);
    const idle = await loadSessionRow(id);
    expect(idle!.lastSeenAt.getTime()).toBeLessThan(
      Date.now() - 30 * MINUTE_MS,
    );
    await owner.query(
      "UPDATE session SET expires_at = now() + interval '10 minutes', revoked_at = now(), last_seen_at = now() WHERE id = $1",
      [id],
    );
    expect(
      (await request(app).post(path).set(originHeader).set("Cookie", cookie))
        .status,
    ).toBe(401);
    expect((await loadSessionRow(id))!.revokedAt).not.toBeNull();
    const expired = await signIn(email);
    const expiredId = await sessionIdOf(expired.cookie);
    await owner.query(
      "UPDATE session SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expiredId],
    );
    expect(
      (
        await request(app)
          .post(path)
          .set(originHeader)
          .set("Cookie", expired.cookie)
      ).status,
    ).toBe(401);
  });

  it("F6 the device list shows the caller's live sessions and marks the current one", async () => {
    const client = agent(app);
    const email = await signUp(client, "Dua Perangkat");
    const first = await signIn(email);
    const second = await signIn(email);
    const response = await request(app)
      .get("/api/auth/sessions")
      .set("Cookie", first.cookie);
    expect(response.status).toBe(200);
    const views = response.body.data as {
      session: { id: string; deviceLabel: string; kind: string };
      current: boolean;
    }[];
    expect(views.length).toBeGreaterThanOrEqual(2);
    expect(views.filter((view) => view.current)).toHaveLength(1);
    expect(views.map((view) => view.session.id)).toContain(
      await sessionIdOf(second.cookie),
    );
    for (const view of views)
      expect(view.session.deviceLabel.length).toBeGreaterThan(0);
  });

  it("F6 revoking one device ends that session and leaves the others signed in", async () => {
    const client = agent(app);
    const email = await signUp(client, "Cabut Perangkat");
    const first = await signIn(email);
    const second = await signIn(email);
    const secondSessionId = await sessionIdOf(second.cookie);

    const revoked = await request(app)
      .delete(`/api/auth/sessions/${secondSessionId}`)
      .set(originHeader)
      .set("Cookie", first.cookie);
    expect(revoked.status).toBe(204);

    // Better Auth reads the same row, so the revoked cookie stops working.
    const afterRevoke = await request(app)
      .get("/api/auth/sessions")
      .set("Cookie", second.cookie);
    expect(afterRevoke.status).toBe(401);

    const stillSignedIn = await request(app)
      .get("/api/auth/sessions")
      .set("Cookie", first.cookie);
    expect(stillSignedIn.status).toBe(200);
  });

  it("F6 a user cannot see or revoke another user's session", async () => {
    const firstClient = agent(app);
    const firstEmail = await signUp(firstClient, "Pemilik Sesi");
    const first = await signIn(firstEmail);
    const secondClient = agent(app);
    const secondEmail = await signUp(secondClient, "Penyusup");
    const second = await signIn(secondEmail);
    const firstSessionId = await sessionIdOf(first.cookie);

    const listed = await request(app)
      .get("/api/auth/sessions")
      .set("Cookie", second.cookie);
    expect(listed.status).toBe(200);
    expect(
      (listed.body.data as { session: { id: string } }[]).map(
        (view) => view.session.id,
      ),
    ).not.toContain(firstSessionId);

    const denied = await request(app)
      .delete(`/api/auth/sessions/${firstSessionId}`)
      .set(originHeader)
      .set("Cookie", second.cookie);
    expect(denied.status).toBe(404);
    // The owner's session is untouched.
    expect(
      (await request(app).get("/api/auth/sessions").set("Cookie", first.cookie))
        .status,
    ).toBe(200);
  });

  it("F6 tenant-bound sessions stay readable without a tenant context (global table)", async () => {
    const client = agent(app);
    const email = await signUp(client, "Sesi Tenant");
    const { cookie } = await signIn(email);
    const sessionId = await sessionIdOf(cookie);
    await owner.query("UPDATE session SET tenant_id = $1 WHERE id = $2", [
      tenantId,
      sessionId,
    ]);
    const response = await request(app)
      .get("/api/auth/sessions")
      .set("Cookie", cookie);
    expect(response.status).toBe(200);
    const view = (
      response.body.data as {
        session: { id: string; tenantId: string | null };
        current: boolean;
      }[]
    ).find((entry) => entry.current);
    expect(view?.session.tenantId).toBe(tenantId);
  });
});
