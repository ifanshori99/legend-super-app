// Mock handlers for the Panel Platform tenant endpoints (VITE_API_MOCK=true).
// Tenants, packages and Cafe Legend usage come from @starter/shared fixtures;
// a few extra sample tenants make search, filters and cursor paging real.
// Brand/outlet/legal-entity reads stay with their existing owners (ws01-access,
// ws07-accounting); this file only registers the create calls and the
// platform endpoints.
//
// Single owner of the in-memory tenant store: list, detail, usage, status AND
// package changes (setTenantPackage) all read and write `tenants` below, so a
// package changed on /platform/paket (ws01-platform-ops) shows on the tenant
// list and detail, and vice versa. Other features must not keep their own
// tenant copy: read it with `getMockTenant` / `listMockTenants` and react to
// writes with `onMockTenantChange` (e.g. to append an audit row).
import {
  COST_CAPS,
  COUNT_QUOTAS,
  brandSchema,
  cafeLegendPlatformFixtures,
  canRestoreFrom,
  canTransitionTenant,
  checkCountQuota,
  modulesOutsidePackage,
  evaluateCostCap,
  legalEntitySchema,
  orgEndpoints,
  outletRestoreWindowSchema,
  outletSchema,
  platformEndpoints,
  restoreDeadline,
  tenantOwnerAssignmentSchema,
  tenantRestoreWindowSchema,
  tenantSchema,
  tenantUsageSchema,
  tenantUsageViewSchema,
  npwpLast4,
} from "@starter/shared/platform";
import type {
  Outlet,
  Tenant,
  TenantOwnerAssignment,
} from "@starter/shared/platform";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { paginateFixture } from "@/lib/mock/paginate";
import { createMockStore } from "@/lib/mock/store";

const fx = cafeLegendPlatformFixtures;
const NOW = () => new Date().toISOString();

function fixedId(n: number): string {
  return `7e7a0000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

// Sample tenants (illustrative names; the screen shows a "Contoh data" badge).
const SAMPLES: Array<[string, string, string, Tenant["status"]]> = [
  ["Roti Pagi Bakery", "roti-pagi", "outlet-dasar", "active"],
  ["Warung Senja", "warung-senja", "outlet-dasar", "active"],
  ["Kopi Tepi Sawah", "kopi-tepi-sawah", "lengkap", "active"],
  ["Dapur Nusantara", "dapur-nusantara", "lengkap", "active"],
  ["Mie Ayam Sentosa", "mie-ayam-sentosa", "outlet-dasar", "suspended"],
  ["Teh Tarik Corner", "teh-tarik-corner", "outlet-dasar", "active"],
  ["Sate Maranggi Jaya", "sate-maranggi", "lengkap", "active"],
  ["Bubur Pak Haji", "bubur-pak-haji", "outlet-dasar", "archived"],
  ["Es Kopi Kampus", "es-kopi-kampus", "outlet-dasar", "active"],
  ["Bakso Rusuk 99", "bakso-rusuk-99", "lengkap", "suspended"],
  ["Pastry Lembang", "pastry-lembang", "lengkap", "active"],
  ["Nasi Goreng Gaul", "nasi-goreng-gaul", "outlet-dasar", "active"],
  // Archived 45 days ago: past the 30-day restore window (Q40), so final.
  ["Kedai Lawas", "kedai-lawas", "outlet-dasar", "archived"],
];

/** Restore-window mock tenants (fixedId(10 + index) of SAMPLES). */
export const MOCK_ARCHIVED_TENANT_ID = fixedId(17); // Bubur Pak Haji, 10 days ago
export const MOCK_EXPIRED_TENANT_ID = fixedId(22); // Kedai Lawas, 45 days ago
/** The closed sample outlet (Cafe Legend), closed 5 days ago. */
export const MOCK_CLOSED_OUTLET_ID = fixedId(0xc1);
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

function seedTenants(): Tenant[] {
  const generated = SAMPLES.map(([name, slug, plan, status], index) => {
    const pkg = fx.packages.find((p) => p.key === plan) ?? fx.packages[0];
    return tenantSchema.parse({
      ...fx.tenant,
      id: fixedId(10 + index),
      slug,
      name,
      plan: pkg.key,
      status,
      deploymentMode: "shared",
      featureFlags: { modules: pkg.modules, integrationProviders: [] },
      limits: pkg.defaultLimits,
      createdAt: new Date(Date.UTC(2026, 9, 1 + index, 3)).toISOString(),
    });
  });
  return [fx.tenant, fx.suspendedTenant, ...generated];
}

const tenants = createMockStore<Tenant[]>(seedTenants);

// What the server records at archive / close time (`archived_at` +
// `status_before_archive`). A row archived without a record is a legacy row:
// final, RESTORE_NOT_AVAILABLE.
type Transition = { at: string; restoreTo: "active" | "suspended" };
const archives = createMockStore<Record<string, Transition>>(() => ({
  [MOCK_ARCHIVED_TENANT_ID]: {
    at: daysAgo(10).toISOString(),
    restoreTo: "active",
  },
  [MOCK_EXPIRED_TENANT_ID]: {
    at: daysAgo(45).toISOString(),
    restoreTo: "active",
  },
}));
const createdOrgCounts = createMockStore<Record<string, number>>(() => ({}));

function find(tenantId: string): Tenant {
  const row = tenants.get().find((t) => t.id === tenantId);
  if (!row) throw new ApiError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  return row;
}

// ------------------------------------------- shared read/subscribe helpers

/** A change to one tenant row, with the operator's audited reason. */
export type MockTenantChange = {
  kind: "status" | "package";
  before: Tenant;
  after: Tenant;
  reason: string;
};

const listeners = new Set<(change: MockTenantChange) => void>();

/** Current mock tenant (undefined when unknown). Read-only snapshot. */
export const getMockTenant = (tenantId: string): Tenant | undefined =>
  tenants.get().find((t) => t.id === tenantId);

/** All mock tenants, newest first. Read-only snapshot. */
export const listMockTenants = (): readonly Tenant[] => tenants.get();

/** Subscribe to status/package writes; returns the unsubscribe function. */
export function onMockTenantChange(
  listener: (change: MockTenantChange) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(change: MockTenantChange): Tenant {
  if (change.kind === "status") {
    const rest = { ...archives.get() };
    delete rest[change.after.id];
    const before = change.before.status;
    archives.set(
      change.after.status === "archived" &&
        (before === "active" || before === "suspended")
        ? { ...rest, [change.after.id]: { at: NOW(), restoreTo: before } }
        : rest,
    );
  }
  tenants.set(
    tenants.get().map((t) => (t.id === change.after.id ? change.after : t)),
  );
  for (const listener of listeners) listener(change);
  return change.after;
}

registerMock(platformEndpoints.listPackages, ({ scenario }) => ({
  data: scenario === "empty" ? [] : fx.packages,
}));

registerMock(platformEndpoints.listTenants, ({ query, scenario }) => {
  const q = query.q?.toLowerCase();
  const rows = tenants
    .get()
    .filter(
      (t) =>
        (!query.status || t.status === query.status) &&
        (!q ||
          t.name.toLowerCase().includes(q) ||
          t.slug.toLowerCase().includes(q)),
    );
  return paginateFixture(
    rows,
    { cursor: query.cursor, limit: query.limit },
    (t) => t.id,
    scenario,
  );
});

registerMock(platformEndpoints.getTenant, ({ params }) => ({
  data: find(params.tenantId),
}));

registerMock(platformEndpoints.createTenant, ({ body }) => {
  if (tenants.get().some((t) => t.slug === body.slug))
    throw new ApiError(409, "CONFLICT", "Slug sudah dipakai tenant lain.", [
      { field: "slug", message: "Slug sudah dipakai tenant lain." },
    ]);
  const row = tenantSchema.parse({
    id: crypto.randomUUID(),
    slug: body.slug,
    name: body.name,
    plan: body.plan,
    status: "active",
    deploymentMode: body.deploymentMode,
    featureFlags: body.featureFlags,
    limits: body.limits,
    createdBy: fx.superAdmin.id,
    createdAt: NOW(),
  });
  tenants.set([row, ...tenants.get()]);
  return { data: row };
});

registerMock(platformEndpoints.setTenantStatus, ({ params, body }) => {
  const current = find(params.tenantId);
  if (!canTransitionTenant(current.status, body.status))
    throw new ApiError(
      409,
      "INVALID_TRANSITION",
      "Perubahan status ini tidak diizinkan.",
    );
  const next: Tenant = { ...current, status: body.status };
  return {
    data: commit({
      kind: "status",
      before: current,
      after: next,
      reason: body.reason,
    }),
  };
});

// PUT /api/platform/tenants/:tenantId/package: the plan, its module flags and
// limits change together; modules must stay inside the chosen package.
registerMock(platformEndpoints.setTenantPackage, ({ params, body }) => {
  const current = find(params.tenantId);
  const pkg = fx.packages.find((p) => p.key === body.plan);
  if (!pkg || pkg.status !== "active")
    throw new ApiError(404, "NOT_FOUND", "Paket tidak ditemukan.");
  const outside = modulesOutsidePackage(body.featureFlags.modules, pkg);
  if (outside.length > 0)
    throw new ApiError(
      422,
      "MODULE_NOT_IN_PACKAGE",
      "Modul ini tidak termasuk paket yang dipilih.",
      outside.map((field) => ({
        field: `featureFlags.modules.${field}`,
        message: "Tidak termasuk paket.",
      })),
    );
  const next = tenantSchema.parse({
    ...current,
    plan: body.plan,
    featureFlags: body.featureFlags,
    limits: body.limits,
  });
  return {
    data: commit({
      kind: "package",
      before: current,
      after: next,
      reason: body.reason,
    }),
  };
});

registerMock(platformEndpoints.getTenantUsage, ({ params }) => {
  const tenant = find(params.tenantId);
  const index = tenants.get().findIndex((t) => t.id === tenant.id);
  const isLegend = tenant.id === fx.tenant.id;
  const created = createdOrgCounts.get()[tenant.id] ?? 0;
  const l = tenant.limits;
  const usage = isLegend
    ? fx.usage
    : tenantUsageSchema.parse({
        month: fx.usage.month,
        outlets: created || Math.min(l.maxOutlets, 1 + (index % 2)),
        activeEmployees: created ? 0 : Math.floor(l.maxActiveEmployees * 0.4),
        devices: created ? 0 : Math.floor(l.maxDevices * 0.3),
        aiRequests: 0,
        whatsappCostIdr: 0,
        aiCostIdr: 0,
        emailCostIdr: created ? 0 : 5_000,
      });
  return {
    data: tenantUsageViewSchema.parse({
      usage,
      limits: l,
      quotas: COUNT_QUOTAS.map((quota) => {
        const r = checkCountQuota(l, usage, quota, 0);
        return {
          quota,
          limit: r.limit,
          used: r.used,
          remaining: r.remaining,
        };
      }),
      costCaps: COST_CAPS.map((cap) => {
        const r = evaluateCostCap(l, usage, cap);
        return {
          cap,
          state: r.state,
          capIdr: r.capIdr,
          spentIdr: r.spentIdr,
          remainingIdr: r.remainingIdr,
        };
      }),
    }),
  };
});

// ------------------------------------------------ org creates (wizard step)
// The real endpoints take the tenant from the session; the mock attributes the
// rows to the newest tenant (the one the wizard just created).
const newestTenantId = () => tenants.get()[0]?.id ?? fx.tenant.id;
const bump = () => {
  const id = newestTenantId();
  const counts = createdOrgCounts.get();
  counts[id] = (counts[id] ?? 0) + 1;
};

registerMock(orgEndpoints.createLegalEntity, ({ body }) => ({
  data: legalEntitySchema.parse({
    id: crypto.randomUUID(),
    tenantId: newestTenantId(),
    name: body.name,
    npwpLast4: body.npwp ? npwpLast4(body.npwp) : null,
    isPkp: body.isPkp,
    address: body.address,
    bankAccountIds: [],
    createdAt: NOW(),
  }),
}));

registerMock(orgEndpoints.createBrand, ({ body }) => ({
  data: brandSchema.parse({
    id: crypto.randomUUID(),
    tenantId: newestTenantId(),
    slug: body.slug,
    name: body.name,
    logoMediaId: body.logoMediaId,
    themeId: null,
    primaryHostname: null,
    createdAt: NOW(),
  }),
}));

registerMock(orgEndpoints.createOutlet, ({ body }) => {
  bump();
  return {
    data: outletSchema.parse({
      id: crypto.randomUUID(),
      tenantId: newestTenantId(),
      brandId: body.brandId,
      legalEntityId: body.legalEntityId,
      code: body.code,
      name: body.name,
      address: body.address,
      regionId: body.regionId,
      geofence: body.geofence,
      timeZone: body.timeZone,
      businessDayCutoff: body.businessDayCutoff,
      openingHours: body.openingHours,
      edgeNodeId: null,
      status: "preopening",
      createdAt: NOW(),
    }),
  };
});

// -------------------------------------------- restore window (Q40, 30 days)
// The window is read at call time, so "restorable" flips with the clock. Error
// codes and statuses follow platform/errors.ts: 409 RESTORE_NOT_AVAILABLE for
// a record that is not archived/closed or has no recorded time, 409
// RESTORE_WINDOW_EXPIRED past 30 days.

const restoreError = (
  code: "RESTORE_NOT_AVAILABLE" | "RESTORE_WINDOW_EXPIRED",
) =>
  new ApiError(
    409,
    code,
    code === "RESTORE_NOT_AVAILABLE"
      ? "Status ini tidak dapat dipulihkan karena waktu arsip atau tutup tidak tercatat."
      : "Batas 30 hari untuk memulihkan sudah lewat; status ini final.",
  );

function tenantWindow(tenant: Tenant) {
  const record = archives.get()[tenant.id];
  const archived = tenant.status === "archived";
  const at = archived && record ? new Date(record.at) : null;
  const check = canRestoreFrom(at, record?.restoreTo ?? null, new Date());
  return tenantRestoreWindowSchema.parse({
    tenantId: tenant.id,
    status: tenant.status,
    archivedAt: archived && record ? record.at : null,
    restoreTo: archived && record ? record.restoreTo : null,
    restorableUntil: archived && at ? restoreDeadline(at).toISOString() : null,
    restorable: archived && check.ok,
  });
}

registerMock(platformEndpoints.getTenantRestoreWindow, ({ params }) => ({
  data: tenantWindow(find(params.tenantId)),
}));

registerMock(platformEndpoints.restoreTenant, ({ params, body }) => {
  const current = find(params.tenantId);
  const record = archives.get()[current.id];
  const check = canRestoreFrom(
    current.status === "archived" && record ? new Date(record.at) : null,
    record?.restoreTo ?? null,
    new Date(),
  );
  if (!check.ok || !record)
    throw restoreError(check.ok ? "RESTORE_NOT_AVAILABLE" : check.code);
  return {
    data: commit({
      kind: "status",
      before: current,
      after: { ...current, status: record.restoreTo },
      reason: body.reason,
    }),
  };
});

// One closed outlet (Cafe Legend's first outlet, renamed so it reads as a
// separate row). `listOutlets` is owned by ws07-accounting and does not return
// it, so the panel only reaches it once that mock lists a closed outlet.
const closedOutlet = (): Outlet => ({
  ...fx.outlets[0],
  id: MOCK_CLOSED_OUTLET_ID as Outlet["id"],
  code: "TUTUP1",
  name: "Cafe Legend Cabang Lama",
  status: "closed",
});
const closedOutlets = createMockStore<{
  outlet: Outlet;
  closedAt: string;
  restoreTo: "preopening" | "active";
}>(() => ({
  outlet: closedOutlet(),
  closedAt: daysAgo(5).toISOString(),
  restoreTo: "active",
}));

function findClosedOutlet(tenantId: string, outletId: string) {
  const row = closedOutlets.get();
  if (row.outlet.tenantId !== tenantId || row.outlet.id !== outletId)
    throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  return row;
}

registerMock(platformEndpoints.getOutletRestoreWindow, ({ params }) => {
  const row = findClosedOutlet(params.tenantId, params.outletId);
  const closed = row.outlet.status === "closed";
  const at = new Date(row.closedAt);
  const check = canRestoreFrom(closed ? at : null, row.restoreTo, new Date());
  return {
    data: outletRestoreWindowSchema.parse({
      tenantId: row.outlet.tenantId,
      outletId: row.outlet.id,
      status: row.outlet.status,
      closedAt: closed ? row.closedAt : null,
      restoreTo: closed ? row.restoreTo : null,
      restorableUntil: closed ? restoreDeadline(at).toISOString() : null,
      restorable: closed && check.ok,
    }),
  };
});

registerMock(platformEndpoints.restoreOutlet, ({ params }) => {
  const row = findClosedOutlet(params.tenantId, params.outletId);
  const check = canRestoreFrom(
    row.outlet.status === "closed" ? new Date(row.closedAt) : null,
    row.restoreTo,
    new Date(),
  );
  if (!check.ok) throw restoreError(check.code);
  const outlet = { ...row.outlet, status: row.restoreTo };
  closedOutlets.set({ ...row, outlet });
  return { data: outlet };
});

// ------------------------------------------------- tenant Owner (Q44)
// No list endpoint exists, so the screen starts "empty" (owner unknown) and
// learns the assignment from the assign response. The mock keeps one Owner
// per tenant. Any 6-digit code passes except 000000 (MFA_INVALID); a missing
// code is 403 MFA_REQUIRED. 409: the account already is the Owner, or the
// assignment being replaced no longer is the current Owner.
const OWNER_ROLE_ID = fixedId(0x0b);
const owners = createMockStore<Record<string, TenantOwnerAssignment>>(
  () => ({}),
);

function ownerAccount(
  account: { userId: string } | { invite: unknown },
): Pick<TenantOwnerAssignment, "userId" | "account"> {
  if ("userId" in account)
    return {
      userId: account.userId as TenantOwnerAssignment["userId"],
      account: "member",
    };
  return {
    userId: crypto.randomUUID() as TenantOwnerAssignment["userId"],
    account: "invited",
  };
}

function writeOwner(
  tenantId: string,
  body: { account: { userId: string } | { invite: unknown }; mfaCode?: string },
  replacing: string | null,
) {
  find(tenantId);
  if (body.mfaCode === undefined)
    throw new ApiError(403, "MFA_REQUIRED", "Kode MFA diperlukan.");
  if (body.mfaCode === "000000")
    throw new ApiError(
      401,
      "MFA_INVALID",
      "Kode verifikasi salah atau kedaluwarsa.",
    );
  const current = owners.get()[tenantId];
  if (replacing !== null && current?.assignmentId !== replacing)
    throw new ApiError(
      409,
      "CONFLICT",
      "Owner ini sudah berganti. Muat ulang halaman.",
    );
  const next = ownerAccount(body.account);
  if (current && current.userId === next.userId)
    throw new ApiError(
      409,
      "CONFLICT",
      "Akun ini sudah menjadi Owner tenant ini.",
    );
  if (replacing === null && current)
    throw new ApiError(
      409,
      "CONFLICT",
      "Tenant ini sudah punya Owner. Gunakan Ganti Owner.",
    );
  const row = tenantOwnerAssignmentSchema.parse({
    tenantId,
    assignmentId: crypto.randomUUID(),
    userId: next.userId,
    roleId: OWNER_ROLE_ID,
    account: next.account,
    replacedAssignmentId: replacing,
  });
  owners.set({ ...owners.get(), [tenantId]: row });
  return { data: row };
}

registerMock(platformEndpoints.assignTenantOwner, ({ params, body }) =>
  writeOwner(params.tenantId, body, null),
);

registerMock(platformEndpoints.replaceTenantOwner, ({ params, body }) =>
  writeOwner(params.tenantId, body, params.assignmentId),
);
