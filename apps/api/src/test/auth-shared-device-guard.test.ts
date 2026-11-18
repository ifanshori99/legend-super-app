// legend-wa9n7 part 2 (brief 1017 card B): Better Auth's own /api/auth/* routes
// must refuse a login session that touched an active flagged shared device
// (cashier terminal). Written from the card brief, not from the implementation.
//
// Rules under test:
//  - A session marked with an active shared device (session.shared_device_ids),
//    or carrying the X-Device-Token of an active flagged device, may call ONLY
//    get-session, sign-out, sign-in/* and (legend-hlmbk, brief 1018 part B) the
//    idle keep-alive POST sessions/current/activity under /api/auth.
//    Everything else (update-user, change-password, change-email, set-password,
//    list-sessions, revoke-session(s), revoke-other-sessions, delete-user,
//    admin/*, two-factor/*, passkey/*, link/unlink-account, callback/*,
//    login-challenges/*, unknown paths) is
//    refused 403 ACTING_STAFF_NOT_ALLOWED as a JSON error.
//  - Path matching is case-insensitive on a normalized path: trailing slash is
//    stripped, a path containing `..` is not an allowlist match.
//  - Personal sessions (never marked, mark on an unflagged device, or every
//    mark lapsed) and requests without a session are unchanged.
//
// Assumptions (spec silent):
//  - The refusal body is the project's HttpError JSON: { error: { code, message } }.
//  - A request with no session and a flagged device token is NOT refused by this
//    guard (no session -> next; Better Auth answers 401 on its own).
//  - An unmarked session sending a flagged device's X-Device-Token is refused on a
//    non-allowlisted path (brief: marks = sharedDeviceIds + valid x-device-token).
//  - Request bodies are plausible Better Auth shapes; the guard answers before
//    the body matters, so a 403 ACTING_STAFF_NOT_ALLOWED can only come from it.
//  - A path with an encoded `..` segment never reaches update-user: 400 (existing
//    request-target check) or 403 are both fine.
//  - sessions/current/activity (idle keep-alive) answers 2xx (coordinator: 200;
//    the existing AUTH-05 test sees 204 for a management session, so 200 or 204
//    are both accepted) on a marked session or a flagged device token, for a
//    management-kind session (a customer-kind session gets 403 from the route's
//    own rule, unrelated to shared devices). It really extends last_seen_at.
//    The account-change endpoints stay 403 ACTING_STAFF_NOT_ALLOWED.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { markSessionSharedDevice } from "../services/shared-device.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { owner, seededOutletA, seededTenantId } from "./floor-test-helpers.ts";

const NOT_ALLOWED = "ACTING_STAFF_NOT_ALLOWED";
const PASSWORD = "Test-password-123!";

type Client = ReturnType<typeof agent>;
type Method = "get" | "post";
type Res = { status: number; body: unknown };
type Member = {
  client: Client;
  email: string;
  userId: string;
  sessionId: string;
};

let app: Express;
const deviceIds: string[] = [];

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: seededTenantId,
    brandId: null,
    deviceId,
  });

async function newDevice(flagged: boolean): Promise<string> {
  const id = randomUUID();
  deviceIds.push(id);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
    [id, seededTenantId, seededOutletA, `Kasir 1017 ${id.slice(0, 6)}`],
  );
  if (flagged) await setFlag(id, true);
  return id;
}

const setFlag = (id: string, value: boolean) =>
  owner.query("UPDATE devices SET shared_mode = $2 WHERE id = $1", [id, value]);

/** A fresh login (plain user, personal session). */
async function member(label: string): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, label);
  const { rows } = await owner.query<{ id: string; user_id: string }>(
    `SELECT s.id, s.user_id FROM "session" s
       JOIN "user" u ON u.id = s.user_id WHERE u.email = $1`,
    [email],
  );
  expect(rows).toHaveLength(1);
  return {
    client,
    email,
    userId: rows[0]!.user_id,
    sessionId: rows[0]!.id,
  };
}

/** A login whose session is stamped with one active flagged device. */
async function markedMember(label: string) {
  const device = await newDevice(true);
  const who = await member(label);
  expect(await markSessionSharedDevice(who.sessionId, device)).toBe(true);
  return { who, device };
}

function call(
  client: Client,
  method: Method,
  path: string,
  body?: object,
  extra: Record<string, string> = {},
): Promise<Res> {
  const req =
    method === "get"
      ? client.get(path).set(originHeader).set(extra)
      : client
          .post(path)
          .set(originHeader)
          .set(extra)
          .send(body ?? {});
  return req.then((r) => ({ status: r.status, body: r.body }));
}

const codeOf = (response: Res) =>
  (response.body as { error?: { code?: string } }).error?.code ?? "";

function expectNotAllowed(response: Res) {
  const body = response.body as { error?: { message?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(codeOf(response), JSON.stringify(response.body)).toBe(NOT_ALLOWED);
  expect(body.error?.message ?? "").not.toBe("");
}

/** The shared-device guard did not refuse the request. */
function expectNotGuarded(response: Res) {
  expect(codeOf(response), JSON.stringify(response.body)).not.toBe(NOT_ALLOWED);
  expect(response.status, JSON.stringify(response.body)).not.toBe(403);
}

const BLOCKED: Array<{
  name: string;
  method: Method;
  path: string;
  body?: object;
}> = [
  {
    name: "update-user",
    method: "post",
    path: "/api/auth/update-user",
    body: { name: "Nama Baru" },
  },
  {
    name: "change-password",
    method: "post",
    path: "/api/auth/change-password",
    body: { currentPassword: PASSWORD, newPassword: "Another-password-456!" },
  },
  {
    name: "change-email",
    method: "post",
    path: "/api/auth/change-email",
    body: { newEmail: `new-${randomUUID()}@example.com` },
  },
  {
    name: "set-password",
    method: "post",
    path: "/api/auth/set-password",
    body: { newPassword: "Another-password-456!" },
  },
  { name: "list-sessions", method: "get", path: "/api/auth/list-sessions" },
  {
    name: "sessions (identity session list, not the keep-alive)",
    method: "get",
    path: "/api/auth/sessions",
  },
  {
    name: "revoke-session",
    method: "post",
    path: "/api/auth/revoke-session",
    body: { token: "x" },
  },
  {
    name: "revoke-sessions",
    method: "post",
    path: "/api/auth/revoke-sessions",
  },
  {
    name: "revoke-other-sessions",
    method: "post",
    path: "/api/auth/revoke-other-sessions",
  },
  {
    name: "delete-user",
    method: "post",
    path: "/api/auth/delete-user",
    body: { password: PASSWORD },
  },
  {
    name: "link-social",
    method: "post",
    path: "/api/auth/link-social",
    body: { provider: "google" },
  },
  {
    name: "unlink-account",
    method: "post",
    path: "/api/auth/unlink-account",
    body: { providerId: "google" },
  },
  {
    name: "admin/list-users",
    method: "get",
    path: "/api/auth/admin/list-users",
  },
  {
    name: "admin/set-role",
    method: "post",
    path: "/api/auth/admin/set-role",
    body: { userId: "x", role: "admin" },
  },
  {
    name: "admin/impersonate-user",
    method: "post",
    path: "/api/auth/admin/impersonate-user",
    body: { userId: "x" },
  },
  {
    name: "admin/stop-impersonating",
    method: "post",
    path: "/api/auth/admin/stop-impersonating",
  },
  {
    name: "two-factor/enable",
    method: "post",
    path: "/api/auth/two-factor/enable",
    body: { password: PASSWORD },
  },
  {
    name: "two-factor/disable",
    method: "post",
    path: "/api/auth/two-factor/disable",
    body: { password: PASSWORD },
  },
  {
    name: "two-factor/generate-backup-codes",
    method: "post",
    path: "/api/auth/two-factor/generate-backup-codes",
    body: { password: PASSWORD },
  },
  {
    name: "passkey/generate-register-options",
    method: "get",
    path: "/api/auth/passkey/generate-register-options",
  },
  {
    name: "passkey/list-user-passkeys",
    method: "get",
    path: "/api/auth/passkey/list-user-passkeys",
  },
  {
    name: "passkey/delete-passkey",
    method: "post",
    path: "/api/auth/passkey/delete-passkey",
    body: { id: "x" },
  },
  {
    name: "unknown path under /api/auth",
    method: "get",
    path: "/api/auth/not-a-real-endpoint",
  },
  {
    name: "callback/google (social sign-in/link callback)",
    method: "get",
    path: "/api/auth/callback/google",
  },
  {
    name: "login-challenges POST",
    method: "post",
    path: "/api/auth/login-challenges",
    body: {},
  },
];

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  await owner.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
    deviceIds,
  ]);
  await owner.end();
});

describe("1017 marked session on /api/auth/* (Better Auth)", () => {
  it.each(BLOCKED)(
    "refuses $name with 403 ACTING_STAFF_NOT_ALLOWED",
    async ({ method, path, body }) => {
      const { who } = await markedMember("Sesi Bertanda Auth");
      expectNotAllowed(await call(who.client, method, path, body));
    },
  );

  it("a refused call has no effect: update-user does not rename the user", async () => {
    const { who } = await markedMember("Nama Awal Auth");
    expectNotAllowed(
      await call(who.client, "post", "/api/auth/update-user", {
        name: "Nama Dibajak",
      }),
    );
    const { rows } = await owner.query<{ name: string }>(
      `SELECT name FROM "user" WHERE id = $1`,
      [who.userId],
    );
    expect(rows[0]!.name).toBe("Nama Awal Auth");
  });

  it("a refused revoke-other-sessions keeps the user's other sessions alive", async () => {
    const { who } = await markedMember("Sesi Lain Tetap");
    const other = agent(app);
    const signIn = await other
      .post("/api/auth/sign-in/email")
      .set(originHeader)
      .send({ email: who.email, password: PASSWORD });
    expect(signIn.status).toBe(200);
    expectNotAllowed(
      await call(who.client, "post", "/api/auth/revoke-other-sessions"),
    );
    expect((await other.get("/api/auth/get-session")).body?.user?.id).toBe(
      who.userId,
    );
  });

  it("refuses non-allowlisted paths regardless of case and trailing slash", async () => {
    const { who } = await markedMember("Sesi Bertanda Normalisasi");
    expectNotAllowed(
      await call(who.client, "post", "/api/auth/Update-User", { name: "X" }),
    );
    expectNotAllowed(
      await call(who.client, "post", "/api/auth/update-user/", { name: "X" }),
    );
    expectNotAllowed(await call(who.client, "get", "/api/auth/LIST-SESSIONS"));
    expectNotAllowed(
      await call(who.client, "get", "/api/auth/Admin/List-Users"),
    );
  });

  it("does not let a `..` segment smuggle a blocked path behind an allowed one", async () => {
    const { who } = await markedMember("Sesi Bertanda Dotdot");
    // Either the app's request-target check (400) or the guard (403) may stop
    // it; what matters is that update-user never runs.
    for (const path of [
      "/api/auth/get-session/%2e%2e/update-user",
      "/api/auth/sign-in/%2e%2e/update-user",
    ]) {
      const response = await call(who.client, "post", path, {
        name: "Dibajak Dotdot",
      });
      expect([400, 403], JSON.stringify(response.body)).toContain(
        response.status,
      );
    }
    const { rows } = await owner.query<{ name: string }>(
      `SELECT name FROM "user" WHERE id = $1`,
      [who.userId],
    );
    expect(rows[0]!.name).toBe("Sesi Bertanda Dotdot");
  });

  it("an unmarked session sending a flagged device's X-Device-Token is refused on update-user", async () => {
    const device = await newDevice(true);
    const who = await member("Sesi Token Perangkat");
    expectNotAllowed(
      await call(
        who.client,
        "post",
        "/api/auth/update-user",
        { name: "X" },
        {
          [DEVICE_TOKEN_HEADER]: tokenOf(device),
        },
      ),
    );
    expectNotAllowed(
      await call(who.client, "get", "/api/auth/list-sessions", undefined, {
        [DEVICE_TOKEN_HEADER]: tokenOf(device),
      }),
    );
  });

  describe("allowed paths still work for a marked session", () => {
    it("get-session returns the session", async () => {
      const { who } = await markedMember("Sesi Bertanda GetSession");
      const response = await call(who.client, "get", "/api/auth/get-session");
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body as { user?: { id?: string } }).user?.id).toBe(
        who.userId,
      );
    });

    it("get-session with a trailing slash and different case is still allowed", async () => {
      const { who } = await markedMember("Sesi Bertanda GetSession2");
      expectNotGuarded(await call(who.client, "get", "/api/auth/get-session/"));
      expectNotGuarded(await call(who.client, "get", "/api/auth/Get-Session"));
    });

    it("sign-in/email is not blocked and signs the other user in", async () => {
      const { who } = await markedMember("Sesi Bertanda SignIn");
      const other = await member("Pengguna Lain SignIn");
      const response = await call(
        who.client,
        "post",
        "/api/auth/sign-in/email",
        {
          email: other.email,
          password: PASSWORD,
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const after = await call(who.client, "get", "/api/auth/get-session");
      expect((after.body as { user?: { id?: string } }).user?.id).toBe(
        other.userId,
      );
    });

    it("a failed sign-in/email answers the normal 401, not the shared-device refusal", async () => {
      const { who } = await markedMember("Sesi Bertanda SignInGagal");
      const response = await call(
        who.client,
        "post",
        "/api/auth/sign-in/email",
        {
          email: `nobody-${randomUUID()}@example.com`,
          password: PASSWORD,
        },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(401);
      expectNotGuarded(response);
    });

    it("sessions/current/activity (keep-alive) passes on a marked management session and extends it (legend-hlmbk)", async () => {
      const { who } = await markedMember("Sesi Bertanda Activity");
      await owner.query(
        `UPDATE "session" SET kind = 'management', created_at = now() - interval '40 minutes',
           last_seen_at = now() - interval '28 minutes', expires_at = now() + interval '2 minutes'
         WHERE id = $1`,
        [who.sessionId],
      );
      const before = await owner.query<{ seen: Date }>(
        `SELECT last_seen_at AS seen FROM "session" WHERE id = $1`,
        [who.sessionId],
      );
      const response = await call(
        who.client,
        "post",
        "/api/auth/sessions/current/activity",
      );
      expect([200, 204], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expectNotGuarded(response);
      const after = await owner.query<{ seen: Date }>(
        `SELECT last_seen_at AS seen FROM "session" WHERE id = $1`,
        [who.sessionId],
      );
      expect(after.rows[0]!.seen.getTime()).toBeGreaterThan(
        before.rows[0]!.seen.getTime(),
      );
    });

    it("sessions/current/activity passes for an unmarked session sending a flagged device token", async () => {
      const device = await newDevice(true);
      const who = await member("Sesi Token Activity");
      await owner.query(
        `UPDATE "session" SET kind = 'management', created_at = now() - interval '40 minutes',
           last_seen_at = now() - interval '28 minutes', expires_at = now() + interval '2 minutes'
         WHERE id = $1`,
        [who.sessionId],
      );
      const response = await call(
        who.client,
        "post",
        "/api/auth/sessions/current/activity",
        undefined,
        { [DEVICE_TOKEN_HEADER]: tokenOf(device) },
      );
      expect([200, 204], JSON.stringify(response.body)).toContain(
        response.status,
      );
    });

    it("the keep-alive allowance does not open account changes: update-user and list-sessions stay 403 on the same session", async () => {
      const { who } = await markedMember("Sesi Bertanda Activity Tetap");
      await owner.query(
        `UPDATE "session" SET kind = 'management', created_at = now() - interval '40 minutes',
           last_seen_at = now() - interval '28 minutes', expires_at = now() + interval '2 minutes'
         WHERE id = $1`,
        [who.sessionId],
      );
      const keepAlive = await call(
        who.client,
        "post",
        "/api/auth/sessions/current/activity",
      );
      expect([200, 204], JSON.stringify(keepAlive.body)).toContain(
        keepAlive.status,
      );
      expectNotAllowed(
        await call(who.client, "post", "/api/auth/update-user", { name: "X" }),
      );
      expectNotAllowed(
        await call(who.client, "get", "/api/auth/list-sessions"),
      );
    });

    it("sessions/current/activity keeps its own rules on a marked session: no session 401, untrusted origin 403", async () => {
      expect(
        (await call(agent(app), "post", "/api/auth/sessions/current/activity"))
          .status,
      ).toBe(401);
      const { who } = await markedMember("Sesi Bertanda Activity Origin");
      const response = await who.client
        .post("/api/auth/sessions/current/activity")
        .set("Origin", "https://evil.example")
        .send({});
      expect(response.status).toBe(403);
    });

    it("sign-out ends the marked session", async () => {
      const { who } = await markedMember("Sesi Bertanda SignOut");
      const response = await call(who.client, "post", "/api/auth/sign-out");
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const after = await call(who.client, "get", "/api/auth/get-session");
      expect(after.body).toBeNull();
    });
  });
});

describe("1017 personal sessions and anonymous callers are unchanged", () => {
  it("a never-marked session can update-user and list-sessions", async () => {
    const who = await member("Sesi Pribadi");
    const update = await call(who.client, "post", "/api/auth/update-user", {
      name: "Nama Pribadi Baru",
    });
    expect(update.status, JSON.stringify(update.body)).toBe(200);
    expectNotGuarded(await call(who.client, "get", "/api/auth/list-sessions"));
    const list = await call(who.client, "get", "/api/auth/list-sessions");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
  });

  // 1027: any mark entry means shared device for the life of the session,
  // even one pointing at a device that is not (or no longer) flagged.
  it("a session carrying a mark on an unflagged device stays refused (fail closed, 1027)", async () => {
    const device = await newDevice(false);
    const who = await member("Sesi Perangkat Pribadi");
    await markSessionSharedDevice(who.sessionId, device);
    expectNotAllowed(
      await call(who.client, "post", "/api/auth/update-user", {
        name: "Tetap Ditolak",
      }),
    );
  });

  it("a session whose only mark lapsed (flag turned off) stays refused (fail closed, 1027)", async () => {
    const { who, device } = await markedMember("Sesi Tanda Lapuk");
    expectNotAllowed(
      await call(who.client, "post", "/api/auth/update-user", { name: "X" }),
    );
    await setFlag(device, false);
    expectNotAllowed(
      await call(who.client, "post", "/api/auth/update-user", {
        name: "Tetap Ditolak",
      }),
    );
  });

  it("a session sending an unflagged device's token is unaffected", async () => {
    const device = await newDevice(false);
    const who = await member("Sesi Token Pribadi");
    const update = await call(
      who.client,
      "post",
      "/api/auth/update-user",
      { name: "Token Pribadi" },
      { [DEVICE_TOKEN_HEADER]: tokenOf(device) },
    );
    expect(update.status, JSON.stringify(update.body)).toBe(200);
  });

  it("no session: update-user keeps Better Auth's own 401", async () => {
    const response = await call(agent(app), "post", "/api/auth/update-user", {
      name: "X",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expectNotGuarded(response);
  });

  it("no session with a flagged device token: not refused by this guard", async () => {
    const device = await newDevice(true);
    const response = await call(
      agent(app),
      "post",
      "/api/auth/update-user",
      { name: "X" },
      { [DEVICE_TOKEN_HEADER]: tokenOf(device) },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expectNotGuarded(response);
  });

  it("no session: sign-in/email still works", async () => {
    const other = await member("Pengguna Anonim SignIn");
    const response = await call(agent(app), "post", "/api/auth/sign-in/email", {
      email: other.email,
      password: PASSWORD,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });
});
