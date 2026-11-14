// Storage request resolver (beads legend-tiie, legend-pszrm): upload/read
// authorization is decided per purpose, per action and per outlet from the
// caller's real role assignments. Reads are decided per stored object: the
// owner reads only while they still hold a code of the kind over the outlet,
// otherwise the caller needs a review code for the object's source kind over
// its outlet; legacy rows (no source kind) fall back
// to the strict manager codes. Real Better Auth session, PostgreSQL and RLS;
// a probe router calls the resolver the way core-storage.routes.ts does.
// Every refusal has a positive control first.
//
// Assumptions: a refused read may surface as HTTP 403 (resolver refuses) or as
// 200 with allowed=false (authorize refuses); both count as refusal. Role
// grants are seeded straight into `roles`/`role_assignments`.
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
  storageLegacyReadMap,
  storageLegacyUploadMap,
  storageSourcePermissionMap,
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
  const body = req.body as {
    purpose: string;
    outletId: string;
    sourceKind?: string;
  };
  res.json({
    scope: resolved.context.outletScope,
    allowed: await resolved.authorize(
      action,
      body.purpose as never,
      body.outletId,
      action === "read"
        ? { objectId: String(req.params.objectId) }
        : { sourceKind: (body.sourceKind ?? null) as never },
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
const createdObjects: string[] = [];
const userIds = new WeakMap<object, string>();
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
  userIds.set(client, userId);
  for (const grant of grants)
    await grantRole(userId, grant.permissions, grant.scope);
  return client;
}

type Actor = Awaited<ReturnType<typeof signedIn>>;
const upload = (
  actor: Actor,
  purpose: string,
  outletId: string,
  sourceKind?: string,
) =>
  actor
    .post("/probe/upload")
    .set(originHeader)
    .send({ purpose, outletId, ...(sourceKind ? { sourceKind } : {}) });

interface StoredObject {
  id: string;
  tenantId: string;
  outletId: string;
  purpose: string;
}

/** Seeds one stored object through the owner pool, with owner/source columns. */
async function seedObject(spec: {
  purpose: string;
  outletId: string;
  tenantId?: string;
  owner?: Actor | null;
  sourceKind?: string | null;
}): Promise<StoredObject> {
  const id = randomUUID();
  const objectTenant = spec.tenantId ?? tenantId;
  const sourceKind = spec.sourceKind ?? null;
  await asOwner(async (client) => {
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [objectTenant],
    );
    await client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          owner_user_id, source_kind, source_id)
       VALUES ($1, $2, $3, $4, $5, 'image/webp', 1024, $6, $7, $8)`,
      [
        objectTenant,
        spec.outletId,
        id,
        spec.purpose,
        `legend-pszrm/${id}.webp`,
        spec.owner ? userIds.get(spec.owner)! : null,
        sourceKind,
        sourceKind ? randomUUID() : null,
      ],
    );
  });
  createdObjects.push(id);
  return {
    id,
    tenantId: objectTenant,
    outletId: spec.outletId,
    purpose: spec.purpose,
  };
}

const read = (actor: Actor, object: StoredObject) =>
  actor
    .post(`/probe/read/${object.id}`)
    .set(originHeader)
    .send({ purpose: object.purpose, outletId: object.outletId });

const isAllowed = (res: { status: number; body: { allowed?: boolean } }) =>
  res.status === 200 && res.body.allowed === true;
function expectAllowed(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect((res.body as { allowed: boolean }).allowed).toBe(true);
}
function expectDenied(res: { status: number; body: unknown }) {
  expect([200, 403], JSON.stringify(res.body)).toContain(res.status);
  expect(
    isAllowed(res as { status: number; body: { allowed?: boolean } }),
    JSON.stringify(res.body),
  ).toBe(false);
}

let admin: Actor;
let menuManagerA: Actor;
let menuViewerA: Actor;
let clockerA: Actor;
let hrViewerA: Actor;
let nobody: Actor;
let employeeA: Actor;
let otherEmployeeA: Actor;
let purchasingReviewerA: Actor;
let purchasingRequesterA: Actor;
let reimbursementApproverA: Actor;
let attendanceManagerA: Actor;
let correctionApproverA: Actor;
let reconcilerA: Actor;
let broadReviewer: Actor;

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
  const atA = (permissions: string[]) => [
    { permissions, scope: { type: "outlet", id: outletA } as Scope },
  ];
  const employeeCodes = ["self.attendance.clock", "self.reimbursement.request"];
  employeeA = await signedIn("EmployeeA", atA(employeeCodes));
  otherEmployeeA = await signedIn("OtherEmployeeA", atA(employeeCodes));
  purchasingReviewerA = await signedIn(
    "PurchasingReviewerA",
    atA(["purchasing.invoice.match"]),
  );
  purchasingRequesterA = await signedIn(
    "PurchasingRequesterA",
    atA(["purchasing.request.create"]),
  );
  reimbursementApproverA = await signedIn(
    "ReimbursementApproverA",
    atA(["hr.reimbursement.approve"]),
  );
  attendanceManagerA = await signedIn(
    "AttendanceManagerA",
    atA(["hr.attendance.manage"]),
  );
  correctionApproverA = await signedIn(
    "CorrectionApproverA",
    atA(["hr.attendance_correction.approve"]),
  );
  reconcilerA = await signedIn("ReconcilerA", atA(["accounting.reconcile"]));
  broadReviewer = await signedIn("BroadReviewer", [
    {
      permissions: [
        "hr.attendance.manage",
        "hr.attendance_correction.approve",
        "hr.reimbursement.approve",
        "hr.employee.view",
        "purchasing.invoice.match",
        "accounting.reconcile",
      ],
      scope: { type: "tenant" },
    },
  ]);
});

afterAll(async () => {
  for (const owningTenant of [tenantId, tenantB?.tenantId]) {
    if (!owningTenant) continue;
    await asOwner(async (client) => {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        owningTenant,
      ]);
      await client.query(
        "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [owningTenant, createdObjects],
      );
    });
  }
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
  it("treats legacy leave attachments as private to their employee and outlet approver", async () => {
    const approverA = await signedIn("LegacyLeaveApproverA", [
      {
        permissions: ["hr.leave.approve"],
        scope: { type: "outlet", id: outletA },
      },
    ]);
    const approverB = await signedIn("LegacyLeaveApproverB", [
      {
        permissions: ["hr.leave.approve"],
        scope: { type: "outlet", id: outletB },
      },
    ]);
    const employeeId = randomUUID();
    const typeId = randomUUID();
    const requestIds: string[] = [];
    try {
      await asOwner(async (client) => {
        await client.query(
          `INSERT INTO employees
          (id, tenant_id, user_id, employee_no, full_name, home_outlet_id, employment_type, join_date)
          VALUES ($1,$2,$3,$4,'Leave employee',$5,'pkwtt','2024-01-01')`,
          [
            employeeId,
            tenantId,
            userIds.get(employeeA),
            `L-${employeeId.slice(0, 8).toUpperCase()}`,
            outletA,
          ],
        );
        await client.query(
          `INSERT INTO leave_types
          (id, tenant_id, code, name, paid, requires_attachment, policy)
          VALUES ($1,$2,$3,'Leave',true,true,'{}')`,
          [typeId, tenantId, `L-${typeId.slice(0, 8)}`],
        );
      });
      for (const sourceKind of [
        null,
        "employee_document",
        "employment_contract",
      ] as const) {
        const object = await seedObject({
          purpose: "document",
          outletId: outletA,
          owner: otherEmployeeA,
          sourceKind,
        });
        const requestId = randomUUID();
        requestIds.push(requestId);
        await asOwner(async (client) => {
          await client.query(
            `INSERT INTO leave_requests
            (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
             start_date, end_date, days, attachment_key, requested_by)
            VALUES ($1,$2,$3,$4,$5,2031,'2031-03-20','2031-03-20',1,$6,$7)`,
            [
              requestId,
              tenantId,
              outletA,
              employeeId,
              typeId,
              sourceKind === null ? object.id.toUpperCase() : object.id,
              userIds.get(employeeA),
            ],
          );
        });
        expectAllowed(await read(employeeA, object));
        expectAllowed(await read(approverA, object));
        expectDenied(await read(approverB, object));
        expectDenied(await read(otherEmployeeA, object));
        expectDenied(await read(hrViewerA, object));
        expectDenied(await read(admin, object));
      }
    } finally {
      await asOwner(async (client) => {
        await client.query(
          "DELETE FROM leave_requests WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
          [tenantId, requestIds],
        );
        await client.query(
          "DELETE FROM employees WHERE tenant_id = $1 AND id = $2",
          [tenantId, employeeId],
        );
        await client.query(
          "DELETE FROM leave_types WHERE tenant_id = $1 AND id = $2",
          [tenantId, typeId],
        );
      });
    }
  });

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
    // A selfie of someone else (no owner link to the clocker).
    const selfie = await seedObject({
      purpose: "selfie",
      outletId: outletA,
      owner: otherEmployeeA,
      sourceKind: "attendance",
    });
    // Positive control: hr.attendance.manage reads selfies.
    expectAllowed(await read(admin, selfie));
    expectDenied(await read(clockerA, selfie));
  });

  it("needs hr.employee.view to read a document and hr.employee.manage to upload one", async () => {
    const doc = await seedObject({
      purpose: "document",
      outletId: outletA,
      owner: otherEmployeeA,
      sourceKind: "employee_document",
    });
    expectAllowed(await read(hrViewerA, doc));
    const upload1 = await upload(hrViewerA, "document", outletA);
    expect(upload1.status, JSON.stringify(upload1.body)).toBe(403);
    expect((await upload(admin, "document", outletA)).body.allowed).toBe(true);
    expectDenied(await read(menuManagerA, doc));
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

  it("keeps every permission map to existing catalog codes", () => {
    const lists: (readonly string[])[] = [];
    for (const entry of Object.values(storageSourcePermissionMap))
      lists.push(entry.upload, entry.read);
    lists.push(...Object.values(storageLegacyUploadMap));
    lists.push(...Object.values(storageLegacyReadMap));
    expect(lists.length).toBeGreaterThan(0);
    for (const codes of lists)
      for (const code of codes) expect(PERMISSION_CODES).toContain(code);
    for (const entry of Object.values(storageSourcePermissionMap)) {
      expect(entry.upload.length).toBeGreaterThan(0);
      expect(entry.read.length).toBeGreaterThan(0);
    }
    // Every purpose has a strict legacy read list.
    for (const purpose of ["menu_photo", "selfie", "document", "receipt"]) {
      expect(storageLegacyReadMap[purpose as "selfie"].length).toBeGreaterThan(
        0,
      );
    }
    // Legacy uploads exist for every purpose except receipt, which needs a kind.
    for (const purpose of ["menu_photo", "selfie", "document"]) {
      expect(
        storageLegacyUploadMap[purpose as "selfie"].length,
      ).toBeGreaterThan(0);
    }
    expect(storageLegacyUploadMap.receipt).toEqual([]);
  });

  it("refuses a purchasing reviewer a reimbursement receipt but allows a purchase invoice receipt", async () => {
    const invoice = await seedObject({
      purpose: "receipt",
      outletId: outletA,
      owner: otherEmployeeA,
      sourceKind: "purchase_invoice",
    });
    const reimbursement = await seedObject({
      purpose: "receipt",
      outletId: outletA,
      owner: otherEmployeeA,
      sourceKind: "reimbursement",
    });
    // Positive control: same reviewer, same outlet, a purchase invoice.
    expectAllowed(await read(purchasingReviewerA, invoice));
    expectDenied(await read(purchasingReviewerA, reimbursement));
  });

  it("lets a reimbursement approver read a reimbursement receipt at A but not at B", async () => {
    const atA = await seedObject({
      purpose: "receipt",
      outletId: outletA,
      owner: employeeA,
      sourceKind: "reimbursement",
    });
    const atB = await seedObject({
      purpose: "receipt",
      outletId: outletB,
      owner: employeeA,
      sourceKind: "reimbursement",
    });
    expectAllowed(await read(reimbursementApproverA, atA));
    expectDenied(await read(reimbursementApproverA, atB));
    // Positive control: a tenant-wide approver reads the one at B.
    expectAllowed(await read(broadReviewer, atB));
  });

  it("lets an employee read their own selfie and receipt but not another user's", async () => {
    const ownSelfie = await seedObject({
      purpose: "selfie",
      outletId: outletA,
      owner: employeeA,
      sourceKind: "attendance",
    });
    const ownReceipt = await seedObject({
      purpose: "receipt",
      outletId: outletA,
      owner: employeeA,
      sourceKind: "reimbursement",
    });
    const otherSelfie = await seedObject({
      purpose: "selfie",
      outletId: outletA,
      owner: otherEmployeeA,
      sourceKind: "attendance",
    });
    const otherReceipt = await seedObject({
      purpose: "receipt",
      outletId: outletA,
      owner: otherEmployeeA,
      sourceKind: "reimbursement",
    });
    expectAllowed(await read(employeeA, ownSelfie));
    expectAllowed(await read(employeeA, ownReceipt));
    // The other employee holds the same codes, so only ownership differs.
    expectAllowed(await read(otherEmployeeA, otherSelfie));
    expectDenied(await read(employeeA, otherSelfie));
    expectDenied(await read(employeeA, otherReceipt));
  });

  it("refuses an object of the second tenant even for a tenant-wide grant", async () => {
    // Positive control: a tenant A object is readable by the same caller.
    const own = await seedObject({
      purpose: "receipt",
      outletId: outletA,
      owner: employeeA,
      sourceKind: "reimbursement",
    });
    expectAllowed(await read(broadReviewer, own));
    const foreign = await seedObject({
      purpose: "receipt",
      outletId: tenantB.outletId,
      tenantId: tenantB.tenantId,
      owner: null,
      sourceKind: "reimbursement",
    });
    expectDenied(await read(broadReviewer, foreign));
    expectDenied(await read(admin, foreign));
  });

  it("refuses a missing object", async () => {
    expectDenied(
      await read(broadReviewer, {
        id: randomUUID(),
        tenantId,
        outletId: outletA,
        purpose: "receipt",
      }),
    );
  });

  it("limits a legacy row (no owner, no source) to the strict manager codes", async () => {
    const legacySelfie = await seedObject({
      purpose: "selfie",
      outletId: outletA,
    });
    const legacyReceipt = await seedObject({
      purpose: "receipt",
      outletId: outletA,
    });
    // Positive controls: the strict manager codes read legacy rows.
    expectAllowed(await read(attendanceManagerA, legacySelfie));
    expectAllowed(await read(reconcilerA, legacyReceipt));
    // Kind-specific review codes do not apply to an unclassified row.
    expectDenied(await read(correctionApproverA, legacySelfie));
    expectDenied(await read(purchasingReviewerA, legacyReceipt));
  });

  it("needs self.reimbursement.request to upload a reimbursement receipt", async () => {
    expectAllowed(await upload(employeeA, "receipt", outletA, "reimbursement"));
    // Positive control: purchasing.request.create uploads its own kind.
    expectAllowed(
      await upload(
        purchasingRequesterA,
        "receipt",
        outletA,
        "purchase_invoice",
      ),
    );
    expectDenied(
      await upload(purchasingRequesterA, "receipt", outletA, "reimbursement"),
    );
  });

  it("refuses a receipt upload without a source kind for everyone", async () => {
    // Positive control: the same callers upload once a kind is given.
    expectAllowed(await upload(employeeA, "receipt", outletA, "reimbursement"));
    expectDenied(await upload(employeeA, "receipt", outletA));
    expectDenied(await upload(purchasingRequesterA, "receipt", outletA));
    expectDenied(await upload(admin, "receipt", outletA));
  });

  it("refuses a source kind that belongs to another purpose", async () => {
    // Positive control: the same caller, matching kind and purpose.
    expectAllowed(await upload(employeeA, "selfie", outletA, "attendance"));
    // employeeA holds both codes, so only the kind/purpose mismatch refuses.
    expectDenied(await upload(employeeA, "selfie", outletA, "reimbursement"));
    expectDenied(await upload(employeeA, "receipt", outletA, "attendance"));
  });

  // ---- legend-792: owner read needs a live grant; per-kind facility rules ----
  // Assumption: the facility photo kinds are stored with purpose "receipt"
  // (packages/shared storage source-kind map). Revoking = deleting the user's
  // role_assignments. Legacy rows (no kind) fall back to the legacy purpose
  // code (selfie: self.attendance.clock); a legacy receipt has no upload code.
  const atOutlet = (permissions: string[], outlet: string) => [
    { permissions, scope: { type: "outlet", id: outlet } as Scope },
  ];
  async function revokeAll(actor: Actor) {
    await asOwner(async (client) => {
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
        [tenantId, userIds.get(actor)],
      );
    });
  }

  const ownerKinds = [
    ["reimbursement", "self.reimbursement.request"],
    ["maintenance_ticket", "ops.equipment.maintain"],
    ["checklist_evidence", "ops.checklist.complete"],
    ["cleaning_task", "facility.booth.operate"],
  ] as const;

  for (const [kind, code] of ownerKinds) {
    it(`legend-792 ${kind}: owner is refused once ${code} is revoked`, async () => {
      const ownerUser = await signedIn(
        `Revoked-${kind}`,
        atOutlet([code], outletA),
      );
      const object = await seedObject({
        purpose: "receipt",
        outletId: outletA,
        owner: ownerUser,
        sourceKind: kind,
      });
      // Positive control: the owner with the live grant reads it.
      expectAllowed(await read(ownerUser, object));
      await revokeAll(ownerUser);
      expectDenied(await read(ownerUser, object));
    });

    it(`legend-792 ${kind}: owner with the code only at another outlet is refused`, async () => {
      const ownerUser = await signedIn(
        `OtherOutlet-${kind}`,
        atOutlet([code], outletB),
      );
      const atB = await seedObject({
        purpose: "receipt",
        outletId: outletB,
        owner: ownerUser,
        sourceKind: kind,
      });
      const atA = await seedObject({
        purpose: "receipt",
        outletId: outletA,
        owner: ownerUser,
        sourceKind: kind,
      });
      // Positive control: own object at the outlet where the grant lives.
      expectAllowed(await read(ownerUser, atB));
      expectDenied(await read(ownerUser, atA));
    });
  }

  it("legend-792 legacy selfie (no kind): owner is refused once the legacy code is revoked", async () => {
    const ownerUser = await signedIn(
      "RevokedLegacySelfie",
      atOutlet(["self.attendance.clock"], outletA),
    );
    const legacy = await seedObject({
      purpose: "selfie",
      outletId: outletA,
      owner: ownerUser,
    });
    expectAllowed(await read(ownerUser, legacy));
    await revokeAll(ownerUser);
    expectDenied(await read(ownerUser, legacy));
  });

  it("legend-792 legacy selfie: owner with the legacy code only at another outlet is refused", async () => {
    const ownerUser = await signedIn(
      "OtherOutletLegacySelfie",
      atOutlet(["self.attendance.clock"], outletB),
    );
    const atB = await seedObject({
      purpose: "selfie",
      outletId: outletB,
      owner: ownerUser,
    });
    const atA = await seedObject({
      purpose: "selfie",
      outletId: outletA,
      owner: ownerUser,
    });
    expectAllowed(await read(ownerUser, atB));
    expectDenied(await read(ownerUser, atA));
  });

  it("legend-792 maintenance_ticket: any ops.equipment.maintain holder or facility manager at the outlet reads it", async () => {
    const reporter = await signedIn(
      "TicketReporter",
      atOutlet(["ops.equipment.maintain"], outletA),
    );
    const teammateA = await signedIn(
      "TicketTeammateA",
      atOutlet(["ops.equipment.maintain"], outletA),
    );
    const teammateB = await signedIn(
      "TicketTeammateB",
      atOutlet(["ops.equipment.maintain"], outletB),
    );
    const facilityManagerA = await signedIn(
      "TicketFacilityManagerA",
      atOutlet(["facility.config.manage"], outletA),
    );
    const checklistStaffA = await signedIn(
      "TicketChecklistStaffA",
      atOutlet(["ops.checklist.complete"], outletA),
    );
    const ticket = await seedObject({
      purpose: "receipt",
      outletId: outletA,
      owner: reporter,
      sourceKind: "maintenance_ticket",
    });
    // Positive controls: owner, and the teammate who did not upload it.
    expectAllowed(await read(reporter, ticket));
    expectAllowed(await read(teammateA, ticket));
    expectAllowed(await read(facilityManagerA, ticket));
    // Denials: the same code at another outlet, and a different feature's code.
    expectDenied(await read(teammateB, ticket));
    expectDenied(await read(checklistStaffA, ticket));
  });

  it("legend-792 checklist_evidence: only the active owner or an ops.checklist.manage holder reads it", async () => {
    const completer = await signedIn(
      "EvidenceOwner",
      atOutlet(["ops.checklist.complete"], outletA),
    );
    const otherCompleter = await signedIn(
      "EvidenceOtherCompleter",
      atOutlet(["ops.checklist.complete"], outletA),
    );
    const managerA = await signedIn(
      "EvidenceManagerA",
      atOutlet(["ops.checklist.manage"], outletA),
    );
    const managerB = await signedIn(
      "EvidenceManagerB",
      atOutlet(["ops.checklist.manage"], outletB),
    );
    const evidenceA = await seedObject({
      purpose: "receipt",
      outletId: outletA,
      owner: completer,
      sourceKind: "checklist_evidence",
    });
    const evidenceB = await seedObject({
      purpose: "receipt",
      outletId: outletB,
      owner: completer,
      sourceKind: "checklist_evidence",
    });
    // Positive controls.
    expectAllowed(await read(completer, evidenceA));
    expectAllowed(await read(managerA, evidenceA));
    expectAllowed(await read(managerB, evidenceB));
    // Denials: peer with the same code, manager of the other outlet.
    expectDenied(await read(otherCompleter, evidenceA));
    expectDenied(await read(managerB, evidenceA));
    expectDenied(await read(managerA, evidenceB));
  });

  it("legend-792 cleaning_task: only the active owner or a facility.config.manage holder reads it", async () => {
    const operator = await signedIn(
      "CleaningOwner",
      atOutlet(["facility.booth.operate"], outletA),
    );
    const otherOperator = await signedIn(
      "CleaningOtherOperator",
      atOutlet(["facility.booth.operate"], outletA),
    );
    const managerA = await signedIn(
      "CleaningManagerA",
      atOutlet(["facility.config.manage"], outletA),
    );
    const managerB = await signedIn(
      "CleaningManagerB",
      atOutlet(["facility.config.manage"], outletB),
    );
    const taskA = await seedObject({
      purpose: "receipt",
      outletId: outletA,
      owner: operator,
      sourceKind: "cleaning_task",
    });
    const taskB = await seedObject({
      purpose: "receipt",
      outletId: outletB,
      owner: operator,
      sourceKind: "cleaning_task",
    });
    expectAllowed(await read(operator, taskA));
    expectAllowed(await read(managerA, taskA));
    expectAllowed(await read(managerB, taskB));
    expectDenied(await read(otherOperator, taskA));
    expectDenied(await read(managerB, taskA));
    expectDenied(await read(managerA, taskB));
  });

  it("legend-792 facility kinds: an object of the second tenant is refused for a tenant-wide holder", async () => {
    const wide = await signedIn("FacilityTenantWide", [
      {
        permissions: [
          "ops.equipment.maintain",
          "ops.checklist.manage",
          "facility.config.manage",
        ],
        scope: { type: "tenant" },
      },
    ]);
    for (const kind of [
      "maintenance_ticket",
      "checklist_evidence",
      "cleaning_task",
    ]) {
      const own = await seedObject({
        purpose: "receipt",
        outletId: outletA,
        owner: null,
        sourceKind: kind,
      });
      // Positive control: same caller reads the tenant A object.
      expectAllowed(await read(wide, own));
      const foreign = await seedObject({
        purpose: "receipt",
        outletId: tenantB.outletId,
        tenantId: tenantB.tenantId,
        owner: null,
        sourceKind: kind,
      });
      expectDenied(await read(wide, foreign));
    }
  });
});
