// legend-488 item 5 (Codex finding identity-session.service.ts:314): a revoked
// session must always emit `session.revoked`, also when it has no tenant.
// Fail-first, through the real login path (HTTP sign-in, DELETE device), not
// hand-inserted session rows.
//
// Assumptions (brief docs/briefs/488-findings-fixes.md item 5):
// - "Staff login" = email/password sign-in on the tenant host
//   (cafeLegendPlatformFixtures.domains[0]) by a user holding an active role
//   assignment in that tenant. The login must store that tenant in
//   `session.tenant_id`.
// - A session created without a tenant host (platform-only) keeps
//   `session.tenant_id` NULL; revoking it emits the same `session.revoked`
//   event as a global event: `domain_event_outbox` row with
//   stored under the control-plane sentinel tenant (CONTROL_PLANE_TENANT_ID),
//   aggregate_type 'session', aggregate_id = session id, destination
//   'control-plane', payload {sessionId, userId, cause}.
// - Revoke goes through DELETE /api/auth/sessions/:id (device revoke, 204)
//   called from another live session of the same user; cause is
//   "revoked_by_user" as in identity-platform-events.test.ts.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTROL_PLANE_TENANT_ID } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";

const fixtures = cafeLegendPlatformFixtures;
const tenantId = fixtures.tenant.id;
const host = fixtures.domains[0]!.hostname;
const PASSWORD = "Test-password-123!";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const userIds: string[] = [];
const roleIds: string[] = [];

async function asTenant<T>(
  run: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A user with an active role assignment in the fixture tenant (staff). */
async function newStaff(): Promise<{ email: string; userId: string }> {
  const email = await signUp(agent(app), "Staf Cabut Sesi");
  const { rows } = await owner.query<{ id: string }>(
    'SELECT id FROM "user" WHERE email = $1',
    [email],
  );
  const userId = rows[0]!.id;
  userIds.push(userId);
  const roleId = randomUUID();
  roleIds.push(roleId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Staf revoke ${roleId.slice(0, 8)}`,
        JSON.stringify(["hr.employee.view"]),
        JSON.stringify(["tenant"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantId, userId, roleId],
    );
  });
  return { email, userId };
}

async function signIn(email: string, onHost: string | null) {
  const client = agent(app);
  const call = onHost ? client.host(onHost) : client;
  const response = await call
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password: PASSWORD });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
  const current = await request(app)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  return { cookie, sessionId: current.body.session.id as string };
}

async function revokeFrom(
  callerCookie: string,
  sessionId: string,
  onHost: string | null,
) {
  const call = request(app)
    .delete(`/api/auth/sessions/${sessionId}`)
    .set(originHeader)
    .set("Cookie", callerCookie);
  if (onHost) call.set("Host", onHost);
  const response = await call;
  expect(response.status).toBe(204);
}

async function sessionEvents(sessionId: string) {
  const { rows } = await owner.query<{
    tenant_id: string | null;
    destination: string;
    event: { name: string; payload: Record<string, unknown> };
  }>(
    `SELECT tenant_id, destination, event FROM domain_event_outbox
      WHERE aggregate_type = 'session' AND aggregate_id = $1`,
    [sessionId],
  );
  return rows;
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (userIds.length > 0) {
    await asTenant((client) =>
      client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenantId, userIds],
      ),
    );
    await asTenant((client) =>
      client.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
        tenantId,
        roleIds,
      ]),
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      userIds,
    ]);
  }
  await owner.end();
});

describe("session.revoked for sessions created by real logins (legend-488 #5)", () => {
  it("a staff login on the tenant host stores session.tenant_id", async () => {
    const { email } = await newStaff();
    const { sessionId } = await signIn(email, host);
    const { rows } = await owner.query<{ tenant_id: string | null }>(
      "SELECT tenant_id FROM session WHERE id = $1",
      [sessionId],
    );
    expect(rows[0]?.tenant_id).toBe(tenantId);
  });

  it("revoking a staff session emits one tenant-scoped session.revoked event", async () => {
    const { email, userId } = await newStaff();
    const first = await signIn(email, host);
    const second = await signIn(email, host);
    await revokeFrom(first.cookie, second.sessionId, host);

    const events = await sessionEvents(second.sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenant_id: tenantId,
      destination: "identity",
    });
    expect(events[0]?.event.name).toBe("session.revoked");
    expect(events[0]?.event.payload).toMatchObject({
      sessionId: second.sessionId,
      userId,
      cause: "revoked_by_user",
    });
  });

  it("revoking a platform-only session (no tenant) emits a global session.revoked event", async () => {
    const email = await signUp(agent(app), "Platform Murni");
    const { rows: users } = await owner.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email = $1',
      [email],
    );
    const userId = users[0]!.id;
    userIds.push(userId);
    const first = await signIn(email, null);
    const second = await signIn(email, null);
    const { rows: stored } = await owner.query<{ tenant_id: string | null }>(
      "SELECT tenant_id FROM session WHERE id = $1",
      [second.sessionId],
    );
    expect(stored[0]?.tenant_id).toBeNull();

    await revokeFrom(first.cookie, second.sessionId, null);

    const events = await sessionEvents(second.sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.tenant_id).toBe(CONTROL_PLANE_TENANT_ID);
    expect(events[0]?.destination).toBe("control-plane");
    expect(events[0]?.event.name).toBe("session.revoked");
    expect(events[0]?.event.payload).toMatchObject({
      sessionId: second.sessionId,
      userId,
    });
    const { rows } = await owner.query(
      "SELECT revoked_at FROM session WHERE id = $1",
      [second.sessionId],
    );
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it("revoking the same platform-only session twice still emits only once", async () => {
    const email = await signUp(agent(app), "Platform Dua Kali");
    const { rows: users } = await owner.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email = $1',
      [email],
    );
    userIds.push(users[0]!.id);
    const first = await signIn(email, null);
    const second = await signIn(email, null);
    await revokeFrom(first.cookie, second.sessionId, null);
    await request(app)
      .delete(`/api/auth/sessions/${second.sessionId}`)
      .set(originHeader)
      .set("Cookie", first.cookie);
    expect(await sessionEvents(second.sessionId)).toHaveLength(1);
  });
});
