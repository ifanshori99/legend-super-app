// Mock handlers for the RBAC admin endpoints (VITE_API_MOCK=true). They serve
// the Cafe Legend fixtures from @starter/shared/access + identity so every
// screen works without an API, and each response is validated by the runtime
// against the same schema the API uses.
//
// Re-authentication: the real API checks the session's `mfa_verified_at` after
// POST /api/auth/mfa/verify. The mock remembers a verified factor per runtime
// and accepts any 6-digit code (it cannot compute TOTP); the flow, the factor
// pick and the error states are the same.
import {
  approvalMatrixSchema,
  approvalPolicySchema,
  cafeLegendAccessFixtures,
  isAssignmentActive,
  normalizeCustomRolePermissions,
  roleAssignmentSchema,
  roleSchema,
  type ApprovalPolicy,
  type Role,
  type RoleAssignment,
} from "@starter/shared/access";
import {
  cafeLegendIdentityFixtures,
  createCustomRole,
  endRoleAssignment,
  getApprovalMatrix,
  grantRole,
  listMfaFactors,
  listRoleAssignments,
  listRoles,
  replaceApprovalMatrix,
  updateCustomRole,
  verifyMfaFactor,
} from "@starter/shared/identity";
import {
  cafeLegendMenuFixtures,
  listStations,
} from "@starter/shared/menu";
import {
  cafeLegendPlatformFixtures,
  orgEndpoints,
} from "@starter/shared/platform";
import { ApiError } from "@/lib/api/errors";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  registerMock,
  registeredMockIds,
  type MockHandler,
} from "@/lib/mock/registry";
import { paginateFixture } from "@/lib/mock/paginate";
import { createMockStore } from "@/lib/mock/store";

const NOW = () => new Date().toISOString();

function uuidFrom(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

let roleSeed = 0x200;
let assignmentSeed = 0x200;
let policySeed = 0x200;

const cloneRole = (role: Role): Role => ({
  ...role,
  permissions: [...role.permissions],
  allowedScopeTypes: [...role.allowedScopeTypes],
});
const cloneAssignment = (row: RoleAssignment): RoleAssignment => ({
  ...row,
  scope: { ...row.scope },
});
const clonePolicy = (row: ApprovalPolicy): ApprovalPolicy => ({ ...row });

const roles = createMockStore<Role[]>(() =>
  cafeLegendAccessFixtures.roles.map(cloneRole),
);
const assignments = createMockStore<RoleAssignment[]>(() =>
  cafeLegendAccessFixtures.assignments.map(cloneAssignment),
);
const policies = createMockStore<ApprovalPolicy[]>(() =>
  cafeLegendAccessFixtures.approvalPolicies.map(clonePolicy),
);

const actorId = cafeLegendAccessFixtures.users.tenantAdmin.id;
const tenantId = cafeLegendAccessFixtures.tenantId;

function roleById(roleId: string): Role {
  const role = roles.get().find((row) => row.id === roleId);
  if (!role)
    throw new ApiError(404, "NOT_FOUND", "Peran tidak ditemukan.", [
      { field: "roleId", message: "Peran tidak ditemukan." },
    ]);
  return role;
}

/** Registers only when no other feature owns the endpoint yet. */
function registerIfAbsent(
  endpoint: AnyEndpoint,
  handler: MockHandler<AnyEndpoint>,
) {
  if (!registeredMockIds().includes(endpoint.id))
    registerMock(endpoint, handler as MockHandler<typeof endpoint>);
}

// -------------------------------------------------------------------- roles

registerMock(listRoles, ({ scenario }) => ({
  data: scenario === "empty" ? [] : roles.get(),
}));

registerMock(createCustomRole, ({ body }) => {
  const { permissions, mfaRequired } = normalizeCustomRolePermissions(
    body.permissions,
    { mfaRequested: body.mfaRequired },
  );
  const now = NOW();
  const role = roleSchema.parse({
    id: uuidFrom("401e0000", roleSeed++),
    tenantId,
    name: body.name,
    isTemplate: false,
    templateKey: null,
    permissions,
    mfaRequired,
    allowedScopeTypes: body.allowedScopeTypes,
    createdAt: now,
    updatedAt: now,
  });
  roles.set([...roles.get(), role]);
  return { data: role };
});

registerMock(updateCustomRole, ({ params, body }) => {
  const current = roleById(params.roleId);
  if (current.isTemplate)
    throw new ApiError(409, "CONFLICT", "Peran template tidak dapat diubah.");
  const normalized =
    body.permissions === undefined
      ? undefined
      : normalizeCustomRolePermissions(body.permissions, {
          mfaRequested: body.mfaRequired,
        });
  const next = roleSchema.parse({
    ...current,
    name: body.name ?? current.name,
    permissions: normalized?.permissions ?? current.permissions,
    mfaRequired: normalized?.mfaRequired ?? body.mfaRequired ?? current.mfaRequired,
    allowedScopeTypes: body.allowedScopeTypes ?? current.allowedScopeTypes,
    updatedAt: NOW(),
  });
  roles.set(roles.get().map((row) => (row.id === next.id ? next : row)));
  return { data: next };
});

// -------------------------------------------------------------- assignments

registerMock(listRoleAssignments, ({ query, scenario }) => {
  const now = cafeLegendAccessFixtures.now;
  const filtered = assignments.get().filter((row) => {
    if (query.userId && row.userId !== query.userId) return false;
    if (query.roleId && row.roleId !== query.roleId) return false;
    if (query.activeOnly && !isAssignmentActive(row, now)) return false;
    return true;
  });
  return paginateFixture(filtered, query, (row) => row.id, scenario);
});

registerMock(grantRole, ({ body }) => {
  const role = roleById(body.roleId);
  if (!role.allowedScopeTypes.includes(body.scope.type))
    throw new ApiError(
      400,
      "ROLE_SCOPE_NOT_ALLOWED",
      "Cakupan ini tidak diizinkan untuk peran tersebut.",
      [{ field: "scope", message: "Cakupan tidak diizinkan untuk peran ini." }],
    );
  if (body.userId.toLowerCase() === actorId.toLowerCase())
    throw new ApiError(
      403,
      "SELF_ELEVATION_FORBIDDEN",
      "Anda tidak dapat memberi peran kepada diri sendiri.",
    );
  const now = NOW();
  const assignment = roleAssignmentSchema.parse({
    id: uuidFrom("a5510000", assignmentSeed++),
    tenantId,
    userId: body.userId,
    roleId: body.roleId,
    scope: body.scope,
    validFrom: body.validFrom ?? now,
    validUntil: body.validUntil ?? null,
    assignedBy: actorId,
    assignedAt: now,
  });
  assignments.set([assignment, ...assignments.get()]);
  return { data: assignment };
});

registerMock(endRoleAssignment, ({ params, body }) => {
  const current = assignments.get().find((row) => row.id === params.assignmentId);
  if (!current)
    throw new ApiError(404, "NOT_FOUND", "Penugasan tidak ditemukan.");
  if (current.validUntil !== null && Date.parse(current.validUntil) <= Date.now())
    throw new ApiError(409, "CONFLICT", "Penugasan ini sudah berakhir.");
  const next = roleAssignmentSchema.parse({
    ...current,
    validUntil: body.validUntil ?? NOW(),
  });
  assignments.set(
    assignments.get().map((row) => (row.id === next.id ? next : row)),
  );
  return { data: next };
});

// ------------------------------------------------------------------- matrix

registerMock(getApprovalMatrix, ({ scenario }) => ({
  data: scenario === "empty" ? [] : policies.get(),
}));

registerMock(replaceApprovalMatrix, ({ body }) => {
  const next = body.policies.map((policy, index) =>
    approvalPolicySchema.parse({
      id: uuidFrom("a9910000", policySeed + index),
      ...policy,
      requiresDistinctActor: true,
    }),
  );
  policySeed += body.policies.length;
  const parsed = approvalMatrixSchema.safeParse(next);
  if (!parsed.success)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Matriks approval tidak valid: tingkat harus berurutan dari 1.",
      parsed.error.issues.map((issue) => ({
        field: String(issue.path[0] ?? ""),
        message: issue.message,
      })),
    );
  policies.set(parsed.data);
  return { data: parsed.data };
});

// ---------------------------------------------------------- re-authentication

registerIfAbsent(listMfaFactors, ({ scenario }) =>
  scenario === "empty"
    ? { data: [] }
    : {
        data: cafeLegendIdentityFixtures.mfaFactors.filter(
          (factor) => factor.userId === cafeLegendAccessFixtures.users.owner.id,
        ),
      },
);

registerIfAbsent(verifyMfaFactor, ({ body }) => {
  const factor = cafeLegendIdentityFixtures.mfaFactors.find(
    (row) => row.id === body.factorId,
  );
  if (!factor)
    throw new ApiError(404, "NOT_FOUND", "Faktor kedua tidak ditemukan.");
  return { data: { factorId: factor.id, verifiedAt: NOW() } };
});

// -------------------------------------------------------- scope name lookups

registerIfAbsent(orgEndpoints.listBrands, () => ({
  data: [cafeLegendPlatformFixtures.brand],
}));

registerIfAbsent(orgEndpoints.listOutlets, ({ query, scenario }) =>
  paginateFixture(
    cafeLegendPlatformFixtures.outlets,
    query,
    (row) => row.id,
    scenario,
  ),
);

registerIfAbsent(listStations, ({ query, scenario }) =>
  paginateFixture(
    cafeLegendMenuFixtures.stations,
    query,
    (row) => row.id,
    scenario,
  ),
);
