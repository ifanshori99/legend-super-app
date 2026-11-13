import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OWNER_TEMPLATE_ONLY_PERMISSIONS,
  PERMISSION_CATALOG,
  ROLE_GRANT_REAUTH_MAX_AGE_MS,
  assertCanEditCustomRole,
  permissionHasTag,
} from "../packages/shared/src/access/index.ts";
import { MESSAGE_KEYS } from "../packages/shared/src/i18n/index.ts";
import * as lib from "../apps/web/src/features/ws01-access/lib.ts";
import { roleEditorErrorMessage } from "../apps/web/src/features/ws01-access/errors.ts";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";

// legend-tj8o (WS-01 FE RBAC admin): the permission picker offers only what the
// editor may add (assertCanEditCustomRole) and the End button follows the
// Owner assignment protection (assertCanEndOwnerAssignment). The API decides
// again; these helpers only keep the screen from offering what it will refuse.

const NOW = new Date("2026-11-13T10:00:00.000Z");
const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";
const TENANT = { type: "tenant" };
const BRAND = { type: "brand", id: "b1" };

const role = (id, templateKey, permissions = []) => ({
  id,
  templateKey,
  permissions,
});
const roles = [
  role("r-owner", "owner", ["access.role.manage"]),
  role("r-admin", "tenant_admin", ["access.role.manage", "access.role.assign"]),
  role("r-admin-nomanage", "tenant_admin", ["access.role.assign"]),
  role("r-custom", null, ["access.role.manage"]),
  role("r-menu", null, ["access.role.manage", "menu.item.view"]),
  role("r-kasir", "cashier"),
];
const assignment = (id, userId, roleId, over = {}) => ({
  id,
  tenantId: "t1",
  userId,
  roleId,
  scope: TENANT,
  validFrom: PAST,
  validUntil: null,
  assignedBy: "x",
  assignedAt: PAST,
  ...over,
});

// ------------------------------------------------------------- End guard

const guard = (target, owners, viewerUserId = "viewer", extra = {}) =>
  lib.endAssignmentGuard({
    target,
    roles,
    viewerUserId,
    ownerAssignments: owners,
    now: NOW,
    ...extra,
  });

test("tj8o · non-Owner cannot end an Owner assignment (ownerOnly)", () => {
  const target = assignment("a1", "bob", "r-owner");
  const owners = [target, assignment("a2", "eve", "r-owner")];
  assert.deepEqual(guard(target, owners, "viewer"), {
    allowed: false,
    reason: "ownerOnly",
  });
});

test("tj8o · a brand-scoped Owner is not an Owner for this rule", () => {
  const target = assignment("a1", "bob", "r-owner");
  const mine = assignment("a3", "viewer", "r-owner", { scope: BRAND });
  const owners = [target, mine, assignment("a2", "eve", "r-owner")];
  assert.equal(guard(target, owners).reason, "ownerOnly");
});

test("tj8o · active Owner may end another Owner while another open-ended Owner stays", () => {
  const target = assignment("a1", "bob", "r-owner");
  const owners = [target, assignment("a2", "viewer", "r-owner")];
  assert.deepEqual(guard(target, owners), { allowed: true });
});

test("tj8o · last open-ended Owner cannot be ended (lastOwner)", () => {
  const target = assignment("a1", "bob", "r-owner");
  // The viewer is an Owner but only until next year: not the Owner that stays.
  const owners = [
    target,
    assignment("a2", "viewer", "r-owner", { validUntil: FUTURE }),
  ];
  assert.deepEqual(guard(target, owners), {
    allowed: false,
    reason: "lastOwner",
  });
});

test("tj8o · the last Owner cannot end their own assignment either", () => {
  const target = assignment("a1", "viewer", "r-owner");
  assert.equal(guard(target, [target]).reason, "lastOwner");
});

test("tj8o · an Owner may end their own assignment when another Owner stays", () => {
  const target = assignment("a1", "viewer", "r-owner");
  const owners = [target, assignment("a2", "eve", "r-owner")];
  assert.deepEqual(guard(target, owners), { allowed: true });
});

test("tj8o · ids compare case-insensitively like the API", () => {
  const target = assignment("a1", "BOB", "r-owner");
  const owners = [target, assignment("a2", "Viewer", "r-owner")];
  assert.deepEqual(guard(target, owners, "VIEWER"), { allowed: true });
});

test("tj8o · a non-Owner role assignment is never blocked", () => {
  const target = assignment("a9", "bob", "r-kasir");
  assert.deepEqual(guard(target, []), { allowed: true });
});

test("tj8o · an already ended Owner assignment is not the last-Owner case", () => {
  const target = assignment("a1", "bob", "r-owner", { validUntil: PAST });
  const owners = [target, assignment("a2", "viewer", "r-owner")];
  assert.deepEqual(guard(target, owners), { allowed: true });
});

test("tj8o · unknown viewer or owner list fails closed", () => {
  const target = assignment("a1", "bob", "r-owner");
  const owners = [target, assignment("a2", "eve", "r-owner")];
  assert.equal(guard(target, owners, undefined).reason, "ownerOnly");
  assert.deepEqual(guard(target, undefined), {
    allowed: false,
    reason: "loading",
  });
  // A non-Owner role needs no Owner list at all.
  const kasir = assignment("a9", "bob", "r-kasir");
  assert.deepEqual(guard(kasir, undefined), { allowed: true });
});

// ------------------------------------------------------- Permission picker

const held = ["menu.item.view", "access.role.manage"];
const topArgs = (userAssignments, over = {}) => ({
  viewerUserId: "viewer",
  viewerAssignments: userAssignments,
  roles,
  now: NOW,
  ...over,
});

test("tj8o · top authority needs an active tenant Owner or Admin Tenant", () => {
  const admin = assignment("a1", "viewer", "r-admin");
  assert.equal(lib.viewerHoldsTopAuthority(topArgs([admin])), true);
  assert.equal(
    lib.viewerHoldsTopAuthority(
      topArgs([assignment("a2", "viewer", "r-owner")]),
    ),
    true,
  );
  assert.equal(
    lib.viewerHoldsTopAuthority(topArgs([admin], { viewerUserId: undefined })),
    false,
  );
});

test("tj8o · custom role, brand scope, ended, other user or no manage permission never count", () => {
  const no = (row) =>
    assert.equal(lib.viewerHoldsTopAuthority(topArgs([row])), false);
  no(assignment("a1", "viewer", "r-custom"));
  no(assignment("a2", "viewer", "r-admin", { scope: BRAND }));
  no(assignment("a3", "viewer", "r-admin", { validUntil: PAST }));
  no(assignment("a4", "viewer", "r-admin", { validFrom: FUTURE }));
  no(assignment("a5", "someone", "r-admin"));
  no(assignment("a6", "viewer", "r-admin-nomanage"));
  no(assignment("a7", "viewer", "r-kasir"));
});

test("tj8o · without top authority the picker offers only held permissions", () => {
  const addable = lib.permissionsViewerMayAdd({
    held,
    topAuthority: false,
  });
  assert.deepEqual([...addable].sort(), [...held].sort());
  assert.equal(addable.has("pos.void.approve"), false);
});

test("tj8o · with top authority the picker offers every tenant permission but never platform or Owner-only codes", () => {
  const addable = lib.permissionsViewerMayAdd({ held: [], topAuthority: true });
  const expected = PERMISSION_CATALOG.filter(
    ({ code }) =>
      !permissionHasTag(code, "platform") &&
      !OWNER_TEMPLATE_ONLY_PERMISSIONS.includes(code),
  ).map(({ code }) => code);
  assert.ok(expected.length > 100);
  assert.deepEqual([...addable].sort(), [...expected].sort());
  assert.equal(addable.has("pos.receipt.writeoff"), false);
});

test("tj8o · held Owner-only or platform codes are still never offered", () => {
  const platform = PERMISSION_CATALOG.find(({ code }) =>
    permissionHasTag(code, "platform"),
  ).code;
  const addable = lib.permissionsViewerMayAdd({
    held: ["pos.receipt.writeoff", platform, "menu.item.view"],
    topAuthority: false,
  });
  assert.deepEqual([...addable], ["menu.item.view"]);
});

test("tj8o · canSelectPermission: remove always, add only when offered, keep what the role already has", () => {
  const addable = new Set(["menu.item.view"]);
  const original = ["pos.void.approve"];
  const can = (code, selected) =>
    lib.canSelectPermission(code, { selected, addable, original });
  assert.equal(can("menu.item.view", []), true);
  assert.equal(can("pos.void.approve", []), true); // already in the saved role
  assert.equal(can("inventory.stock.adjust", []), false);
  // A selected code can always be unticked, even if it is not offered.
  assert.equal(can("inventory.stock.adjust", ["inventory.stock.adjust"]), true);
});

// ------------------------------------------- helpers vs assertCanEditCustomRole

const PRINCIPAL = { tenantId: "t1", userId: "viewer" };
const ORG = {
  brands: [{ id: "b1" }],
  outlets: [{ id: "o1", brandId: "b1" }],
  stations: [],
};
const OUTLET = { type: "outlet", id: "o1" };
const ago = (ms) => new Date(NOW.getTime() - ms);
const FRESH = ago(60_000);
const STALE = ago(ROLE_GRANT_REAUTH_MAX_AGE_MS + 1_000);
const EDGE = ago(ROLE_GRANT_REAUTH_MAX_AGE_MS);
const FUTURE_REAUTH = new Date(NOW.getTime() + 60_000);

function serverAllows(assignments, added, reauthAt) {
  try {
    assertCanEditCustomRole({
      grantor: { ...PRINCIPAL, assignments },
      grantorRoles: roles.map((row) => ({ ...row, mfaRequired: false })),
      grantorMfaVerified: true,
      grantorReauthenticatedAt: reauthAt,
      addedPermissions: added,
      org: ORG,
      now: NOW,
    });
    return true;
  } catch {
    return false;
  }
}

/** What the editor does: "reauth" blocks the save until the viewer verifies. */
function clientDecision(assignments, added, reauthAt) {
  const input = topArgs(assignments);
  const topAuthority = lib.viewerHoldsTopAuthority(input);
  const heldNow = lib.heldAtTenantScope(input);
  if (
    lib.roleEditNeedsReauth({
      topAuthority,
      held: heldNow,
      added,
      reauthenticatedAt: reauthAt,
      now: NOW,
    })
  )
    return "reauth";
  const addable = lib.permissionsViewerMayAdd({ held: heldNow, topAuthority });
  return added.every((code) => addable.has(code)) ? "allowed" : "denied";
}

const viewerRows = {
  "admin (tenant)": [assignment("a1", "viewer", "r-admin")],
  "owner (tenant)": [assignment("a1", "viewer", "r-owner")],
  "custom with menu.item.view (tenant)": [assignment("a1", "viewer", "r-menu")],
  "custom with menu.item.view (brand)": [
    assignment("a1", "viewer", "r-menu", {
      scope: { type: "brand", id: "b1" },
    }),
  ],
  "custom with menu.item.view (outlet)": [
    assignment("a1", "viewer", "r-menu", { scope: OUTLET }),
  ],
  "admin (brand)": [
    assignment("a1", "viewer", "r-admin", {
      scope: { type: "brand", id: "b1" },
    }),
  ],
  "admin (ended)": [
    assignment("a1", "viewer", "r-admin", { validUntil: PAST }),
  ],
  "kasir only": [assignment("a1", "viewer", "r-kasir")],
  nobody: [],
};
const addedSets = {
  none: [],
  "held code": ["menu.item.view"],
  "other code": ["pos.void.approve"],
  "held and other": ["menu.item.view", "pos.void.approve"],
};
const reauths = {
  fresh: FRESH,
  stale: STALE,
  "exactly at the limit": EDGE,
  "in the future": FUTURE_REAUTH,
  never: null,
};

test("tj8o · editor decision matches assertCanEditCustomRole for every viewer, added set and re-auth age", () => {
  for (const [viewer, rows] of Object.entries(viewerRows))
    for (const [addedName, added] of Object.entries(addedSets))
      for (const [reauthName, reauthAt] of Object.entries(reauths)) {
        const decision = clientDecision(rows, added, reauthAt);
        assert.equal(
          decision === "allowed",
          serverAllows(rows, added, reauthAt),
          `${viewer} · ${addedName} · re-auth ${reauthName}: client ${decision}`,
        );
      }
});

test("tj8o · Owner / Admin Tenant need a fresh re-auth, not just a second factor", () => {
  const owner = viewerRows["owner (tenant)"];
  const other = ["pos.void.approve"];
  assert.equal(clientDecision(owner, other, STALE), "reauth");
  assert.equal(clientDecision(owner, other, null), "reauth");
  assert.equal(clientDecision(owner, other, FUTURE_REAUTH), "reauth");
  assert.equal(clientDecision(owner, other, FRESH), "allowed");
  assert.equal(clientDecision(owner, other, EDGE), "allowed");
  assert.equal(serverAllows(owner, other, STALE), false);
  assert.equal(serverAllows(owner, other, FRESH), true);
});

test("tj8o · removing or adding nothing never asks for re-auth", () => {
  const owner = viewerRows["owner (tenant)"];
  assert.equal(clientDecision(owner, [], null), "allowed");
  // The owner holds access.role.manage, so adding it needs no re-auth either.
  assert.equal(clientDecision(owner, ["access.role.manage"], null), "allowed");
});

test("tj8o · reauthIsFresh follows ROLE_GRANT_REAUTH_MAX_AGE_MS", () => {
  assert.equal(lib.reauthIsFresh(null, NOW), false);
  assert.equal(lib.reauthIsFresh(FRESH, NOW), true);
  assert.equal(lib.reauthIsFresh(EDGE, NOW), true);
  assert.equal(lib.reauthIsFresh(STALE, NOW), false);
  assert.equal(lib.reauthIsFresh(FUTURE_REAUTH, NOW), false);
});

// ------------------------------------------------------------ heldAtTenantScope

const heldFor = (rows, over = {}) =>
  lib.heldAtTenantScope(topArgs(rows, over)).sort();

test("tj8o · heldAtTenantScope counts only active tenant-scoped assignments", () => {
  assert.deepEqual(heldFor([assignment("a1", "viewer", "r-menu")]), [
    "access.role.manage",
    "menu.item.view",
  ]);
  for (const scope of [
    { type: "brand", id: "b1" },
    OUTLET,
    { type: "station", id: "s1" },
  ])
    assert.deepEqual(
      heldFor([assignment("a1", "viewer", "r-menu", { scope })]),
      [],
    );
  assert.deepEqual(
    heldFor([assignment("a1", "viewer", "r-menu", { validUntil: PAST })]),
    [],
  );
  assert.deepEqual(
    heldFor([assignment("a1", "viewer", "r-menu", { validFrom: FUTURE })]),
    [],
  );
  assert.deepEqual(heldFor([assignment("a1", "someone", "r-menu")]), []);
  assert.deepEqual(heldFor([assignment("a1", "viewer", "r-unknown")]), []);
});

test("tj8o · heldAtTenantScope is empty while data is missing (loading or error)", () => {
  assert.deepEqual(heldFor([]), []);
  assert.deepEqual(
    heldFor([assignment("a1", "viewer", "r-menu")], { roles: [] }),
    [],
  );
  assert.deepEqual(
    heldFor([assignment("a1", "viewer", "r-menu")], {
      viewerUserId: undefined,
    }),
    [],
  );
});

test("tj8o · heldAtTenantScope unions roles and reads Owner-only codes on the Owner template only", () => {
  const ownerOnly = OWNER_TEMPLATE_ONLY_PERMISSIONS[0];
  const custom = role("r-legacy", null, [ownerOnly, "menu.item.view"]);
  const owner = role("r-owner2", "owner", [ownerOnly, "access.role.manage"]);
  const rows = [
    assignment("a1", "viewer", "r-legacy"),
    assignment("a2", "viewer", "r-kasir"),
  ];
  assert.deepEqual(heldFor(rows, { roles: [...roles, custom] }), [
    "menu.item.view",
  ]);
  assert.deepEqual(
    heldFor([assignment("a3", "viewer", "r-owner2"), ...rows], {
      roles: [...roles, custom, owner],
    }),
    ["access.role.manage", ownerOnly, "menu.item.view"].sort(),
  );
});

// ------------------------------------------------------------ viewerHoldsRole

test("tj8o · viewerHoldsRole: active assignment in any scope counts, ended or other role never", () => {
  const held = (rows, roleId = "r-menu") =>
    lib.viewerHoldsRole(rows, roleId, NOW);
  assert.equal(held([assignment("a1", "viewer", "r-menu")]), true);
  for (const scope of [BRAND, OUTLET, { type: "station", id: "s1" }])
    assert.equal(held([assignment("a1", "viewer", "r-menu", { scope })]), true);
  assert.equal(held([assignment("a1", "viewer", "R-MENU")]), true);
  assert.equal(
    held([assignment("a1", "viewer", "r-menu", { validUntil: PAST })]),
    false,
  );
  assert.equal(
    held([assignment("a1", "viewer", "r-menu", { validFrom: FUTURE })]),
    false,
  );
  assert.equal(held([assignment("a1", "viewer", "r-kasir")]), false);
  assert.equal(held([]), false);
});

test("tj8o · SELF_ELEVATION_FORBIDDEN with no added permission explains the MFA rule, not re-auth", () => {
  const t = (key) => key;
  const error = new ApiError(403, "SELF_ELEVATION_FORBIDDEN", "x");
  // Dropping MFA on a held role adds nothing: neither the re-auth text (top
  // authority) nor the extra-permission text may show.
  for (const topAuthority of [true, false])
    assert.equal(
      roleEditorErrorMessage(error, t, { topAuthority, added: [] }),
      "access.role.mfaDropSelf",
    );
  assert.equal(
    roleEditorErrorMessage(error, t, {
      topAuthority: true,
      added: ["pos.void.approve"],
    }),
    "access.errors.reauthRequired",
  );
  assert.equal(
    roleEditorErrorMessage(error, t, {
      topAuthority: false,
      added: ["pos.void.approve"],
    }),
    "access.role.selfElevation",
  );
});

// ------------------------------------------------------- permissionBlockReason

test("tj8o · permissionBlockReason names why a row is blocked", () => {
  const platform = PERMISSION_CATALOG.find(({ code }) =>
    permissionHasTag(code, "platform"),
  ).code;
  const ownerOnly = OWNER_TEMPLATE_ONLY_PERMISSIONS[0];
  const state = {
    selected: [],
    addable: new Set(["menu.item.view"]),
    original: [],
  };
  assert.equal(lib.permissionBlockReason("menu.item.view", state), null);
  assert.equal(lib.permissionBlockReason("pos.void.approve", state), "notHeld");
  assert.equal(lib.permissionBlockReason(ownerOnly, state), "ownerOnly");
  assert.equal(lib.permissionBlockReason(platform, state), "platform");
  // A selected or already saved code stays tickable so it can be removed.
  assert.equal(
    lib.permissionBlockReason(ownerOnly, { ...state, selected: [ownerOnly] }),
    null,
  );
  assert.equal(
    lib.permissionBlockReason("pos.void.approve", {
      ...state,
      original: ["pos.void.approve"],
    }),
    null,
  );
});

// -------------------------------------------------------------------- text

test("tj8o · every new text key exists in the catalog", () => {
  for (const key of [
    "access.role.permissionsLimitedHint",
    "access.role.blockedNotHeld",
    "access.role.blockedOwnerOnly",
    "access.role.blockedPlatform",
    "access.role.permissionsChecking",
    "access.role.permissionsCheckError",
    "access.role.reauthHint",
    "access.role.reauthDone",
    "access.role.reauthNoFactorHint",
    "access.role.selfElevation",
    "access.role.mfaDropSelf",
    "access.role.mfaHeldSelf",
    "access.assignments.endLocked",
    "access.perm.org.config.import",
    "access.assignments.endGuardLoading",
    "access.assignments.endGuardError",
    "access.assignments.endBlockedOwnerOnly",
    "access.assignments.endBlockedLastOwner",
  ])
    assert.ok(MESSAGE_KEYS.includes(key), `${key} missing`);
});
