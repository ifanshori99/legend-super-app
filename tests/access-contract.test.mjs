// RBAC contract tests (WS-00, bead legend-0mc): permission catalog, the 18
// role templates of PRD v1.7 §3.7 and their "Batas Akses" limits, scope model
// tenant/brand/outlet/station (TEN-03), time-bound assignments, MFA (AUTH-05),
// approval matrix + POS overrides (AUTH-06), grant rules, events and the Cafe
// Legend fixtures. Loaded with plain Node ESM (type stripping, no resolve hook).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as access from "../packages/shared/src/access/index.ts";
import * as core from "../packages/shared/src/core/index.ts";
import * as server from "../packages/shared/src/core/server.ts";

const fx = access.cafeLegendAccessFixtures;
const { bandung, bandung2 } = fx.outletIds;
const station = (code) => fx.stations.find((row) => row.code === code).id;
const roleId = (key) => fx.roles.find((role) => role.templateKey === key).id;
const principal = (userKey, tenantId = fx.tenantId) => ({
  tenantId,
  userId: fx.users[userKey].id,
  assignments: fx.assignments,
});
const check = (userKey, permission, target, extra = {}) =>
  access.authorize({
    principal: principal(userKey),
    roles: fx.roleGrants,
    org: fx.org,
    permission,
    target,
    now: fx.now,
    surface: "back_office",
    mfaVerified: true,
    ...extra,
  });
const outlet = (id) => ({ type: "outlet", id });
const tenant = { type: "tenant" };
const template = (key) => access.roleTemplate(key);
const tagged = (key, tag) =>
  template(key).permissions.filter((code) =>
    access.permissionHasTag(code, tag),
  );
const throwsCode = (fn, code) =>
  assert.throws(fn, (error) => {
    assert.ok(error instanceof access.AccessError, String(error));
    assert.equal(error.code, code);
    return true;
  });

describe("permission catalog", () => {
  test("is well formed and holds the PRD §6 example codes", () => {
    access.assertCatalogWellFormed();
    assert.ok(access.isPermissionCode("pos.void.approve"));
    assert.ok(access.isPermissionCode("payroll.lock"));
    assert.ok(!access.isPermissionCode("pos.everything"));
    assert.ok(access.PERMISSION_CODES.length >= 100);
  });

  test("tenant permission schema rejects platform and unknown codes", () => {
    assert.ok(
      access.tenantPermissionCodeSchema.safeParse("pos.sale.create").success,
    );
    assert.ok(
      !access.tenantPermissionCodeSchema.safeParse("platform.tenant.manage")
        .success,
    );
    assert.ok(!access.tenantPermissionCodeSchema.safeParse("x.y.z").success);
  });
});

describe("role templates (PRD §3.7 table)", () => {
  test("exactly the 18 templates, every permission from the catalog", () => {
    assert.equal(access.ROLE_TEMPLATES.length, 18);
    assert.deepEqual(
      access.ROLE_TEMPLATES.map((row) => row.defaultName),
      [
        "Super Admin",
        "Owner / Direksi",
        "Shareholder",
        "Admin Tenant",
        "General Manager",
        "Outlet Manager",
        "Supervisor / Captain",
        "Kasir",
        "Waiter / Runner",
        "Barista / Cook",
        "Attendant Fasilitas",
        "Kitchen Lead",
        "Purchasing",
        "Gudang",
        "Finance / Akuntan",
        "HR",
        "Marketing / CRM",
        "Karyawan",
      ],
    );
    for (const row of access.ROLE_TEMPLATES)
      for (const code of [...row.permissions, ...row.optionalPermissions])
        assert.ok(access.isPermissionCode(code), `${row.key}: ${code}`);
  });

  test("Super Admin is platform-only; tenant templates hold no platform permission", () => {
    const superAdmin = template("super_admin");
    assert.equal(superAdmin.level, "platform");
    assert.deepEqual(superAdmin.allowedScopeTypes, []);
    assert.ok(
      superAdmin.permissions.every((code) =>
        access.permissionHasTag(code, "platform"),
      ),
    );
    for (const row of access.ROLE_TEMPLATES.filter((r) => r.level === "tenant"))
      assert.deepEqual(tagged(row.key, "platform"), [], row.key);
  });

  test("Batas Akses limits hold", () => {
    // Shareholder: only aggregate + own data, no customer/employee personal data.
    for (const tag of [
      "customer_pii",
      "employee_pii",
      "payroll",
      "bulk_export",
    ])
      assert.deepEqual(tagged("shareholder", tag), [], `shareholder ${tag}`);
    // Admin Tenant: no automatic finance authority.
    for (const tag of ["finance", "payroll", "payment"])
      assert.deepEqual(tagged("tenant_admin", tag), [], `tenant_admin ${tag}`);
    // ...but it reaches the /kelola area where access is managed (C10 decision).
    assert.ok(
      template("tenant_admin").permissions.includes(
        "dashboard.management.view",
      ),
    );
    assert.ok(
      template("tenant_admin").permissions.includes("access.role.assign"),
    );
    // General Manager: does not change payroll data.
    assert.deepEqual(tagged("general_manager", "payroll"), []);
    // Outlet Manager: assigned outlet only.
    assert.deepEqual(template("outlet_manager").allowedScopeTypes, ["outlet"]);
    // Supervisor: no financial reports.
    assert.deepEqual(tagged("supervisor", "finance"), []);
    assert.ok(
      !template("supervisor").permissions.includes("report.financial.view"),
    );
    // Kasir: no reports, cannot approve.
    assert.ok(
      !template("cashier").permissions.some((c) => c.startsWith("report.")),
    );
    assert.deepEqual(tagged("cashier", "approve"), []);
    // Waiter: no payment unless allowed (optional permission, off by default).
    assert.deepEqual(tagged("waiter", "payment"), []);
    assert.deepEqual(template("waiter").optionalPermissions, [
      "pos.payment.accept",
    ]);
    // Barista / Cook: KDS of the assigned station only. ai.ask is the one
    // exception: every staff role may ask the assistant (TL-10, AI-06).
    assert.deepEqual(template("barista_cook").allowedScopeTypes, ["station"]);
    assert.ok(
      template("barista_cook").permissions.every(
        (c) => c.startsWith("kds.") || c === "ai.ask",
      ),
    );
    // Attendant Fasilitas: facility module only, no payment unless allowed.
    // Plus ai.ask for all staff (TL-10, AI-06).
    assert.ok(
      template("facility_attendant").permissions.every(
        (c) =>
          c.startsWith("facility.") ||
          c === "ops.checklist.complete" ||
          c === "ai.ask",
      ),
    );
    assert.deepEqual(tagged("facility_attendant", "payment"), []);
    // Kitchen Lead: no payment.
    assert.deepEqual(tagged("kitchen_lead", "payment"), []);
    // Purchasing: no payroll.
    assert.deepEqual(tagged("purchasing", "payroll"), []);
    // Gudang: no selling price, no financial reports.
    assert.deepEqual(tagged("warehouse", "sell_price"), []);
    assert.deepEqual(tagged("warehouse", "finance"), []);
    // Finance: no customer personal data.
    assert.deepEqual(tagged("finance", "customer_pii"), []);
    // HR: no operational finance.
    assert.deepEqual(tagged("hr", "finance"), []);
    assert.deepEqual(tagged("hr", "payment"), []);
    // Marketing: no bulk export except the approval request (DASH-04).
    assert.deepEqual(tagged("marketing", "bulk_export"), [
      "export.personal_data.request",
    ]);
    // Karyawan: own data only.
    assert.ok(
      template("employee").permissions.every(
        (c) => c.startsWith("self.") || c === "ai.ask",
      ),
    );
  });

  test("AUTH-05: management, finance, HR, owner, shareholder and Super Admin require MFA", () => {
    for (const key of [
      "super_admin",
      "owner",
      "shareholder",
      "tenant_admin",
      "general_manager",
      "outlet_manager",
      "finance",
      "hr",
    ])
      assert.equal(template(key).mfaRequired, true, key);
    for (const key of ["cashier", "waiter", "barista_cook", "employee"])
      assert.equal(template(key).mfaRequired, false, key);
    // Any template reaching sensitive data requires MFA too.
    for (const row of access.ROLE_TEMPLATES)
      if (access.permissionsRequireMfa(row.permissions))
        assert.equal(row.mfaRequired, true, row.key);
  });
});

describe("fixtures (FE mock mode)", () => {
  test("parse against the schemas, also after a JSON round trip", () => {
    const json = JSON.parse(JSON.stringify(fx));
    for (const role of json.roles) access.roleSchema.parse(role);
    for (const row of json.assignments) access.roleAssignmentSchema.parse(row);
    access.approvalMatrixSchema.parse(json.approvalPolicies);
    assert.equal(fx.roles.filter((r) => r.isTemplate).length, 17);
    assert.ok(fx.roles.every((role) => role.tenantId === fx.tenantId));
  });
});

describe("authorize: deny by default, scope, time-bound (TEN-03)", () => {
  test("no assignment, unknown role, other tenant → denied", () => {
    const stranger = {
      tenantId: fx.tenantId,
      userId: "f0f0f0f0-0000-4000-8000-000000000001",
      assignments: fx.assignments,
    };
    assert.deepEqual(
      access.authorize({
        principal: stranger,
        roles: fx.roleGrants,
        org: fx.org,
        permission: "order.view",
        target: outlet(bandung),
        now: fx.now,
        surface: "pos",
        mfaVerified: false,
      }),
      { allowed: false, reason: "no_active_assignment" },
    );
    const otherTenant = principal(
      "owner",
      "0b6f1c2e-7d4a-4c1e-9a3b-000000000000",
    );
    assert.equal(
      access.authorize({
        principal: otherTenant,
        roles: fx.roleGrants,
        org: fx.org,
        permission: "order.view",
        target: tenant,
        now: fx.now,
        surface: "back_office",
        mfaVerified: true,
      }).allowed,
      false,
    );
    assert.equal(
      check("cashier", "order.view", outlet(bandung), { roles: [] }).allowed,
      false,
    );
  });

  test("cashier: own outlet only, no payroll", () => {
    assert.equal(
      check("cashier", "pos.payment.accept", outlet(bandung)).allowed,
      true,
    );
    assert.deepEqual(check("cashier", "pos.payment.accept", outlet(bandung2)), {
      allowed: false,
      reason: "out_of_scope",
    });
    assert.deepEqual(check("cashier", "payroll.view", tenant), {
      allowed: false,
      reason: "permission_not_granted",
    });
    assert.equal(check("cashier", "pos.payment.accept", tenant).allowed, false);
  });

  test("station scope: barista sees only the assigned station", () => {
    const kds = { surface: "kds", mfaVerified: false };
    assert.equal(
      check(
        "barista",
        "kds.ticket.process",
        { type: "station", id: station("bar_kopi") },
        kds,
      ).allowed,
      true,
    );
    assert.equal(
      check(
        "barista",
        "kds.ticket.process",
        { type: "station", id: station("dapur_panas") },
        kds,
      ).allowed,
      false,
    );
    assert.equal(
      check("barista", "kds.ticket.process", outlet(bandung), kds).allowed,
      false,
    );
    assert.deepEqual(
      access.stationReachOf({
        principal: principal("barista"),
        roles: fx.roleGrants,
        org: fx.org,
        now: fx.now,
        permission: "kds.ticket.process",
      }),
      [station("bar_kopi")],
    );
    assert.equal(
      access.stationReachOf({
        principal: principal("kitchenLead"),
        roles: fx.roleGrants,
        org: fx.org,
        now: fx.now,
        permission: "kds.ticket.process",
      }).length,
      4, // every Bandung station (legend-7art: aligned to the menu fixtures)
    );
  });

  test("brand scope reaches the brand's outlets, not tenant-wide targets", () => {
    assert.equal(
      check("generalManager", "report.sales.view", outlet(bandung2)).allowed,
      true,
    );
    assert.equal(
      check("generalManager", "report.sales.view", {
        type: "brand",
        id: fx.brandId,
      }).allowed,
      true,
    );
    assert.equal(
      check("generalManager", "report.sales.view", tenant).allowed,
      false,
    );
  });

  test("unknown outlet or station fails closed", () => {
    const ghost = "6a2d4f80-1c3e-4b5a-9d7f-000000000000";
    assert.equal(check("owner", "order.view", outlet(ghost)).allowed, false);
    assert.equal(
      check("generalManager", "order.view", outlet(ghost)).allowed,
      false,
    );
    assert.equal(
      check("outletManager", "order.view", { type: "station", id: ghost })
        .allowed,
      false,
    );
  });

  test("time-bound: ended and future assignments grant nothing", () => {
    const target = outlet(bandung2);
    assert.equal(
      check("supervisor", "inventory.adjustment.approve", target).allowed,
      false,
    );
    assert.equal(
      check("supervisor", "inventory.adjustment.approve", target, {
        now: new Date("2026-10-15T05:00:00.000Z"),
      }).allowed,
      true,
    );
    const start = new Date("2026-12-01T00:00:00.000Z");
    assert.equal(
      check("supervisor2", "pos.void.approve", target).allowed,
      false,
    );
    assert.equal(
      check("supervisor2", "pos.void.approve", target, { now: start }).allowed,
      true,
    );
    // validUntil is exclusive.
    assert.equal(
      access.isAssignmentActive(
        {
          validFrom: "2026-10-01T00:00:00.000Z",
          validUntil: "2026-10-31T17:00:00.000Z",
        },
        new Date("2026-10-31T17:00:00.000Z"),
      ),
      false,
    );
    assert.ok(
      !access.roleAssignmentSchema.safeParse({
        ...fx.assignments[0],
        validUntil: fx.assignments[0].validFrom,
      }).success,
    );
  });

  test("outlet reach feeds core outlet scope (TEN-03)", () => {
    const reach = (userKey, permission) =>
      access.outletReachOf({
        principal: principal(userKey),
        roles: fx.roleGrants,
        org: fx.org,
        now: fx.now,
        permission,
      });
    assert.deepEqual(reach("owner"), { kind: "tenant" });
    assert.deepEqual(
      reach("generalManager").outletIds.sort(),
      [bandung, bandung2].sort(),
    );
    assert.equal(reach("barista"), null);
    assert.equal(reach("cashier", "report.financial.view"), null);
    const scopeData = reach("cashier", "pos.payment.accept");
    const ctx = server.establishTenantContext({
      tenantId: fx.tenantId,
      brandId: null,
      source: "session",
    });
    const scope = server.establishOutletScope(ctx, scopeData);
    assert.equal(core.isOutletInScope(scope, bandung), true);
    assert.equal(core.isOutletInScope(scope, bandung2), false);
  });
});

describe("AUTH-05: MFA roles on back office and dashboard", () => {
  test("finance is denied without a second factor, allowed with it", () => {
    assert.deepEqual(
      check("finance", "accounting.journal.view", tenant, {
        mfaVerified: false,
      }),
      { allowed: false, reason: "mfa_required" },
    );
    assert.equal(
      check("finance", "accounting.journal.view", tenant).allowed,
      true,
    );
    throwsCode(
      () =>
        access.assertAuthorized({
          principal: principal("finance"),
          roles: fx.roleGrants,
          org: fx.org,
          permission: "accounting.journal.view",
          target: tenant,
          now: fx.now,
          surface: "dashboard",
          mfaVerified: false,
        }),
      "MFA_REQUIRED",
    );
  });

  test("surface guard: back office and dashboard need MFA, POS PIN surfaces do not", () => {
    const base = { roles: fx.roleGrants, now: fx.now, mfaVerified: false };
    throwsCode(
      () =>
        access.assertSurfaceAccess({
          ...base,
          principal: principal("hr"),
          surface: "back_office",
        }),
      "MFA_REQUIRED",
    );
    throwsCode(
      () =>
        access.assertSurfaceAccess({
          ...base,
          principal: principal("shareholder"),
          surface: "dashboard",
        }),
      "MFA_REQUIRED",
    );
    access.assertSurfaceAccess({
      ...base,
      principal: principal("cashier"),
      surface: "back_office",
    });
    access.assertSurfaceAccess({
      ...base,
      principal: principal("outletManager"),
      surface: "pos",
    });
    assert.equal(
      access.userRequiresMfa(principal("owner"), fx.roleGrants, fx.now),
      true,
    );
    assert.equal(
      access.userRequiresMfa(principal("waiter"), fx.roleGrants, fx.now),
      false,
    );
    // Outlet Manager approves a void at the POS with the PIN, no MFA prompt.
    assert.equal(
      check("outletManager", "pos.void.approve", outlet(bandung), {
        surface: "pos",
        mfaVerified: false,
      }).allowed,
      true,
    );
  });
});

describe("approval matrix (§3.7) and POS overrides (AUTH-06)", () => {
  const policies = fx.approvalPolicies;
  const req = (action, amount) =>
    access.approvalRequirementFor(policies, action, amount);

  test("threshold tiers pick the highest applicable tier", () => {
    assert.deepEqual(req("void", 15_000).steps, [
      { level: 1, approverRoleIds: [roleId("supervisor")] },
    ]);
    assert.deepEqual(req("discount", 30_000), { required: false });
    assert.equal(req("discount", 50_000).thresholdIdr, 50_000);
    assert.deepEqual(req("discount", 250_000).steps, [
      { level: 1, approverRoleIds: [roleId("outlet_manager")] },
    ]);
    // Unknown amount: fail closed to the highest tier.
    assert.equal(req("discount", null).thresholdIdr, 200_000);
    assert.equal(req("refund", 600_000).steps.length, 2);
    assert.equal(req("refund", 100_000).steps.length, 1);
    assert.deepEqual(req("payroll", 250_000_000).steps, [
      { level: 1, approverRoleIds: [roleId("hr")] },
      { level: 2, approverRoleIds: [roleId("finance"), roleId("owner")] },
    ]);
  });

  test("no policy → APPROVAL_POLICY_MISSING (deny by default)", () => {
    throwsCode(() => req("leave", null), "APPROVAL_POLICY_MISSING");
  });

  test("matrix schema: distinct actor is mandatory, levels contiguous", () => {
    const row = policies[0];
    assert.ok(
      !access.approvalPolicySchema.safeParse({
        ...row,
        requiresDistinctActor: false,
      }).success,
    );
    assert.ok(
      !access.approvalMatrixSchema.safeParse([{ ...row, levels: 2 }]).success,
    );
    assert.ok(
      !access.approvalPolicySchema.safeParse({ ...row, thresholdIdr: -1 })
        .success,
    );
    assert.ok(access.APPROVAL_ACTION_TYPES.includes("mcp_action"));
    for (const action of [
      "void",
      "discount",
      "refund",
      "expense",
      "purchase_order",
      "stock_adjustment",
      "price_change",
      "payroll",
      "dividend_distribution",
      "ai_action",
      "mcp_action",
    ])
      assert.ok(access.APPROVAL_ACTION_TYPES.includes(action), action);
  });

  const decide = (approverKey, overrides = {}) =>
    access.assertApprovalDecisionAllowed({
      requirement: req("void", 20_000),
      requestedBy: fx.users.cashier.id,
      priorDecisions: [],
      level: 1,
      approver: principal(approverKey),
      approverRoles: fx.roleGrants,
      approverMfaVerified: false,
      surface: "pos",
      target: outlet(bandung),
      org: fx.org,
      now: fx.now,
      ...overrides,
    });

  test("approver must differ from requester and hold the step role in scope", () => {
    decide("supervisor");
    throwsCode(
      () => decide("supervisor", { requestedBy: fx.users.supervisor.id }),
      "APPROVER_IS_REQUESTER",
    );
    throwsCode(
      () => decide("cashier", { requestedBy: fx.users.waiter.id }),
      "APPROVER_ROLE_MISMATCH",
    );
    throwsCode(
      () => decide("supervisor", { target: outlet(bandung2) }),
      "APPROVER_ROLE_MISMATCH",
    );
    throwsCode(
      () => decide("supervisor", { level: 2 }),
      "APPROVAL_LEVEL_OUT_OF_ORDER",
    );
  });

  test("two-level payroll: distinct people per level, MFA on the dashboard", () => {
    const payroll = {
      requirement: req("payroll", 250_000_000),
      requestedBy: fx.users.employee.id,
      surface: "dashboard",
      target: tenant,
    };
    decide("hr", { ...payroll, approverMfaVerified: true });
    const afterHr = [{ level: 1, approverId: fx.users.hr.id }];
    throwsCode(
      () =>
        decide("hr", {
          ...payroll,
          level: 2,
          priorDecisions: afterHr,
          approverMfaVerified: true,
        }),
      "APPROVER_ALREADY_DECIDED",
    );
    throwsCode(
      () =>
        decide("finance", { ...payroll, level: 2, priorDecisions: afterHr }),
      "MFA_REQUIRED",
    );
    decide("finance", {
      ...payroll,
      level: 2,
      priorDecisions: afterHr,
      approverMfaVerified: true,
    });
    decide("owner", {
      ...payroll,
      level: 2,
      priorDecisions: afterHr,
      approverMfaVerified: true,
    });
  });

  test("override record: requester, approver, reason, value; approver ≠ requester", () => {
    const record = {
      id: "01JBQ7Z8K3M4N5P6Q7R8S9T0W1",
      outletId: bandung,
      action: "void",
      requestedBy: fx.users.cashier.id,
      approvedBy: fx.users.supervisor.id,
      method: "supervisor_pin",
      reasonCode: "salah_input",
      reason: "Salah input menu",
      valueIdr: 28_000,
      approvalRequestId: null,
      occurredAt: "2026-11-01T05:10:00.000Z",
    };
    access.posOverrideSchema.parse(record);
    assert.ok(
      !access.posOverrideSchema.safeParse({
        ...record,
        approvedBy: record.requestedBy,
      }).success,
    );
    assert.ok(
      !access.posOverrideSchema.safeParse({ ...record, reason: " " }).success,
    );
    assert.ok(
      !access.posOverrideSchema.safeParse({ ...record, valueIdr: -1 }).success,
    );
    const withoutReason = { ...record };
    delete withoutReason.reason;
    assert.ok(!access.posOverrideSchema.safeParse(withoutReason).success);
  });
});

describe("role grants (§3.7 Pemberian Role)", () => {
  const cashierRole = () => {
    const role = fx.roles.find((r) => r.templateKey === "cashier");
    return {
      ...role,
      level: "tenant",
      allowedScopeTypes: role.allowedScopeTypes,
    };
  };
  const grant = (overrides = {}) =>
    access.assertCanGrantRole({
      grantor: principal("owner"),
      grantorRoles: fx.roleGrants,
      grantorMfaVerified: true,
      grantorReauthenticatedAt: new Date(fx.now.getTime() - 60_000),
      granteeUserId: fx.users.employee.id,
      role: cashierRole(),
      scope: { type: "outlet", id: bandung },
      org: fx.org,
      now: fx.now,
      ...overrides,
    });

  test("owner with recent re-auth and MFA may grant", () => {
    assert.ok(grant());
  });

  test("self-grant, stale re-auth, platform role, wrong scope, no permission → refused", () => {
    throwsCode(
      () => grant({ granteeUserId: fx.users.owner.id }),
      "SELF_ELEVATION_FORBIDDEN",
    );
    throwsCode(
      () => grant({ grantorReauthenticatedAt: null }),
      "REAUTH_REQUIRED",
    );
    throwsCode(
      () =>
        grant({
          grantorReauthenticatedAt: new Date(fx.now.getTime() - 6 * 60_000),
        }),
      "REAUTH_REQUIRED",
    );
    throwsCode(
      () => grant({ role: { ...cashierRole(), level: "platform" } }),
      "ROLE_NOT_ASSIGNABLE",
    );
    throwsCode(
      () =>
        grant({ role: { ...cashierRole(), allowedScopeTypes: ["station"] } }),
      "ROLE_SCOPE_NOT_ALLOWED",
    );
    throwsCode(
      () => grant({ grantor: principal("cashier") }),
      "PERMISSION_DENIED",
    );
    throwsCode(() => grant({ grantorMfaVerified: false }), "MFA_REQUIRED");
  });

  test("1230 re-auth stamped by the API clock 40 ms ahead of the DB clock counts as just now; 10 s ahead is refused", () => {
    assert.ok(
      grant({ grantorReauthenticatedAt: new Date(fx.now.getTime() + 40) }),
    );
    assert.ok(
      grant({
        grantorReauthenticatedAt: new Date(
          fx.now.getTime() + access.REAUTH_CLOCK_SKEW_TOLERANCE_MS,
        ),
      }),
    );
    throwsCode(
      () =>
        grant({
          grantorReauthenticatedAt: new Date(fx.now.getTime() + 10_000),
        }),
      "REAUTH_REQUIRED",
    );
    throwsCode(
      () =>
        grant({
          grantorReauthenticatedAt: new Date(
            fx.now.getTime() + access.REAUTH_CLOCK_SKEW_TOLERANCE_MS + 1,
          ),
        }),
      "REAUTH_REQUIRED",
    );
    assert.equal(access.REAUTH_CLOCK_SKEW_TOLERANCE_MS <= 2_000, true);
  });

  test("custom roles: catalog only, sensitive permissions force MFA", () => {
    throwsCode(
      () => access.normalizeCustomRolePermissions(["platform.tenant.manage"]),
      "PERMISSION_NOT_IN_CATALOG",
    );
    throwsCode(
      () => access.normalizeCustomRolePermissions(["pos.anything"]),
      "PERMISSION_NOT_IN_CATALOG",
    );
    assert.deepEqual(
      access.normalizeCustomRolePermissions(["order.view", "order.view"]),
      { permissions: ["order.view"], mfaRequired: false },
    );
    assert.equal(
      access.normalizeCustomRolePermissions(["report.financial.view"])
        .mfaRequired,
      true,
    );
  });

  test("§3.7 custom-role edits may only add permissions the editor holds", () => {
    const edit = (userKey, addedPermissions, overrides = {}) =>
      access.assertCanEditCustomRole({
        grantor: principal(userKey),
        grantorRoles: fx.roleGrants,
        grantorMfaVerified: true,
        grantorReauthenticatedAt: null,
        addedPermissions,
        org: fx.org,
        now: fx.now,
        ...overrides,
      });
    // The Owner holds every tenant permission, so no re-auth is needed.
    assert.doesNotThrow(() => edit("owner", ["audit.log.view"]));
    // Admin Tenant does not hold finance permissions...
    throwsCode(
      () => edit("tenantAdmin", ["payroll.view"]),
      "SELF_ELEVATION_FORBIDDEN",
    );
    // ...unless MFA is verified and it re-authenticated within five minutes.
    assert.doesNotThrow(() =>
      edit("tenantAdmin", ["payroll.view"], {
        grantorReauthenticatedAt: new Date(fx.now.getTime() - 60_000),
      }),
    );
    throwsCode(
      () =>
        edit("tenantAdmin", ["payroll.view"], {
          grantorReauthenticatedAt: new Date(fx.now.getTime() - 6 * 60_000),
        }),
      "SELF_ELEVATION_FORBIDDEN",
    );
    throwsCode(
      () =>
        edit("tenantAdmin", ["payroll.view"], {
          grantorMfaVerified: false,
          grantorReauthenticatedAt: fx.now,
        }),
      "SELF_ELEVATION_FORBIDDEN",
    );
    // Without access.role.manage there is no edit path at all.
    throwsCode(() => edit("cashier", ["pos.sale.create"]), "PERMISSION_DENIED");
    // No added permission means no grant decision (rename / remove only).
    assert.doesNotThrow(() => edit("tenantAdmin", []));
  });

  test("client inputs never carry the tenant (TEN-02)", () => {
    const input = {
      userId: fx.users.employee.id,
      roleId: roleId("cashier"),
      scope: { type: "outlet", id: bandung },
    };
    assert.ok(access.grantRoleSchema.safeParse(input).success);
    assert.ok(
      !access.grantRoleSchema.safeParse({ ...input, tenantId: fx.tenantId })
        .success,
    );
    assert.ok(
      !access.grantRoleSchema.safeParse({
        ...input,
        scope: { type: "tenant", id: bandung },
      }).success,
    );
    assert.ok(
      !access.createCustomRoleSchema.safeParse({
        name: "X",
        permissions: ["platform.tenant.manage"],
        allowedScopeTypes: ["outlet"],
      }).success,
    );
  });
});

describe("access events", () => {
  test("names follow <aggregate>.<past_verb> and payloads parse", () => {
    for (const type of access.ACCESS_EVENT_TYPES)
      assert.match(type, /^[a-z_]+\.[a-z_]+$/);
    access.ACCESS_EVENT_PAYLOADS["role_assignment.granted"].parse({
      assignmentId: fx.assignments[0].id,
      userId: fx.users.owner.id,
      roleId: roleId("owner"),
      scope: { type: "tenant", id: null },
      validFrom: "2026-10-15T02:00:00.000Z",
      validUntil: null,
      grantedBy: fx.users.tenantAdmin.id,
      reauthenticatedAt: "2026-10-15T01:59:00.000Z",
    });
    access.ACCESS_EVENT_PAYLOADS["approval_policy.changed"].parse({
      actionType: "void",
      before: [],
      after: fx.approvalPolicies.filter((row) => row.actionType === "void"),
    });
  });
});

describe("security regression: fail closed", () => {
  test("AUTH-05 missing approver role metadata cannot bypass MFA", () => {
    const requirement = access.approvalRequirementFor(
      fx.approvalPolicies,
      "payroll",
      250_000_000,
    );
    throwsCode(
      () =>
        access.assertApprovalDecisionAllowed({
          requirement,
          requestedBy: fx.users.employee.id,
          priorDecisions: [],
          level: 1,
          approver: principal("hr"),
          approverRoles: [],
          approverMfaVerified: false,
          surface: "dashboard",
          target: tenant,
          org: fx.org,
          now: fx.now,
        }),
      "APPROVER_ROLE_MISMATCH",
    );
  });

  test("AUTH-05 unknown active role cannot bypass MFA when another role grants access", () => {
    const roles = fx.roleGrants.filter((role) => role.id !== roleId("hr"));
    const hr = principal("hr");
    const cashierAssignment = fx.assignments.find(
      (row) => row.userId === fx.users.cashier.id,
    );
    const combined = {
      ...hr,
      assignments: [
        ...hr.assignments,
        { ...cashierAssignment, userId: hr.userId },
      ],
    };
    assert.equal(
      access.authorize({
        principal: combined,
        roles,
        org: fx.org,
        permission: "pos.sale.create",
        target: outlet(bandung),
        now: fx.now,
        surface: "back_office",
        mfaVerified: false,
      }).allowed,
      false,
    );
  });

  test("approval rejects invalid monetary amounts", () => {
    for (const amount of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(
        () =>
          access.approvalRequirementFor(
            fx.approvalPolicies,
            "discount",
            amount,
          ),
        RangeError,
      );
  });

  test("approval cannot advance from an out-of-order prior decision", () => {
    const requirement = access.approvalRequirementFor(
      fx.approvalPolicies,
      "payroll",
      250_000_000,
    );
    throwsCode(
      () =>
        access.assertApprovalDecisionAllowed({
          requirement,
          requestedBy: fx.users.employee.id,
          priorDecisions: [{ level: 2, approverId: fx.users.hr.id }],
          level: 2,
          approver: principal("finance"),
          approverRoles: fx.roleGrants,
          approverMfaVerified: true,
          surface: "dashboard",
          target: tenant,
          org: fx.org,
          now: fx.now,
        }),
      "APPROVAL_LEVEL_OUT_OF_ORDER",
    );
  });

  test("invalid assignment start never becomes active", () => {
    assert.equal(
      access.isAssignmentActive(
        { validFrom: "invalid", validUntil: null },
        fx.now,
      ),
      false,
    );
  });
});

test("TEN-03 tenant assignments reject outlet and station targets absent from org", () => {
  const scope = { type: "tenant", id: null };
  assert.equal(
    access.scopeCovers(scope, { type: "outlet", id: "unknown" }, fx.org),
    false,
  );
  assert.equal(
    access.scopeCovers(scope, { type: "station", id: "unknown" }, fx.org),
    false,
  );
});

test("AUTH-06 role assignment cannot delegate permissions grantor does not hold", () => {
  const role = fx.roles.find((r) => r.templateKey === "owner");
  assert.throws(() =>
    access.assertCanGrantRole({
      grantor: principal("tenantAdmin"),
      grantorRoles: fx.roleGrants,
      grantorMfaVerified: true,
      grantorReauthenticatedAt: fx.now,
      granteeUserId: fx.users.employee.id,
      role: { ...role, level: "tenant" },
      scope: { type: "tenant", id: null },
      org: fx.org,
      now: fx.now,
    }),
  );
});

test("TEN-03 station scope does not grant outlet-wide query reach", () => {
  assert.equal(
    access.outletReachOf({
      principal: principal("barista"),
      roles: fx.roleGrants,
      org: fx.org,
      now: fx.now,
    }),
    null,
  );
});

test("TEN-03 brand targets require tenant-owned brand inventory, including empty brands", () => {
  const empty = "6a2d4f80-1c3e-4b5a-9d7f-000000000001";
  const ghost = "6a2d4f80-1c3e-4b5a-9d7f-000000000002";
  const org = { ...fx.org, brands: [...(fx.org.brands ?? []), { id: empty }] };
  const tenantScope = { type: "tenant", id: null };
  assert.equal(
    access.scopeCovers(tenantScope, { type: "brand", id: empty }, org),
    true,
  );
  assert.equal(
    access.scopeCovers(tenantScope, { type: "brand", id: ghost }, org),
    false,
  );
  assert.equal(
    access.scopeCovers(
      { type: "brand", id: ghost },
      { type: "brand", id: ghost },
      org,
    ),
    false,
  );
});

// Coordinator decision (legend-cyu.10): tenant top authority (Owner / Admin
// Tenant, MFA + re-auth <= 5 min) may grant any non-platform tenant role in its
// tenant except Owner; everyone else must hold every delegated permission.
describe("AUTH-06 role grants: tenant top authority vs delegated permissions", () => {
  const templateRole = (key) => {
    const role = fx.roles.find((r) => r.templateKey === key);
    return { ...role, level: "tenant" };
  };
  const tenantScope = { type: "tenant", id: null };
  const grantBy = (userKey, overrides = {}) =>
    access.assertCanGrantRole({
      grantor: principal(userKey),
      grantorRoles: fx.roleGrants,
      grantorMfaVerified: true,
      grantorReauthenticatedAt: new Date(fx.now.getTime() - 60_000),
      granteeUserId: fx.users.employee.id,
      role: templateRole("finance"),
      scope: tenantScope,
      org: fx.org,
      now: fx.now,
      ...overrides,
    });

  test("AUTH-06 Admin Tenant may assign Finance although it lacks Finance permissions", () => {
    const admin = templateRole("tenant_admin");
    const finance = templateRole("finance");
    assert.ok(
      finance.permissions.some((p) => !admin.permissions.includes(p)),
      "fixture premise: Finance holds permissions Admin Tenant does not",
    );
    assert.ok(grantBy("tenantAdmin"));
  });

  test("AUTH-06 top authority still needs MFA, fresh re-auth, no self-grant, no platform role", () => {
    throwsCode(
      () => grantBy("tenantAdmin", { grantorMfaVerified: false }),
      "MFA_REQUIRED",
    );
    throwsCode(
      () =>
        grantBy("tenantAdmin", {
          grantorReauthenticatedAt: new Date(fx.now.getTime() - 6 * 60_000),
        }),
      "REAUTH_REQUIRED",
    );
    throwsCode(
      () => grantBy("tenantAdmin", { granteeUserId: fx.users.tenantAdmin.id }),
      "SELF_ELEVATION_FORBIDDEN",
    );
    const superAdmin = fx.roles.find((r) => r.templateKey === "super_admin");
    if (superAdmin)
      throwsCode(
        () =>
          grantBy("tenantAdmin", {
            role: { ...superAdmin, level: superAdmin.level ?? "platform" },
          }),
        "ROLE_NOT_ASSIGNABLE",
      );
    throwsCode(
      () =>
        grantBy("tenantAdmin", {
          role: {
            ...templateRole("finance"),
            templateKey: null,
            permissions: ["platform.tenant.manage"],
          },
        }),
      "ROLE_NOT_ASSIGNABLE",
    );
  });

  test("AUTH-06 Admin Tenant cannot create an Owner (no mutual promotion)", () => {
    throwsCode(
      () => grantBy("tenantAdmin", { role: templateRole("owner") }),
      "PERMISSION_DENIED",
    );
    assert.ok(grantBy("owner", { role: templateRole("owner") }));
  });

  test("AUTH-06 a custom role with access.role.assign cannot delegate permissions it lacks", () => {
    const customRoleId = "6a2d4f80-1c3e-4b5a-9d7f-0000000000c1";
    const assignment = {
      ...fx.assignments.find((row) => row.userId === fx.users.finance.id),
      id: "6a2d4f80-1c3e-4b5a-9d7f-0000000000c2",
      userId: fx.users.supervisor.id,
      roleId: customRoleId,
      scope: tenantScope,
    };
    const custom = {
      id: customRoleId,
      permissions: ["access.role.view", "access.role.assign"],
      mfaRequired: true,
      templateKey: null,
    };
    const grantor = {
      tenantId: fx.tenantId,
      userId: fx.users.supervisor.id,
      assignments: [assignment],
    };
    const base = {
      grantor,
      grantorRoles: [...fx.roleGrants, custom],
      grantorMfaVerified: true,
      grantorReauthenticatedAt: fx.now,
      granteeUserId: fx.users.employee.id,
      scope: tenantScope,
      org: fx.org,
      now: fx.now,
    };
    throwsCode(
      () =>
        access.assertCanGrantRole({ ...base, role: templateRole("finance") }),
      "PERMISSION_DENIED",
    );
    // Same custom role labelled as a template it is not: still refused,
    // because only a stored template key unlocks top authority.
    throwsCode(
      () =>
        access.assertCanGrantRole({
          ...base,
          grantorRoles: [...fx.roleGrants, { ...custom, templateKey: "hr" }],
          role: templateRole("finance"),
        }),
      "PERMISSION_DENIED",
    );
    assert.ok(
      access.assertCanGrantRole({
        ...base,
        role: {
          ...templateRole("finance"),
          templateKey: null,
          permissions: ["access.role.view"],
        },
      }),
    );
  });
});

// legend-7vsby: the owner template may only be granted by a real tenant Owner.
// Assumption: "real Owner" = an active, tenant-scoped assignment of a role whose
// templateKey is "owner" in the grantor's own tenant. Holding the same
// permissions through a custom role is not enough.
describe("legend-7vsby owner template grant", () => {
  const tenantScope = { type: "tenant", id: null };
  const templateRole = (key) => {
    const role = fx.roles.find((r) => r.templateKey === key);
    return { ...role, level: "tenant" };
  };
  const ownerPermissions = access.roleTemplate("owner").permissions;
  const customRoleId = "6a2d4f80-1c3e-4b5a-9d7f-0000000000d1";
  const day = 24 * 60 * 60 * 1000;
  const earlier = new Date(fx.now.getTime() - 30 * day).toISOString();
  // A custom role (no template key) holding every Owner permission.
  const customAllOwner = {
    id: customRoleId,
    permissions: [...ownerPermissions],
    mfaRequired: true,
    templateKey: null,
  };
  const assignmentFor = (userKey, roleIdValue, overrides = {}) => ({
    ...fx.assignments.find((row) => row.userId === fx.users.finance.id),
    id: `6a2d4f80-1c3e-4b5a-9d7f-${String(
      Math.floor(Math.random() * 1e12),
    ).padStart(12, "0")}`,
    userId: fx.users[userKey].id,
    roleId: roleIdValue,
    scope: tenantScope,
    validFrom: earlier,
    validUntil: null,
    ...overrides,
  });
  const customAssignment = (userKey = "hr") =>
    assignmentFor(userKey, customRoleId);
  const ownerAssignment = (userKey, overrides = {}) =>
    assignmentFor(userKey, roleId("owner"), overrides);
  const grantAs = (userKey, assignments, overrides = {}) =>
    access.assertCanGrantRole({
      grantor: {
        tenantId: fx.tenantId,
        userId: fx.users[userKey].id,
        assignments,
      },
      grantorRoles: [...fx.roleGrants, customAllOwner],
      grantorMfaVerified: true,
      grantorReauthenticatedAt: new Date(fx.now.getTime() - 60_000),
      granteeUserId: fx.users.employee.id,
      role: templateRole("owner"),
      scope: tenantScope,
      org: fx.org,
      now: fx.now,
      ...overrides,
    });

  test("fixture premise: the custom role holds every Owner permission", () => {
    assert.ok(ownerPermissions.includes("access.role.assign"));
    assert.equal(templateRole("owner").templateKey, "owner");
  });

  test("legend-7vsby custom role with every Owner permission cannot grant the owner template", () => {
    throwsCode(
      () => grantAs("hr", [customAssignment("hr")]),
      "PERMISSION_DENIED",
    );
    assert.equal(
      new access.AccessError("PERMISSION_DENIED").status,
      403,
      "PERMISSION_DENIED maps to HTTP 403",
    );
  });

  test("legend-7vsby a brand-scoped owner assignment is not enough", () => {
    const brandOwner = ownerAssignment("hr", {
      scope: { type: "brand", id: fx.brandId },
    });
    throwsCode(
      () => grantAs("hr", [brandOwner, customAssignment("hr")]),
      "PERMISSION_DENIED",
    );
  });

  test("legend-7vsby an expired owner assignment is not enough", () => {
    const expired = ownerAssignment("hr", {
      validFrom: earlier,
      validUntil: new Date(fx.now.getTime() - day).toISOString(),
    });
    throwsCode(
      () => grantAs("hr", [expired, customAssignment("hr")]),
      "PERMISSION_DENIED",
    );
    // Not yet started is not active either.
    const future = ownerAssignment("hr", {
      validFrom: new Date(fx.now.getTime() + day).toISOString(),
    });
    throwsCode(
      () => grantAs("hr", [future, customAssignment("hr")]),
      "PERMISSION_DENIED",
    );
  });

  test("legend-7vsby an owner assignment from another tenant is not enough", () => {
    const foreign = ownerAssignment("hr", {
      tenantId: "6a2d4f80-1c3e-4b5a-9d7f-0000000000ee",
    });
    throwsCode(
      () => grantAs("hr", [foreign, customAssignment("hr")]),
      "PERMISSION_DENIED",
    );
  });

  test("legend-7vsby another user's owner assignment does not count", () => {
    throwsCode(
      () => grantAs("hr", [ownerAssignment("owner"), customAssignment("hr")]),
      "PERMISSION_DENIED",
    );
  });

  test("legend-7vsby Admin Tenant still cannot grant the owner template", () => {
    throwsCode(
      () => grantAs("tenantAdmin", fx.assignments),
      "PERMISSION_DENIED",
    );
  });

  test("legend-7vsby a real tenant Owner can grant the owner template", () => {
    assert.ok(grantAs("owner", fx.assignments));
    // An open-ended or still-running owner assignment counts.
    const running = ownerAssignment("hr", {
      validUntil: new Date(fx.now.getTime() + day).toISOString(),
    });
    assert.ok(grantAs("hr", [running]));
  });

  test("legend-7vsby a real Owner still needs MFA and a fresh re-auth", () => {
    throwsCode(
      () => grantAs("owner", fx.assignments, { grantorMfaVerified: false }),
      "MFA_REQUIRED",
    );
    throwsCode(
      () =>
        grantAs("owner", fx.assignments, {
          grantorReauthenticatedAt: new Date(fx.now.getTime() - 6 * 60_000),
        }),
      "REAUTH_REQUIRED",
    );
  });

  test("legend-7vsby other grants are unchanged", () => {
    const finance = templateRole("finance");
    assert.ok(grantAs("tenantAdmin", fx.assignments, { role: finance }));
    assert.ok(grantAs("owner", fx.assignments, { role: finance }));
    // The custom all-Owner-permissions role may still delegate what it holds.
    assert.ok(
      grantAs("hr", [customAssignment("hr")], { role: finance }),
      "custom role holding every Finance permission can still grant Finance",
    );
    // Self-grant stays refused for an Owner granting the owner template.
    throwsCode(
      () =>
        grantAs("owner", fx.assignments, {
          granteeUserId: fx.users.owner.id,
        }),
      "SELF_ELEVATION_FORBIDDEN",
    );
  });

  test("legend-7vsby OWNER_TEMPLATE_ONLY_PERMISSIONS lists pos.receipt.writeoff", () => {
    assert.deepEqual(
      [...access.OWNER_TEMPLATE_ONLY_PERMISSIONS],
      ["pos.receipt.writeoff"],
    );
  });

  test("legend-7vsby custom roles cannot contain an owner-only permission (422)", () => {
    throwsCode(
      () => access.normalizeCustomRolePermissions(["pos.receipt.writeoff"]),
      "PERMISSION_OWNER_ONLY",
    );
    throwsCode(
      () =>
        access.normalizeCustomRolePermissions([
          "access.role.view",
          "pos.receipt.writeoff",
        ]),
      "PERMISSION_OWNER_ONLY",
    );
    try {
      access.normalizeCustomRolePermissions(["pos.receipt.writeoff"]);
      assert.fail("expected AccessError");
    } catch (error) {
      assert.ok(error instanceof access.AccessError);
      assert.equal(error.status, 422);
    }
    // Ordinary lists and unknown codes behave as before.
    assert.deepEqual(
      access.normalizeCustomRolePermissions(["access.role.view"]).permissions,
      ["access.role.view"],
    );
    throwsCode(
      () => access.normalizeCustomRolePermissions(["not.a.permission"]),
      "PERMISSION_NOT_IN_CATALOG",
    );
  });

  test("legend-7vsby withoutOwnerOnlyPermissions strips owner-only codes and keeps the rest in order", () => {
    assert.equal(typeof access.withoutOwnerOnlyPermissions, "function");
    assert.deepEqual(
      access.withoutOwnerOnlyPermissions([
        "access.role.view",
        "pos.receipt.writeoff",
        "access.role.assign",
      ]),
      ["access.role.view", "access.role.assign"],
    );
    assert.deepEqual(access.withoutOwnerOnlyPermissions([]), []);
    assert.deepEqual(
      access.withoutOwnerOnlyPermissions(["pos.receipt.writeoff"]),
      [],
    );
  });

  test("legend-7vsby the Owner template itself still holds the owner-only permission", () => {
    assert.ok(ownerPermissions.includes("pos.receipt.writeoff"));
  });
});

describe("legend-t4y7 GET /api/me/access contract", () => {
  test("returns effective permission codes plus the AUTH-05 flags", () => {
    assert.equal(access.getMyAccess.id, "GET /api/me/access");
    const view = access.myAccessViewSchema.parse({
      permissions: ["org.structure.manage", "access.role.assign"],
      mfaRequired: true,
      mfaVerified: false,
      stations: [],
      outlets: [],
      activeOutletId: null,
      supportSession: null,
    });
    assert.deepEqual(view.permissions, [
      "org.structure.manage",
      "access.role.assign",
    ]);
    // Station reach travels with the same view so a KDS client only polls
    // boards the API would authorize (legend-fsb7).
    const withStation = access.myAccessViewSchema.parse({
      permissions: ["kds.ticket.process"],
      mfaRequired: false,
      mfaVerified: true,
      stations: [station("bar_kopi")],
      outlets: [],
      activeOutletId: null,
      supportSession: null,
    });
    assert.deepEqual(withStation.stations, [station("bar_kopi")]);
    // Platform codes are never part of a tenant view.
    assert.equal(
      access.myAccessViewSchema.safeParse({
        permissions: ["platform.tenant.manage"],
        mfaRequired: true,
        mfaVerified: true,
        stations: [],
        outlets: [],
        activeOutletId: null,
        supportSession: null,
      }).success,
      false,
    );
    assert.equal(
      access.myAccessViewSchema.safeParse({
        permissions: [],
        mfaRequired: false,
        stations: [],
        outlets: [],
        activeOutletId: null,
        supportSession: null,
      }).success,
      false,
    );
  });

  test("legend-ebt9f carries the assigned outlets and rejects a malformed list", () => {
    const [first, second] = core.cafeLegendFixtures.outlets;
    const outlet = (fixture) => ({
      id: fixture.id,
      name: fixture.name,
      timeZone: fixture.timeZone,
      businessDayCutoff: fixture.businessDayCutoff,
    });
    const base = {
      permissions: [],
      mfaRequired: false,
      mfaVerified: false,
      stations: [],
      activeOutletId: null,
      supportSession: null,
    };
    const view = access.myAccessViewSchema.parse({
      ...base,
      outlets: [outlet(first), outlet(second)],
    });
    assert.deepEqual(
      view.outlets.map((row) => row.id),
      [first.id, second.id],
    );
    // The active outlet (legend-6vgv) is an outlet id or null, never omitted.
    const pinned = access.myAccessViewSchema.parse({
      ...base,
      outlets: [outlet(first), outlet(second)],
      activeOutletId: first.id,
    });
    assert.equal(pinned.activeOutletId, first.id);
    assert.equal(
      access.myAccessViewSchema.safeParse({
        ...base,
        outlets: [],
        activeOutletId: "not-a-uuid",
      }).success,
      false,
    );
    // An empty list is valid (an account with no assignment).
    assert.equal(
      access.myAccessViewSchema.safeParse({ ...base, outlets: [] }).success,
      true,
    );
    // The outlet list is required, and an outlet without a name or with an
    // unknown field is refused.
    assert.equal(access.myAccessViewSchema.safeParse(base).success, false);
    assert.equal(
      access.myAccessViewSchema.safeParse({
        ...base,
        outlets: [{ ...outlet(first), name: "" }],
      }).success,
      false,
    );
    assert.equal(
      access.myAccessViewSchema.safeParse({
        ...base,
        outlets: [{ ...outlet(first), status: "active" }],
      }).success,
      false,
    );
  });

  test("RBAC writes use catalogued, versioned envelopes", () => {
    for (const definition of [
      access.roleCreatedEvent,
      access.roleUpdatedEvent,
      access.roleAssignmentGrantedEvent,
      access.roleAssignmentEndedEvent,
      access.approvalPolicyChangedEvent,
    ]) {
      assert.equal(definition.version, 1);
      assert.equal(definition.payloadSchemaRef, `${definition.name}.v1`);
      assert.equal(definition.entry.name, definition.name);
      assert.equal(
        definition.entry.aggregateType,
        definition.name.split(".")[0],
      );
    }
  });
});

test("legend-9v9t: AI tool access does not widen report permissions beyond the PRD table", () => {
  for (const key of ["kitchen_lead", "marketing"])
    assert.ok(
      !access.roleTemplate(key).permissions.includes("report.sales.view"),
      `${key} must not hold report.sales.view`,
    );
  assert.ok(
    !access
      .roleTemplate("kitchen_lead")
      .permissions.includes("inventory.cost.view"),
    "kitchen_lead must not hold inventory.cost.view (MFA-sensitive)",
  );
  assert.ok(
    !access
      .roleTemplate("shareholder")
      .permissions.includes("report.financial.view"),
    "shareholder must not hold report.financial.view",
  );
});

describe("legend-7vsby owner-only codes outside the Owner template", () => {
  test("no template other than owner carries an Owner-only permission", () => {
    for (const template of access.ROLE_TEMPLATES) {
      if (template.key === "owner") continue;
      for (const code of access.OWNER_TEMPLATE_ONLY_PERMISSIONS)
        assert.ok(
          !template.permissions.includes(code) &&
            !template.optionalPermissions.includes(code),
          `${template.key} must not carry ${code}`,
        );
    }
  });

  test("rolePermissionsAsGranted keeps Owner-only codes only on the owner template", () => {
    const codes = ["pos.receipt.writeoff", "access.role.view"];
    assert.deepEqual(access.rolePermissionsAsGranted("owner", codes), codes);
    assert.deepEqual(access.rolePermissionsAsGranted(null, codes), [
      "access.role.view",
    ]);
    assert.deepEqual(access.rolePermissionsAsGranted("tenant_admin", codes), [
      "access.role.view",
    ]);
  });
});

describe("self.loan.request (legend-e3k9)", () => {
  test("kasbon self-service has its own self-service permission", () => {
    assert.ok(access.isPermissionCode("self.loan.request"));
    assert.ok(access.permissionHasTag("self.loan.request", "self"));
  });

  test("the employee template holds it, management templates do not (self.* is employee-only)", () => {
    assert.ok(template("employee").permissions.includes("self.loan.request"));
    assert.ok(!template("owner").permissions.includes("self.loan.request"));
    assert.ok(
      !template("tenant_admin").permissions.includes("self.loan.request"),
    );
    // Approving a kasbon stays a separate, HR-side permission.
    assert.ok(!template("employee").permissions.includes("hr.loan.approve"));
  });
});

describe("hr.announcement.manage (legend-poxk)", () => {
  test("announcements have their own manage permission, apart from SOP", () => {
    assert.ok(access.isPermissionCode("hr.announcement.manage"));
    assert.ok(access.isPermissionCode("hr.sop.manage"));
  });

  test("HR-side templates hold it; kitchen_lead keeps SOP but cannot manage announcements", () => {
    // Same holders as hr.sop.manage minus kitchen_lead (tenant_admin has neither).
    for (const key of ["owner", "general_manager", "hr"])
      assert.ok(
        template(key).permissions.includes("hr.announcement.manage"),
        key,
      );
    assert.ok(template("kitchen_lead").permissions.includes("hr.sop.manage"));
    // Still reads the announcement feed (no regression from the split).
    assert.ok(template("kitchen_lead").permissions.includes("self.sop.read"));
    assert.ok(
      !template("kitchen_lead").permissions.includes("hr.announcement.manage"),
    );
    assert.ok(
      !template("tenant_admin").permissions.includes("hr.announcement.manage"),
    );
    assert.ok(
      !template("employee").permissions.includes("hr.announcement.manage"),
    );
  });
});
