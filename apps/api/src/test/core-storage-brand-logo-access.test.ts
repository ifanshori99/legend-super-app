// Brand logo upload authorization (bead legend-a30j, resolver half): the
// brand logo is tenant-level. The storage request resolver mints a tenant-scope
// context only for an upload whose multipart purpose is exactly `brand_logo`
// and only when the caller holds `org.theme.manage` at TENANT scope. Real
// Better Auth session, PostgreSQL and RLS; a probe router calls the resolver
// the way core-storage.routes.ts does. Every refusal has a positive control.
//
// Assumptions: a refusal may surface as HTTP 403 (resolver throws) or as 200
// with allowed=false (authorize refuses); both count as refusal. Role grants
// are seeded straight into `roles`/`role_assignments`; the tenant_admin
// account is modelled by its relevant code `org.theme.manage` at tenant scope.
// "No outletId" means the body field is absent (multipart cannot send null);
// the probe hands authorize `null` for it, like the service does.
import { randomUUID } from "node:crypto";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { auth } from "../lib/auth.ts";
import { requireAuth } from "../middleware/auth.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import { createStorageRequestResolver } from "../services/core-storage-access.ts";
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
probe.post("/upload", async (req, res) => {
  const resolved = await resolveRequest(req);
  const body = req.body as {
    purpose: string;
    outletId?: string;
    sourceKind?: string;
  };
  res.json({
    scope: resolved.context.outletScope,
    allowed: await resolved.authorize(
      "upload",
      body.purpose as never,
      (body.outletId ?? null) as never,
      { sourceKind: (body.sourceKind ?? null) as never },
    ),
  });
});
app.use("/probe", probe);
app.use(errorHandler);

const owner = createOwnerPool();
const createdUsers: string[] = [];
const createdRoles: string[] = [];
let tenantB: SecondTenant;
let tenantBRoleId: string | null = null;

async function asOwner<T>(
  inTenant: string,
  work: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [inTenant],
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

async function grantRole(
  userId: string,
  permissions: string[],
  scope: Scope,
  inTenant: string = tenantId,
) {
  const roleId = randomUUID();
  if (inTenant === tenantId) createdRoles.push(roleId);
  else tenantBRoleId = roleId;
  await asOwner(inTenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        inTenant,
        `BrandLogo ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        inTenant,
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
  grants: { permissions: string[]; scope: Scope; inTenant?: string }[],
) {
  const client = agent(app as never);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  for (const grant of grants)
    await grantRole(userId, grant.permissions, grant.scope, grant.inTenant);
  return client;
}

type Actor = Awaited<ReturnType<typeof signedIn>>;
const upload = (
  actor: Actor,
  body: { purpose: string; outletId?: string; sourceKind?: string },
) => actor.post("/probe/upload").set(originHeader).send(body);

type Res = { status: number; body: unknown };
const bodyOf = (res: Res) =>
  res.body as { allowed?: boolean; scope?: { kind?: string } };

function expectAllowedAtTenantScope(res: Res) {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(bodyOf(res).allowed).toBe(true);
  expect(bodyOf(res).scope).toMatchObject({ kind: "tenant" });
}
/** Refused outright (403) or answered with allowed=false. */
function expectRefused(res: Res) {
  expect([200, 403], JSON.stringify(res.body)).toContain(res.status);
  expect(res.status === 200 && bodyOf(res).allowed === true).toBe(false);
}
/** Refused, and never handed a tenant-wide scope. */
function expectRefusedWithoutTenantScope(res: Res) {
  expectRefused(res);
  expect(bodyOf(res).scope?.kind).not.toBe("tenant");
}

let tenantAdmin: Actor;
let menuManagerA: Actor;
let themeManagerAtOutletA: Actor;
let nobody: Actor;
let otherTenantAdmin: Actor;
let menuAndThemeAdmin: Actor;

beforeAll(async () => {
  requireDisposableDatabase();
  tenantB = await createSecondTenant(owner, "brand-logo-access");
  tenantAdmin = await signedIn("BrandLogoTenantAdmin", [
    { permissions: ["org.theme.manage"], scope: { type: "tenant" } },
  ]);
  menuManagerA = await signedIn("BrandLogoMenuManagerA", [
    {
      permissions: ["menu.item.manage"],
      scope: { type: "outlet", id: outletA },
    },
  ]);
  themeManagerAtOutletA = await signedIn("BrandLogoThemeOutletA", [
    {
      permissions: ["org.theme.manage"],
      scope: { type: "outlet", id: outletA },
    },
  ]);
  nobody = await signedIn("BrandLogoNobody", []);
  // Holds the code, but in tenant B only: it grants nothing in tenant A.
  otherTenantAdmin = await signedIn("BrandLogoOtherTenant", [
    {
      permissions: ["org.theme.manage"],
      scope: { type: "tenant" },
      inTenant: tenantB.tenantId,
    },
  ]);
  menuAndThemeAdmin = await signedIn("BrandLogoMenuAndTheme", [
    {
      permissions: ["org.theme.manage", "menu.item.manage"],
      scope: { type: "tenant" },
    },
  ]);
});

afterAll(async () => {
  await asOwner(tenantId, async (client) => {
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
  });
  if (tenantB) {
    await asOwner(tenantB.tenantId, async (client) => {
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenantB.tenantId, createdUsers],
      );
      if (tenantBRoleId)
        await client.query(
          "DELETE FROM roles WHERE tenant_id = $1 AND id = $2",
          [tenantB.tenantId, tenantBRoleId],
        );
    });
  }
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  if (tenantB) await removeSecondTenant(owner, tenantB);
  await owner.end();
});

describe("legend-a30j brand logo upload resolver", () => {
  it("lets a tenant-wide org.theme.manage account upload a brand logo with no outlet, at tenant scope", async () => {
    const res = await upload(tenantAdmin, { purpose: "brand_logo" });
    expectAllowedAtTenantScope(res);
  });

  it("refuses a menu manager at outlet scope", async () => {
    // Positive control: the same account may still upload its own purpose.
    const control = await upload(menuManagerA, {
      purpose: "menu_photo",
      outletId: outletA,
    });
    expect(bodyOf(control).allowed).toBe(true);
    expectRefusedWithoutTenantScope(
      await upload(menuManagerA, { purpose: "brand_logo" }),
    );
  });

  it("refuses org.theme.manage held only at outlet scope", async () => {
    // Positive control: tenant scope with the same code passes.
    expectAllowedAtTenantScope(
      await upload(tenantAdmin, { purpose: "brand_logo" }),
    );
    expectRefusedWithoutTenantScope(
      await upload(themeManagerAtOutletA, { purpose: "brand_logo" }),
    );
    // An outlet-scoped theme manager gains nothing by naming its outlet.
    expectRefusedWithoutTenantScope(
      await upload(themeManagerAtOutletA, {
        purpose: "brand_logo",
        outletId: outletA,
      }),
    );
  });

  it("refuses an account with no permission", async () => {
    expectAllowedAtTenantScope(
      await upload(tenantAdmin, { purpose: "brand_logo" }),
    );
    expectRefusedWithoutTenantScope(
      await upload(nobody, { purpose: "brand_logo" }),
    );
  });

  it("refuses an account whose org.theme.manage grant belongs to another tenant", async () => {
    expectAllowedAtTenantScope(
      await upload(tenantAdmin, { purpose: "brand_logo" }),
    );
    expectRefusedWithoutTenantScope(
      await upload(otherTenantAdmin, { purpose: "brand_logo" }),
    );
  });

  it("refuses a brand logo that names an outlet, even for a tenant admin", async () => {
    // Positive control: the same account without an outlet passes.
    expectAllowedAtTenantScope(
      await upload(tenantAdmin, { purpose: "brand_logo" }),
    );
    expectRefused(
      await upload(tenantAdmin, { purpose: "brand_logo", outletId: outletA }),
    );
  });

  it("refuses a brand logo with a source kind", async () => {
    expectRefused(
      await upload(tenantAdmin, {
        purpose: "brand_logo",
        sourceKind: "attendance",
      }),
    );
  });

  it("refuses a menu photo without an outlet and never gives it tenant scope", async () => {
    // Positive control: with an outlet the manager is allowed.
    const control = await upload(menuManagerA, {
      purpose: "menu_photo",
      outletId: outletA,
    });
    expect(bodyOf(control).allowed).toBe(true);
    // Neither an outlet manager nor a tenant-wide holder of both codes gets in.
    expectRefusedWithoutTenantScope(
      await upload(menuManagerA, { purpose: "menu_photo" }),
    );
    expectRefusedWithoutTenantScope(
      await upload(menuAndThemeAdmin, { purpose: "menu_photo" }),
    );
    expectRefusedWithoutTenantScope(
      await upload(tenantAdmin, { purpose: "menu_photo" }),
    );
  });

  it("does not let a tenant admin reach tenant scope through another purpose", async () => {
    for (const purpose of ["selfie", "document", "receipt", "passport"])
      expectRefusedWithoutTenantScope(await upload(tenantAdmin, { purpose }));
  });

  it("answers 401 without a session", async () => {
    const res = await agent(app as never)
      .post("/probe/upload")
      .set(originHeader)
      .send({ purpose: "brand_logo" });
    expect(res.status).toBe(401);
  });
});
