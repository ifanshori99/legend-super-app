import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  cafeLegendAccessFixtures as fx,
  OWNER_TEMPLATE_ONLY_PERMISSIONS,
  PERMISSION_CATALOG,
  permissionHasTag,
} from "../packages/shared/src/access/index.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/features/ws01-access/mock.ts";

// legend-tj8o: the RBAC admin mock refuses what the API refuses (Owner
// assignment protection, Owner grant, custom-role self-elevation), so mock mode
// does not teach a flow the real server rejects. The mock actor is the Admin
// Tenant, never an Owner.

const OWNER_ROLE = fx.roles.find((row) => row.templateKey === "owner");
const ADMIN_ROLE = fx.roles.find((row) => row.templateKey === "tenant_admin");
const CUSTOM_ROLE = fx.roles.find((row) => row.templateKey === null);
const ownerAssignment = fx.assignments.find(
  (row) => row.roleId === OWNER_ROLE.id && row.scope.type === "tenant",
);
const shareholderAssignment = fx.assignments.find(
  (row) =>
    row.roleId === fx.roles.find((r) => r.templateKey === "shareholder").id,
);

const send = (method, path, body, query) =>
  dispatchMock({ method, path, body, query });
const refusedWith = (status, code) => (error) =>
  error.status === status && error.code === code;
const activeAssignments = async () =>
  (await send("GET", "/api/access/role-assignments", undefined, { limit: 100 }))
    .data;

beforeEach(() => resetMocks());

describe("end role assignment (assertCanEndOwnerAssignment)", () => {
  test("the only Owner cannot be ended by a non-Owner (403; 409 last-Owner is unreachable for the mock actor)", async () => {
    await assert.rejects(
      send("POST", `/api/access/role-assignments/${ownerAssignment.id}/end`, {
        reason: "Uji coba",
      }),
      refusedWith(403, "PERMISSION_DENIED"),
    );
    const after = (await activeAssignments()).find(
      (row) => row.id === ownerAssignment.id,
    );
    assert.equal(after.validUntil, null);
  });

  test("a non-Owner assignment can still be ended", async () => {
    const result = await send(
      "POST",
      `/api/access/role-assignments/${shareholderAssignment.id}/end`,
      { reason: "Selesai kontrak" },
    );
    assert.notEqual(result.data.validUntil, null);
  });
});

describe("grant role (Owner only comes from an Owner)", () => {
  const grant = (roleId, userId = fx.users.employee.id) =>
    send("POST", "/api/access/role-assignments", {
      userId,
      roleId,
      scope: { type: "tenant", id: null },
    });

  test("the Admin Tenant cannot grant the Owner role", async () => {
    const before = (await activeAssignments()).length;
    await assert.rejects(
      grant(OWNER_ROLE.id),
      refusedWith(403, "PERMISSION_DENIED"),
    );
    assert.equal((await activeAssignments()).length, before);
  });

  test("the Admin Tenant can still grant a non-Owner tenant role", async () => {
    const result = await grant(ADMIN_ROLE.id);
    assert.equal(result.data.roleId, ADMIN_ROLE.id);
  });
});

describe("update custom role (assertCanEditCustomRole)", () => {
  const usable = (code) =>
    !permissionHasTag(code, "platform") &&
    !OWNER_TEMPLATE_ONLY_PERMISSIONS.includes(code) &&
    !CUSTOM_ROLE.permissions.includes(code);
  const codes = PERMISSION_CATALOG.map(({ code }) => code).filter(usable);
  const lacked = codes.find((code) => !ADMIN_ROLE.permissions.includes(code));
  const held = codes.find((code) => ADMIN_ROLE.permissions.includes(code));
  const patch = (permissions) =>
    send("PATCH", `/api/access/roles/${CUSTOM_ROLE.id}`, { permissions });

  test("adding a permission the editor lacks is refused", async () => {
    assert.ok(lacked, "fixture: a permission the Admin Tenant lacks");
    await assert.rejects(
      patch([...CUSTOM_ROLE.permissions, lacked]),
      refusedWith(403, "SELF_ELEVATION_FORBIDDEN"),
    );
    const roles = (await send("GET", "/api/access/roles")).data;
    const stored = roles.find((row) => row.id === CUSTOM_ROLE.id);
    assert.ok(!stored.permissions.includes(lacked));
  });

  test("adding a permission the editor holds is accepted", async () => {
    assert.ok(held, "fixture: a permission the Admin Tenant holds");
    const result = await patch([...CUSTOM_ROLE.permissions, held]);
    assert.ok(result.data.permissions.includes(held));
  });

  test("removing permissions needs no grant check", async () => {
    const [, ...rest] = CUSTOM_ROLE.permissions;
    const result = await patch(rest);
    assert.equal(result.data.permissions.length, rest.length);
  });
});
