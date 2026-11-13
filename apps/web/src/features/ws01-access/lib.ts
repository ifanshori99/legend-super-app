// Pure helpers for the RBAC admin screens (PRD v1.7 §3 F7): role lists, role
// assignments with scope and validity (TEN-03), and the approval matrix
// (AUTH-06). No React and no `@/` alias, so tests/access-admin.test.mjs loads
// this file with plain Node ESM. Authorization stays in the API; these helpers
// only shape what the screens show and validate the matrix draft client-side so
// the admin sees a fixable error before saving.

import {
  APPROVAL_ACTION_TYPES,
  APPROVAL_MAX_LEVELS,
  OWNER_TEMPLATE_ONLY_PERMISSIONS,
  PERMISSION_CATALOG,
  ROLE_GRANT_REAUTH_MAX_AGE_MS,
  ROLE_GRANT_TOP_AUTHORITY_TEMPLATES,
  permissionHasTag,
  permissionsRequireMfa,
  rolePermissionsAsGranted,
  type ApprovalActionType,
  type ApprovalPolicy,
  type AssignmentScope,
  type PermissionCode,
  type Role,
  type RoleAssignment,
  type RoleId,
  type ScopeType,
} from "@starter/shared/access";
import type { Idr } from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";

/** Scope kinds in the order the picker offers them: widest first. */
export const SCOPE_TYPES: readonly ScopeType[] = [
  "tenant",
  "brand",
  "outlet",
  "station",
];

export const SCOPE_LABEL_KEY: Readonly<Record<ScopeType, MessageKey>> = {
  tenant: "access.assignments.scopeTenant",
  brand: "access.assignments.scopeBrand",
  outlet: "access.assignments.scopeOutlet",
  station: "access.assignments.scopeStation",
};

export const ROLE_KIND_LABEL_KEY: Readonly<Record<RoleKind, MessageKey>> = {
  template: "access.roles.kindTemplate",
  custom: "access.roles.kindCustom",
};

export type RoleKind = "template" | "custom";

export function roleKind(role: Pick<Role, "isTemplate">): RoleKind {
  return role.isTemplate ? "template" : "custom";
}

// ---------------------------------------------------------------- permissions

export type PermissionGroup = {
  module: string;
  labelKey: MessageKey;
  permissions: readonly { code: PermissionCode; labelKey: MessageKey }[];
};

/** The tenant permission catalog grouped by module, in catalog order. */
export function permissionGroups(): PermissionGroup[] {
  const groups = new Map<string, PermissionGroup>();
  for (const entry of PERMISSION_CATALOG) {
    // Platform permissions never belong to a tenant role (§3.7).
    if (permissionHasTag(entry.code, "platform")) continue;
    const group =
      groups.get(entry.module) ??
      ({
        module: entry.module,
        labelKey: `access.module.${entry.module}` as MessageKey,
        permissions: [],
      } satisfies PermissionGroup);
    (
      group.permissions as { code: PermissionCode; labelKey: MessageKey }[]
    ).push({
      code: entry.code,
      labelKey: `access.perm.${entry.code}` as MessageKey,
    });
    groups.set(entry.module, group);
  }
  return [...groups.values()];
}

export function permissionLabelKey(code: PermissionCode): MessageKey {
  return `access.perm.${code}` as MessageKey;
}

/** Adds a permission, or removes it when already selected. */
export function togglePermission(
  selected: readonly PermissionCode[],
  code: PermissionCode,
): PermissionCode[] {
  return selected.includes(code)
    ? selected.filter((row) => row !== code)
    : [...selected, code];
}

/** A custom role that reaches sensitive data must require MFA (AUTH-05). */
export function customRoleMfaRequired(
  permissions: readonly PermissionCode[],
): boolean {
  return permissionsRequireMfa(permissions);
}

/**
 * The scope types a role may be granted at. The API rejects anything else
 * (ROLE_SCOPE_NOT_ALLOWED), so the picker only offers these (TEN-03).
 */
export function scopeOptionsForRole(
  role: Pick<Role, "allowedScopeTypes">,
): readonly ScopeType[] {
  return SCOPE_TYPES.filter((type) => role.allowedScopeTypes.includes(type));
}

export function scopeIsAllowed(
  role: Pick<Role, "allowedScopeTypes">,
  scope: Pick<AssignmentScope, "type">,
): boolean {
  return role.allowedScopeTypes.includes(scope.type);
}

// --------------------------------------------------------------- assignments

export type AssignmentStatus = "active" | "scheduled" | "expired";

export const ASSIGNMENT_STATUS_LABEL_KEY: Readonly<
  Record<AssignmentStatus, MessageKey>
> = {
  active: "access.assignments.statusActive",
  scheduled: "access.assignments.statusScheduled",
  expired: "access.assignments.statusExpired",
};

/**
 * Active on [validFrom, validUntil); a future validFrom is scheduled and a
 * passed validUntil is expired (PRD §3.7 "masa berlaku").
 */
export function assignmentStatus(
  row: Pick<RoleAssignment, "validFrom" | "validUntil">,
  now: Date,
): AssignmentStatus {
  const from = Date.parse(row.validFrom);
  const until = row.validUntil === null ? null : Date.parse(row.validUntil);
  if (from > now.getTime()) return "scheduled";
  if (until !== null && until <= now.getTime()) return "expired";
  return "active";
}

export type AssignmentFilters = {
  search?: string;
  roleId?: string;
  status?: AssignmentStatus;
  scopeType?: ScopeType;
};

export type AssignmentRow = {
  assignment: RoleAssignment;
  role: Role | undefined;
  personName: string | undefined;
  status: AssignmentStatus;
};

export function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase("id-ID");
}

export function filterAssignmentRows(
  rows: readonly AssignmentRow[],
  filters: AssignmentFilters,
): AssignmentRow[] {
  const needle = normalizeQuery(filters.search ?? "");
  return rows.filter(({ assignment, personName, role, status }) => {
    if (filters.roleId && assignment.roleId !== filters.roleId) return false;
    if (filters.status && status !== filters.status) return false;
    if (filters.scopeType && assignment.scope.type !== filters.scopeType)
      return false;
    if (needle === "") return true;
    return (
      normalizeQuery(personName ?? "").includes(needle) ||
      normalizeQuery(role?.name ?? "").includes(needle) ||
      normalizeQuery(assignment.userId).includes(needle)
    );
  });
}

/** Active holders per role id, for the roles list (TEN-03 visibility). */
export function activeHolderCounts(
  assignments: readonly RoleAssignment[],
  now: Date,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of assignments) {
    if (assignmentStatus(row, now) !== "active") continue;
    counts.set(row.roleId, (counts.get(row.roleId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Who a grant or approver picker may offer. A former staff member (status
 * "inactive") stays in the directory so names still resolve, but cannot be
 * picked for a new assignment or approval. The API refuses the grant as well.
 */
export function selectablePeople<T extends { readonly status: string }>(
  people: readonly T[],
): T[] {
  return people.filter((row) => row.status === "active");
}

// ----------------------------------------------- grant rules (legend-tj8o)
// Mirror packages/shared/src/access/grants.ts so the screens do not offer what
// the API refuses. Presentation only: the API decides again and answers
// SELF_ELEVATION_FORBIDDEN, PERMISSION_DENIED or CONFLICT.

const OWNER_TEMPLATE_KEY = "owner";
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** This user's assignments that are active now and tenant-scoped. */
function activeTenantAssignmentsOf(
  assignments: readonly RoleAssignment[],
  userId: string,
  now: Date,
): RoleAssignment[] {
  return assignments.filter(
    (row) =>
      row.scope.type === "tenant" &&
      sameId(row.userId, userId) &&
      assignmentStatus(row, now) === "active",
  );
}

/**
 * The viewer is an active tenant-scoped Owner / Admin Tenant (with
 * access.role.manage). The API then lets them add any tenant permission to a
 * custom role, but only after a fresh re-auth (see `reauthIsFresh`), which the
 * editor asks for on save. Unknown viewer, custom roles and brand scope never
 * count.
 */
export function viewerHoldsTopAuthority(input: {
  viewerUserId: string | undefined;
  viewerAssignments: readonly RoleAssignment[];
  roles: readonly Pick<Role, "id" | "templateKey" | "permissions">[];
  now: Date;
}): boolean {
  if (!input.viewerUserId) return false;
  const top: readonly string[] = ROLE_GRANT_TOP_AUTHORITY_TEMPLATES;
  return activeTenantAssignmentsOf(
    input.viewerAssignments,
    input.viewerUserId,
    input.now,
  ).some((row) => {
    const role = input.roles.find((r) => sameId(r.id, row.roleId));
    return (
      role !== undefined &&
      typeof role.templateKey === "string" &&
      top.includes(role.templateKey) &&
      role.permissions.includes("access.role.manage")
    );
  });
}

/**
 * Permissions the viewer holds at tenant scope (the target of
 * assertCanEditCustomRole): only active tenant-scoped assignments count, a
 * brand or outlet assignment never covers the tenant. Owner-template-only
 * codes count on the Owner template only, as the API reads them. Pass empty
 * lists while assignments or roles load or failed: nothing is held then.
 */
export function heldAtTenantScope(input: {
  viewerUserId: string | undefined;
  viewerAssignments: readonly RoleAssignment[];
  roles: readonly Pick<Role, "id" | "templateKey" | "permissions">[];
  now: Date;
}): PermissionCode[] {
  if (!input.viewerUserId) return [];
  const held = new Set<PermissionCode>();
  for (const row of activeTenantAssignmentsOf(
    input.viewerAssignments,
    input.viewerUserId,
    input.now,
  )) {
    const role = input.roles.find((r) => sameId(r.id, row.roleId));
    if (!role) continue;
    for (const code of rolePermissionsAsGranted(
      role.templateKey ?? null,
      role.permissions,
    ))
      held.add(code);
  }
  return [...held];
}

/**
 * The viewer holds this role through an assignment that is active now, in any
 * scope. The API refuses to drop the MFA requirement of such a role
 * (SELF_ELEVATION_FORBIDDEN in updateCustomRole), so the editor keeps it on.
 * Pass the viewer's own assignments (empty while they load or failed).
 */
export function viewerHoldsRole(
  viewerAssignments: readonly Pick<
    RoleAssignment,
    "roleId" | "validFrom" | "validUntil"
  >[],
  roleId: string,
  now: Date,
): boolean {
  return viewerAssignments.some(
    (row) =>
      sameId(row.roleId, roleId) && assignmentStatus(row, now) === "active",
  );
}

/** A re-auth within ROLE_GRANT_REAUTH_MAX_AGE_MS (never in the future). */
export function reauthIsFresh(
  reauthenticatedAt: Date | null,
  now: Date,
): boolean {
  if (reauthenticatedAt === null) return false;
  const age = now.getTime() - reauthenticatedAt.getTime();
  return age >= 0 && age <= ROLE_GRANT_REAUTH_MAX_AGE_MS;
}

/**
 * Saving needs a fresh re-auth first when the edit adds a permission the
 * viewer does not hold and only top authority allows it. Adding only held
 * permissions, or nothing, never does (assertCanEditCustomRole).
 */
export function roleEditNeedsReauth(input: {
  topAuthority: boolean;
  held: readonly PermissionCode[];
  added: readonly PermissionCode[];
  reauthenticatedAt: Date | null;
  now: Date;
}): boolean {
  if (!input.topAuthority) return false;
  if (input.added.every((code) => input.held.includes(code))) return false;
  return !reauthIsFresh(input.reauthenticatedAt, input.now);
}

/**
 * Permissions a custom-role editor may add: the ones they hold, or every
 * tenant permission under top authority. Platform codes and Owner-template-only
 * codes are never offered (normalizeCustomRolePermissions refuses them).
 */
export function permissionsViewerMayAdd(input: {
  held: readonly PermissionCode[];
  topAuthority: boolean;
}): ReadonlySet<PermissionCode> {
  const ownerOnly: readonly string[] = OWNER_TEMPLATE_ONLY_PERMISSIONS;
  const pool = input.topAuthority
    ? PERMISSION_CATALOG.map((entry) => entry.code)
    : input.held;
  return new Set(
    pool.filter(
      (code) =>
        !permissionHasTag(code, "platform") && !ownerOnly.includes(code),
    ),
  );
}

/**
 * Removing is always allowed. Adding needs the code to be offered, unless the
 * saved role already has it (not an added permission).
 */
export function canSelectPermission(
  code: PermissionCode,
  state: {
    selected: readonly PermissionCode[];
    addable: ReadonlySet<PermissionCode>;
    original: readonly PermissionCode[];
  },
): boolean {
  return (
    state.selected.includes(code) ||
    state.addable.has(code) ||
    state.original.includes(code)
  );
}

export type PermissionBlockReason = "notHeld" | "ownerOnly" | "platform";

/**
 * Why a permission row cannot be ticked, or null when it can. Platform codes
 * and Owner-template-only codes are named first because no role the viewer
 * holds could ever offer them; everything else is simply not held.
 */
export function permissionBlockReason(
  code: PermissionCode,
  state: Parameters<typeof canSelectPermission>[1],
): PermissionBlockReason | null {
  if (canSelectPermission(code, state)) return null;
  const ownerOnly: readonly string[] = OWNER_TEMPLATE_ONLY_PERMISSIONS;
  if (permissionHasTag(code, "platform")) return "platform";
  if (ownerOnly.includes(code)) return "ownerOnly";
  return "notHeld";
}

export type EndAssignmentGuard =
  | { allowed: true }
  | { allowed: false; reason: "ownerOnly" | "lastOwner" | "loading" };

/**
 * Owner assignment protection (assertCanEndOwnerAssignment): only an active
 * tenant Owner may end an Owner assignment, and the tenant keeps at least one
 * active open-ended tenant-scoped Owner. `ownerAssignments` are the tenant's
 * Owner-role assignments; undefined while they load (fail closed).
 */
export function endAssignmentGuard(input: {
  target: RoleAssignment;
  roles: readonly Pick<Role, "id" | "templateKey">[];
  viewerUserId: string | undefined;
  ownerAssignments: readonly RoleAssignment[] | undefined;
  now: Date;
}): EndAssignmentGuard {
  const targetRole = input.roles.find((r) => sameId(r.id, input.target.roleId));
  if (targetRole?.templateKey !== OWNER_TEMPLATE_KEY) return { allowed: true };
  if (input.ownerAssignments === undefined)
    return { allowed: false, reason: "loading" };
  const ownerRoleIds = input.roles
    .filter((r) => r.templateKey === OWNER_TEMPLATE_KEY)
    .map((r) => r.id);
  const activeOwners = input.ownerAssignments.filter(
    (row) =>
      row.scope.type === "tenant" &&
      ownerRoleIds.some((id) => sameId(id, row.roleId)) &&
      assignmentStatus(row, input.now) === "active",
  );
  const viewer = input.viewerUserId;
  const viewerIsOwner =
    viewer !== undefined &&
    activeOwners.some((row) => sameId(row.userId, viewer));
  const isSelf = viewer !== undefined && sameId(input.target.userId, viewer);
  if (!isSelf && !viewerIsOwner) return { allowed: false, reason: "ownerOnly" };
  if (
    assignmentStatus(input.target, input.now) === "active" &&
    !activeOwners.some(
      (row) => row.id !== input.target.id && row.validUntil === null,
    )
  )
    return { allowed: false, reason: "lastOwner" };
  return { allowed: true };
}

export function filterRoles(
  roles: readonly Role[],
  filters: { search?: string; kind?: RoleKind },
): Role[] {
  const needle = normalizeQuery(filters.search ?? "");
  return roles.filter((role) => {
    if (filters.kind && roleKind(role) !== filters.kind) return false;
    return needle === "" || normalizeQuery(role.name).includes(needle);
  });
}

/** Names for brand/outlet/station ids, loaded from the org and menu contracts. */
export type ScopeLookup = {
  brands: ReadonlyMap<string, string>;
  outlets: ReadonlyMap<string, string>;
  stations: ReadonlyMap<string, string>;
};

export const EMPTY_SCOPE_LOOKUP: ScopeLookup = {
  brands: new Map(),
  outlets: new Map(),
  stations: new Map(),
};

/** The name of a scope target, or null when the caller cannot see the org tree. */
export function scopeName(
  scope: AssignmentScope,
  lookup: ScopeLookup,
): string | null {
  if (scope.type === "tenant") return null;
  const map =
    scope.type === "brand"
      ? lookup.brands
      : scope.type === "outlet"
        ? lookup.outlets
        : lookup.stations;
  return map.get(scope.id) ?? null;
}

/** True when a scope names a real target; `tenant` always does (no id). */
export function scopeIsComplete(scope: AssignmentScope): boolean {
  return scope.type === "tenant" || scope.id.length > 0;
}

// ------------------------------------------------------------------ validity

const INSTANT_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
});

/** "1 Nov 2026, 12.00" — instants shown in the outlet's default zone. */
export function formatInstant(value: string): string {
  return INSTANT_FORMAT.format(new Date(value));
}

export function validityIsOrdered(
  validFrom: string | null,
  validUntil: string | null,
): boolean {
  if (!validFrom || !validUntil) return true;
  return Date.parse(validUntil) > Date.parse(validFrom);
}

// -------------------------------------------------------------------- matrix

export type MatrixLevelDraft = { key: string; roleId: string };
export type MatrixTierDraft = {
  key: string;
  thresholdIdr: number | null;
  levels: MatrixLevelDraft[];
};
export type MatrixDraftRow = {
  actionType: ApprovalActionType;
  tiers: MatrixTierDraft[];
};

let draftKeySeed = 0;
export function nextDraftKey(prefix: string): string {
  draftKeySeed += 1;
  return `${prefix}-${draftKeySeed}`;
}

const ACTION_ORDER = new Map(
  APPROVAL_ACTION_TYPES.map((action, index) => [action, index]),
);

function compareTiers(a: MatrixTierDraft, b: MatrixTierDraft): number {
  if (a.thresholdIdr === b.thresholdIdr) return 0;
  if (a.thresholdIdr === null) return -1;
  if (b.thresholdIdr === null) return 1;
  return a.thresholdIdr - b.thresholdIdr;
}

/** Matrix policies → editable draft, one row per action that has policies. */
export function matrixDraftFromPolicies(
  policies: readonly ApprovalPolicy[],
): MatrixDraftRow[] {
  type Tier = { thresholdIdr: number | null; levels: Map<number, string> };
  const byAction = new Map<ApprovalActionType, Tier[]>();
  for (const policy of policies) {
    const tiers = byAction.get(policy.actionType) ?? [];
    let tier = tiers.find((row) => row.thresholdIdr === policy.thresholdIdr);
    if (!tier) {
      tier = { thresholdIdr: policy.thresholdIdr, levels: new Map() };
      tiers.push(tier);
    }
    tier.levels.set(policy.levels, policy.approverRoleId);
    byAction.set(policy.actionType, tiers);
  }
  return [...byAction.entries()]
    .sort(([a], [b]) => (ACTION_ORDER.get(a) ?? 0) - (ACTION_ORDER.get(b) ?? 0))
    .map(([actionType, tiers]) => ({
      actionType,
      tiers: tiers
        .map((tier) => ({
          key: nextDraftKey("tier"),
          thresholdIdr: tier.thresholdIdr,
          levels: [...tier.levels.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, roleId]) => ({ key: nextDraftKey("level"), roleId })),
        }))
        .sort(compareTiers),
    }));
}

export type MatrixIssue = {
  kind: "empty" | "missing_level" | "no_approver" | "bad_threshold";
  actionType: ApprovalActionType | null;
  tierKey: string | null;
};

/**
 * Client-side mirror of approvalMatrixSchema (§3.7): levels contiguous from 1,
 * one approver role per level, no duplicate role inside a level, thresholds
 * non-negative. The API enforces the same rules; this only shortens the loop.
 */
export function matrixIssues(draft: readonly MatrixDraftRow[]): MatrixIssue[] {
  const issues: MatrixIssue[] = [];
  if (draft.every((row) => row.tiers.length === 0))
    issues.push({ kind: "empty", actionType: null, tierKey: null });
  for (const row of draft) {
    for (const tier of row.tiers) {
      if (tier.thresholdIdr !== null && !(tier.thresholdIdr >= 0))
        issues.push({
          kind: "bad_threshold",
          actionType: row.actionType,
          tierKey: tier.key,
        });
      for (const level of tier.levels) {
        if (level.roleId === "")
          issues.push({
            kind: "no_approver",
            actionType: row.actionType,
            tierKey: tier.key,
          });
      }
      if (tier.levels.length === 0 || tier.levels[0]?.roleId === "")
        issues.push({
          kind: "missing_level",
          actionType: row.actionType,
          tierKey: tier.key,
        });
    }
  }
  return issues;
}

/** The request body for PUT /api/access/approval-policies (ids are server-side). */
export function matrixPoliciesFromDraft(draft: readonly MatrixDraftRow[]): {
  actionType: ApprovalActionType;
  thresholdIdr: Idr | null;
  approverRoleId: RoleId;
  levels: number;
}[] {
  return draft.flatMap((row) =>
    row.tiers.flatMap((tier) =>
      tier.levels.flatMap((level, index) =>
        level.roleId === ""
          ? []
          : [
              {
                actionType: row.actionType,
                thresholdIdr:
                  tier.thresholdIdr === null
                    ? null
                    : (tier.thresholdIdr as Idr),
                approverRoleId: level.roleId as RoleId,
                levels: index + 1,
              },
            ],
      ),
    ),
  );
}

export type MatrixCoverage = {
  covered: number;
  total: number;
  uncovered: ApprovalActionType[];
};

/** Actions without any policy are denied to everyone (fail closed). */
export function matrixCoverage(
  draft: readonly { actionType: ApprovalActionType; tiers: unknown[] }[],
): MatrixCoverage {
  const covered = new Set(
    draft.filter((row) => row.tiers.length > 0).map((row) => row.actionType),
  );
  const uncovered = APPROVAL_ACTION_TYPES.filter(
    (action) => !covered.has(action),
  );
  return {
    covered: covered.size,
    total: APPROVAL_ACTION_TYPES.length,
    uncovered,
  };
}

export function addTier(
  row: MatrixDraftRow,
  options: { thresholdIdr?: number | null; roleId?: string } = {},
): MatrixDraftRow {
  return {
    ...row,
    tiers: [
      ...row.tiers,
      {
        key: nextDraftKey("tier"),
        thresholdIdr: options.thresholdIdr ?? null,
        levels: [{ key: nextDraftKey("level"), roleId: options.roleId ?? "" }],
      },
    ].sort(compareTiers),
  };
}

export function removeTier(
  row: MatrixDraftRow,
  tierKey: string,
): MatrixDraftRow {
  return { ...row, tiers: row.tiers.filter((tier) => tier.key !== tierKey) };
}

export function setTierThreshold(
  row: MatrixDraftRow,
  tierKey: string,
  thresholdIdr: number | null,
): MatrixDraftRow {
  return {
    ...row,
    tiers: row.tiers
      .map((tier) => (tier.key === tierKey ? { ...tier, thresholdIdr } : tier))
      .sort(compareTiers),
  };
}

export function setLevelRole(
  row: MatrixDraftRow,
  tierKey: string,
  levelKey: string,
  roleId: string,
): MatrixDraftRow {
  return {
    ...row,
    tiers: row.tiers.map((tier) =>
      tier.key === tierKey
        ? {
            ...tier,
            levels: tier.levels.map((level) =>
              level.key === levelKey ? { ...level, roleId } : level,
            ),
          }
        : tier,
    ),
  };
}

export function addLevel(row: MatrixDraftRow, tierKey: string): MatrixDraftRow {
  return {
    ...row,
    tiers: row.tiers.map((tier) =>
      tier.key === tierKey && tier.levels.length < APPROVAL_MAX_LEVELS
        ? {
            ...tier,
            levels: [
              ...tier.levels,
              { key: nextDraftKey("level"), roleId: "" },
            ],
          }
        : tier,
    ),
  };
}

export function removeLevel(
  row: MatrixDraftRow,
  tierKey: string,
  levelKey: string,
): MatrixDraftRow {
  return {
    ...row,
    tiers: row.tiers.map((tier) =>
      tier.key === tierKey
        ? {
            ...tier,
            levels:
              tier.levels.length === 1
                ? tier.levels
                : tier.levels.filter((level) => level.key !== levelKey),
          }
        : tier,
    ),
  };
}

/** Roles offered as approvers: tenant roles the matrix may name. */
export function matrixApproverRoles(roles: readonly Role[]): Role[] {
  return roles.filter((role) => role.permissions.length > 0);
}

/**
 * Route loaders skip the SSR prefetch when the URL asks for a mock scenario
 * (?mock=empty|slow|error|offline): the scenario lives in the browser, so a
 * server-prefetched page would otherwise never show the state.
 */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}

export function actionLabelKey(action: ApprovalActionType): MessageKey {
  return `access.action.${action}` as MessageKey;
}

/** Adds an action without policies to the draft, with one empty tier. */
export function addActionRow(
  draft: readonly MatrixDraftRow[],
  actionType: ApprovalActionType,
): MatrixDraftRow[] {
  if (draft.some((row) => row.actionType === actionType)) return [...draft];
  return [
    ...draft,
    {
      actionType,
      tiers: [
        {
          key: nextDraftKey("tier"),
          thresholdIdr: null,
          levels: [{ key: nextDraftKey("level"), roleId: "" }],
        },
      ],
    },
  ].sort(
    (a, b) =>
      (ACTION_ORDER.get(a.actionType) ?? 0) -
      (ACTION_ORDER.get(b.actionType) ?? 0),
  );
}

export function removeActionRow(
  draft: readonly MatrixDraftRow[],
  actionType: ApprovalActionType,
): MatrixDraftRow[] {
  return draft.filter((row) => row.actionType !== actionType);
}
