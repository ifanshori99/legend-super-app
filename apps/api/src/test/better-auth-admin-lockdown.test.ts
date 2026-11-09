// Better Auth admin plugin lockdown (legend-imdzn, tier K: auth).
// Role `admin` of Better Auth must not give a session the plugin's own
// cross-tenant user management endpoints (list-users, set-user-password,
// set-role, update-user, remove-user, ban-user, ...). Only the endpoints the
// product uses stay open: impersonate-user (platform admin registry + support
// grant), stop-impersonating, and has-permission (server calls only).
//
// Policy under test (lib/auth.ts hooks.before):
//   - Every `/api/auth/admin/*` request over HTTP, from any of the three actors
//     below, is refused with HTTP 403 and body.code = "ADMIN_ENDPOINT_DISABLED".
//   - Refused means no effect: the victim keeps the password, role, sessions
//     and the user row.
//   - Active platform admins keep `requirePermission({ notes: ["read-any"] })`
//     (server-side has-permission call) on the existing admin notes route.
//   - impersonate-user from a revoked platform admin stays 403.
//
// Assumptions (spec silent):
//   - Refusal body is the Better Auth APIError shape: { code, message } at the
//     top level of the JSON body (same as impersonation-grant.test.ts).
//   - `/api/admin/notes` is the existing route guarded by
//     requirePermission({ notes: ["read-any"] }) (see admin.test.ts).
//   - The three actors get the same refusal; a revoked admin is a user whose
//     `platform_admins.revoked_at` is set while `user.role` is still `admin`.
//   - Request bodies below use the documented Better Auth admin API shapes;
//     any 403 produced for another reason would not carry the lockdown code.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  cafeLegendPlatformFixtures,
  requestSupportAccessInputSchema,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { requestSupportAccess } from "../services/platform-support.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

const app = createApp();
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(4).toString("hex");
const VICTIM_PASSWORD = "Test-password-123!";
const ATTACKER_PASSWORD = "Hacked-password-999!";

const platformAdminIds: string[] = [];
const supportTenantUserIds: string[] = [];

type Client = ReturnType<typeof agent>;
type Actor = { client: Client; userId: string; email: string };
type Victim = { client: Client; userId: string; email: string };

async function sessionUserId(client: Client) {
  return (await client.get("/api/auth/get-session")).body.user.id as string;
}

/** (1) Active platform admin: role admin plus an active platform_admins row. */
async function newActiveAdmin(): Promise<Actor> {
  const client = agent(app);
  const email = await signUp(client, "Admin Platform Aktif");
  await setRole(email, "admin");
  const userId = await sessionUserId(client);
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
  platformAdminIds.push(userId);
  // /api/admin/* is MFA-only like /api/platform (AUTH-05).
  await verifySessionMfa(email);
  return { client, userId, email };
}

/** (2) Revoked admin: role admin kept, registry row has revoked_at set. */
async function newRevokedAdmin(): Promise<Actor> {
  const actor = await newActiveAdmin();
  await db.query(
    "UPDATE platform_admins SET revoked_at = now() WHERE user_id = $1",
    [actor.userId],
  );
  return actor;
}

/** (3) Better Auth role admin without any platform_admins row. */
async function newUnregisteredAdmin(): Promise<Actor> {
  const client = agent(app);
  const email = await signUp(client, "Admin Tanpa Registry");
  await setRole(email, "admin");
  const userId = await sessionUserId(client);
  return { client, userId, email };
}

/** A plain tenant-side user, the target of every attack. */
async function newVictim(): Promise<Victim> {
  const client = agent(app);
  const email = await signUp(client, `Korban ${unique()}`);
  return { client, userId: await sessionUserId(client), email };
}

async function userRow(userId: string) {
  const { rows } = await db.query(
    'SELECT id, role, name, banned FROM "user" WHERE id = $1',
    [userId],
  );
  return rows[0] as
    | { id: string; role: string | null; name: string; banned: boolean | null }
    | undefined;
}

async function signIn(email: string, password: string) {
  return agent(app)
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password });
}

/** The victim is untouched: same row, old password works, not banned. */
async function expectVictimUntouched(
  victim: Victim,
  before: NonNullable<Awaited<ReturnType<typeof userRow>>>,
) {
  const after = await userRow(victim.userId);
  expect(after).toBeDefined();
  expect(after?.role).toBe(before.role);
  expect(after?.name).toBe(before.name);
  expect(Boolean(after?.banned)).toBe(false);
  expect((await signIn(victim.email, VICTIM_PASSWORD)).status).toBe(200);
  expect((await signIn(victim.email, ATTACKER_PASSWORD)).status).not.toBe(200);
  // The victim's own session is still alive.
  expect(
    (await victim.client.get("/api/auth/get-session")).body?.user?.id,
  ).toBe(victim.userId);
}

type Attack = {
  name: string;
  send: (
    actor: Actor,
    victim: Victim,
    extra: { newEmail: string },
  ) => Promise<{
    status: number;
    body: { code?: string };
  }>;
  /** Extra proof that the attack had no effect. */
  verify?: (victim: Victim, extra: { newEmail: string }) => Promise<void>;
};

const post = (actor: Actor, path: string, body: object) =>
  actor.client.post(`/api/auth/admin/${path}`).set(originHeader).send(body);

const attacks: Attack[] = [
  {
    name: "GET list-users",
    send: (actor) =>
      actor.client.get("/api/auth/admin/list-users?limit=5").set(originHeader),
  },
  {
    name: "POST set-user-password",
    send: (actor, victim) =>
      post(actor, "set-user-password", {
        userId: victim.userId,
        newPassword: ATTACKER_PASSWORD,
      }),
  },
  {
    name: "POST set-role",
    send: (actor, victim) =>
      post(actor, "set-role", { userId: victim.userId, role: "admin" }),
  },
  {
    name: "POST update-user",
    send: (actor, victim) =>
      post(actor, "update-user", {
        userId: victim.userId,
        data: { name: "Diubah Penyerang" },
      }),
  },
  {
    name: "POST remove-user",
    send: (actor, victim) =>
      post(actor, "remove-user", { userId: victim.userId }),
  },
  {
    name: "POST ban-user",
    send: (actor, victim) =>
      post(actor, "ban-user", {
        userId: victim.userId,
        banReason: "uji lockdown",
      }),
  },
  {
    name: "POST create-user",
    send: (actor, _victim, { newEmail }) =>
      post(actor, "create-user", {
        email: newEmail,
        password: ATTACKER_PASSWORD,
        name: "Pengguna Buatan Penyerang",
        role: "admin",
      }),
    verify: async (_victim, { newEmail }) => {
      const { rowCount } = await db.query(
        'SELECT 1 FROM "user" WHERE email = $1',
        [newEmail],
      );
      expect(rowCount).toBe(0);
    },
  },
  {
    name: "POST revoke-user-sessions",
    send: (actor, victim) =>
      post(actor, "revoke-user-sessions", { userId: victim.userId }),
  },
  {
    name: "POST list-user-sessions",
    send: (actor, victim) =>
      post(actor, "list-user-sessions", { userId: victim.userId }),
  },
  {
    // has-permission is a server-only call: over HTTP it is closed too.
    name: "POST has-permission",
    send: (actor) =>
      post(actor, "has-permission", { permissions: { notes: ["read-any"] } }),
  },
];

const actors: Array<[string, () => Promise<Actor>]> = [
  ["an active platform admin", newActiveAdmin],
  ["a revoked platform admin", newRevokedAdmin],
  ["a Better Auth admin without a registry row", newUnregisteredAdmin],
];

afterAll(async () => {
  await db.query(
    "DELETE FROM support_access_grants WHERE super_admin_user_id = ANY($1::text[])",
    [platformAdminIds],
  );
  await db.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [cafeLegendPlatformFixtures.tenant.id, supportTenantUserIds],
  );
  await db.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [platformAdminIds],
  );
  await db.end();
});

describe("legend-imdzn Better Auth admin endpoints are closed over HTTP", () => {
  for (const [actorName, makeActor] of actors) {
    describe(actorName, () => {
      for (const attack of attacks) {
        it(`legend-imdzn ${attack.name} is refused with ADMIN_ENDPOINT_DISABLED and changes nothing`, async () => {
          const actor = await makeActor();
          const victim = await newVictim();
          const before = (await userRow(victim.userId))!;
          const extra = { newEmail: `lockdown-${unique()}@example.com` };

          const response = await attack.send(actor, victim, extra);

          expect(response.status).toBe(403);
          expect(response.body.code).toBe("ADMIN_ENDPOINT_DISABLED");
          await attack.verify?.(victim, extra);
          await expectVictimUntouched(victim, before);
        });
      }
    });
  }
});

describe("legend-imdzn the endpoints the product needs keep working", () => {
  it("legend-imdzn an active platform admin still passes requirePermission notes read-any", async () => {
    const owner = agent(app);
    await signUp(owner, "Pemilik Catatan");
    const note = (
      await owner
        .post("/api/notes")
        .set(originHeader)
        .send({ title: `Catatan ${unique()}` })
    ).body.data;

    const admin = await newActiveAdmin();
    const list = await admin.client.get("/api/admin/notes?limit=100");

    expect(list.status).toBe(200);
    expect(
      list.body.data.some((item: { id: string }) => item.id === note.id),
    ).toBe(true);
  });

  it("legend-imdzn a revoked platform admin cannot impersonate and stays signed in as themselves", async () => {
    const admin = await newRevokedAdmin();
    const victim = await newVictim();

    const response = await admin.client
      .post("/api/auth/admin/impersonate-user")
      .set(originHeader)
      .send({ userId: victim.userId });

    expect(response.status).toBe(403);
    expect(await sessionUserId(admin.client)).toBe(admin.userId);
  });

  it("legend-imdzn a normal user without the admin role gets a refusal on admin endpoints too", async () => {
    const intruder = agent(app);
    await signUp(intruder, "Pengguna Biasa");
    const victim = await newVictim();

    const response = await intruder
      .post("/api/auth/admin/set-user-password")
      .set(originHeader)
      .send({ userId: victim.userId, newPassword: ATTACKER_PASSWORD });

    expect(response.status).toBe(403);
    expect((await signIn(victim.email, VICTIM_PASSWORD)).status).toBe(200);
  });
});

// legend-atwse: /api/admin/notes must follow the platform admin registry, not
// only user.role. A revoked admin (role kept, revoked_at set) and a role admin
// without a registry row must get 403 and must not read or delete other
// tenants' notes. An active platform admin keeps GET 200 and DELETE 204.
// Assumption: 403 is the refusal status (same as the other admin routes here).
async function newVictimNote(victim: Victim) {
  const response = await victim.client
    .post("/api/notes")
    .set(originHeader)
    .send({ title: `Catatan korban ${unique()}` });
  expect(response.status).toBe(201);
  return response.body.data as { id: string; title: string };
}

async function victimStillHasNote(victim: Victim, noteId: string) {
  return (await victim.client.get(`/api/notes/${noteId}`)).status === 200;
}

const notesGuardActors: Array<[string, () => Promise<Actor>]> = [
  ["a revoked platform admin", newRevokedAdmin],
  ["a Better Auth admin without a registry row", newUnregisteredAdmin],
];

describe("legend-atwse admin notes routes follow the platform admin registry", () => {
  for (const [actorName, makeActor] of notesGuardActors) {
    describe(actorName, () => {
      it("legend-atwse GET /api/admin/notes is refused with 403 and leaks no notes", async () => {
        const victim = await newVictim();
        const note = await newVictimNote(victim);
        const actor = await makeActor();

        const response = await actor.client.get("/api/admin/notes?limit=100");

        expect(response.status).toBe(403);
        expect(JSON.stringify(response.body)).not.toContain(note.title);
        expect(JSON.stringify(response.body)).not.toContain(victim.email);
      });

      it("legend-atwse DELETE /api/admin/notes/:id is refused with 403 and the note stays", async () => {
        const victim = await newVictim();
        const note = await newVictimNote(victim);
        const actor = await makeActor();

        const response = await actor.client
          .delete(`/api/admin/notes/${note.id}`)
          .set(originHeader);

        expect(response.status).toBe(403);
        expect(await victimStillHasNote(victim, note.id)).toBe(true);
      });
    });
  }

  describe("an active platform admin", () => {
    it("legend-atwse GET /api/admin/notes returns 200 with the victim's note", async () => {
      const victim = await newVictim();
      const note = await newVictimNote(victim);
      const admin = await newActiveAdmin();

      const response = await admin.client.get("/api/admin/notes?limit=100");

      expect(response.status).toBe(200);
      expect(
        response.body.data.some((item: { id: string }) => item.id === note.id),
      ).toBe(true);
    });

    it("legend-atwse DELETE /api/admin/notes/:id returns 204 and removes the note", async () => {
      const victim = await newVictim();
      const note = await newVictimNote(victim);
      const admin = await newActiveAdmin();

      const response = await admin.client
        .delete(`/api/admin/notes/${note.id}`)
        .set(originHeader);

      expect(response.status).toBe(204);
      expect(await victimStillHasNote(victim, note.id)).toBe(false);
    });
  });

  // Assumption: the spec names no error code for a missing second factor on
  // /api/admin/*; the router uses requireSessionMfa(), so the refusal is
  // 403 with error.code MFA_REQUIRED (as on /api/platform).
  describe("an active platform admin without a verified second factor", () => {
    async function newActiveAdminWithoutMfa(): Promise<Actor> {
      const client = agent(app);
      const email = await signUp(client, "Admin Tanpa MFA");
      await setRole(email, "admin");
      const userId = await sessionUserId(client);
      await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
        userId,
      ]);
      platformAdminIds.push(userId);
      return { client, userId, email };
    }

    it("legend-atwse GET /api/admin/notes is refused with MFA_REQUIRED and leaks no notes", async () => {
      const victim = await newVictim();
      const note = await newVictimNote(victim);
      const admin = await newActiveAdminWithoutMfa();

      const response = await admin.client.get("/api/admin/notes?limit=100");

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("MFA_REQUIRED");
      expect(JSON.stringify(response.body)).not.toContain(note.title);
      expect(JSON.stringify(response.body)).not.toContain(victim.email);
    });

    it("legend-atwse DELETE /api/admin/notes/:id is refused with MFA_REQUIRED and the note stays", async () => {
      const victim = await newVictim();
      const note = await newVictimNote(victim);
      const admin = await newActiveAdminWithoutMfa();

      const response = await admin.client
        .delete(`/api/admin/notes/${note.id}`)
        .set(originHeader);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("MFA_REQUIRED");
      expect(await victimStillHasNote(victim, note.id)).toBe(true);
    });
  });

  // An impersonated session is the tenant user, never a platform admin, even
  // when the impersonating admin is active and has a support grant.
  describe("an impersonated support session", () => {
    async function newImpersonatingAdmin(): Promise<Actor> {
      const tenantId = cafeLegendPlatformFixtures.tenant.id;
      const target = await newVictim();
      supportTenantUserIds.push(target.userId);
      await db.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
         SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
         WHERE tenant_id = $1 AND template_key = 'owner'`,
        [tenantId, target.userId],
      );
      const admin = await newActiveAdmin();
      const now = new Date();
      await requestSupportAccess({
        tenantId,
        actorUserId: admin.userId,
        request: requestSupportAccessInputSchema.parse({
          reason: "Menelusuri keluhan pelanggan atas pengaturan domain tenant.",
          mfaCode: "123456",
        }),
        mfaVerifiedAt: now.toISOString(),
        now,
      });
      const started = await admin.client
        .post("/api/auth/admin/impersonate-user")
        .set(originHeader)
        .send({ userId: target.userId });
      expect(started.status).toBe(200);
      // The client now carries the impersonated session of the tenant user.
      await verifySessionMfa(target.email);
      return admin;
    }

    it("legend-atwse GET /api/admin/notes is refused with 403 and leaks no notes", async () => {
      const victim = await newVictim();
      const note = await newVictimNote(victim);
      const support = await newImpersonatingAdmin();

      const response = await support.client.get("/api/admin/notes?limit=100");

      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain(note.title);
      expect(JSON.stringify(response.body)).not.toContain(victim.email);
    });

    it("legend-atwse DELETE /api/admin/notes/:id is refused with 403 and the note stays", async () => {
      const victim = await newVictim();
      const note = await newVictimNote(victim);
      const support = await newImpersonatingAdmin();

      const response = await support.client
        .delete(`/api/admin/notes/${note.id}`)
        .set(originHeader);

      expect(response.status).toBe(403);
      expect(await victimStillHasNote(victim, note.id)).toBe(true);
    });
  });
});
