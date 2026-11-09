// Storage request resolver (bead legend-tiie): upload/read authorization is
// decided per purpose, per action and per outlet from the caller's real role
// assignments. Real Better Auth session, PostgreSQL and RLS; a probe router
// calls the resolver the way core-storage.routes.ts does. Every refusal has a
// positive control first.
import { randomUUID } from "node:crypto";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSION_CODES } from "@starter/shared/access";
import { outletIdSchema } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { auth } from "../lib/auth.ts";
import { requireAuth } from "../middleware/auth.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import {
  createStorageRequestResolver,
  storagePermissionMap,
} from "../services/core-storage-access.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createOwnerPool,
  createSecondTenant,
  removeSecondTenant,
  requireDisposableDatabase,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);

const resolveRequest = createStorageRequestResolver();
const app = express();
app.all("/api/auth/*splat", toNodeHandler(auth));
app.use(express.json());
const probe = express.Router();
probe.use(
  requireAuth,
  tenantContext({
    resolveDomain: async () => null,
    verifyCredential: async () => ({
      tenantId,
      brandId: null,
      source: "session",
    }),
  }),
);
// Same resolver call as the real handlers: the upload route has no objectId,
// the signed-URL route has one.
async function answer(
  req: express.Request,
  res: express.Response,
  action: "upload" | "read",
) {
  const resolved = await resolveRequest(req);
  const body = req.body as { purpose: string; outletId: string };
  res.json({
    scope: resolved.context.outletScope,
    allowed: await resolved.authorize(
      action,
      body.purpose as never,
      body.outletId,
      action === "read" ? String(req.params.objectId) : undefined,
    ),
  });
}
probe.post("/upload", (req, res) => answer(req, res, "upload"));
probe.post("/read/:objectId", (req, res) => answer(req, res, "read"));
app.use("/probe", probe);
app.use(errorHandler);

const owner = createOwnerPool();
const createdUsers: string[] = [];
const createdRoles: string[] = [];
let tenantB: SecondTenant;

async function asOwner<T>(
  work: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Scope = { type: "tenant" } | { type: "outlet"; id: string };

async function grantRole(userId: string, permissions: string[], scope: Scope) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `StorageAccess ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenantId,
        userId,
        roleId,
        scope.type,
        scope.type === "tenant" ? null : scope.id,
      ],
    );
  });
}

async function signedIn(
  name: string,
  grants: { permissions: string[]; scope: Scope }[],
) {
  const client = agent(app as never);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  for (const grant of grants)
    await grantRole(userId, grant.permissions, grant.scope);
  return client;
}

type Actor = Awaited<ReturnType<typeof signedIn>>;
const upload = (actor: Actor, purpose: string, outletId: string) =>
  actor.post("/probe/upload").set(originHeader).send({ purpose, outletId });
const read = (actor: Actor, purpose: string, outletId: string) =>
  actor
    .post(`/probe/read/${randomUUID()}`)
    .set(originHeader)
    .send({ purpose, outletId });

let admin: Actor;
let menuManagerA: Actor;
let menuViewerA: Actor;
let clockerA: Actor;
let hrViewerA: Actor;
let nobody: Actor;

beforeAll(async () => {
  requireDisposableDatabase();
  tenantB = await createSecondTenant(owner, "storage-access");
  admin = await signedIn("StorageAdmin", [
    {
      permissions: [
        "menu.item.manage",
        "menu.item.view",
        "hr.employee.view",
        "hr.employee.manage",
        "hr.attendance.manage",
      ],
      scope: { type: "tenant" },
    },
  ]);
  menuManagerA = await signedIn("MenuManagerA", [
    {
      permissions: ["menu.item.manage"],
      scope: { type: "outlet", id: outletA },
    },
  ]);
  menuViewerA = await signedIn("MenuViewerA", [
    { permissions: ["menu.item.view"], scope: { type: "outlet", id: outletA } },
  ]);
  clockerA = await signedIn("ClockerA", [
    {
      permissions: ["self.attendance.clock"],
      scope: { type: "outlet", id: outletA },
    },
  ]);
  hrViewerA = await signedIn("HrViewerA", [
    {
      permissions: ["hr.employee.view"],
      scope: { type: "outlet", id: outletA },
    },
  ]);
  nobody = await signedIn("Nobody", []);
});

afterAll(async () => {
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  if (tenantB) await removeSecondTenant(owner, tenantB);
  await owner.end();
});

describe("legend-tiie storage request resolver", () => {
  it("lets a tenant-wide menu manager upload a menu photo at any outlet", async () => {
    for (const outlet of [outletA, outletB]) {
      const res = await upload(admin, "menu_photo", outlet);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.allowed).toBe(true);
    }
  });

  it("refuses a menu photo upload without menu.item.manage (view only)", async () => {
    // Positive control: the manager at the same outlet is allowed.
    const control = await upload(menuManagerA, "menu_photo", outletA);
    expect(control.body.allowed).toBe(true);
    // No outlet is reachable for this action, so no scope is minted at all.
    const res = await upload(menuViewerA, "menu_photo", outletA);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("refuses an outlet A grant at outlet B and keeps B out of the scope", async () => {
    const atA = await upload(menuManagerA, "menu_photo", outletA);
    expect(atA.body.allowed).toBe(true);
    expect(atA.body.scope).toMatchObject({
      kind: "outlets",
      outletIds: [outletA],
    });
    const atB = await upload(menuManagerA, "menu_photo", outletB);
    expect(atB.body.allowed).toBe(false);
  });

  it("allows a selfie upload with self.attendance.clock but refuses the read without an HR code", async () => {
    const up = await upload(clockerA, "selfie", outletA);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.allowed).toBe(true);
    const denied = await read(clockerA, "selfie", outletA);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    // Positive control: hr.attendance.manage reads selfies.
    const allowed = await read(admin, "selfie", outletA);
    expect(allowed.body.allowed).toBe(true);
  });

  it("needs hr.employee.view to read a document and hr.employee.manage to upload one", async () => {
    const read1 = await read(hrViewerA, "document", outletA);
    expect(read1.body.allowed).toBe(true);
    const upload1 = await upload(hrViewerA, "document", outletA);
    expect(upload1.status, JSON.stringify(upload1.body)).toBe(403);
    expect((await upload(admin, "document", outletA)).body.allowed).toBe(true);
    expect((await read(menuManagerA, "document", outletA)).status).toBe(403);
  });

  it("refuses an outlet of another tenant even for a tenant-wide grant", async () => {
    // Positive control: own tenant outlet is allowed.
    expect((await upload(admin, "menu_photo", outletA)).body.allowed).toBe(
      true,
    );
    const res = await upload(admin, "menu_photo", tenantB.outletId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(JSON.stringify(res.body.scope)).not.toContain(tenantB.outletId);
  });

  it("denies unknown purposes and an account without any storage permission", async () => {
    const unknown = await upload(admin, "passport", outletA);
    expect(unknown.body.allowed).toBe(false);
    const none = await upload(nobody, "menu_photo", outletA);
    expect(none.status).toBe(403);
  });

  it("answers 401 without a session", async () => {
    const res = await agent(app as never)
      .post("/probe/upload")
      .set(originHeader)
      .send({ purpose: "menu_photo", outletId: outletA });
    expect(res.status).toBe(401);
  });

  it("keeps the permission table to existing catalog codes for every purpose and action", () => {
    for (const purpose of ["menu_photo", "selfie", "document", "receipt"]) {
      const entry = storagePermissionMap[purpose as "menu_photo"];
      for (const codes of [entry.upload, entry.read]) {
        expect(codes.length).toBeGreaterThan(0);
        for (const code of codes) expect(PERMISSION_CODES).toContain(code);
      }
    }
  });
});
