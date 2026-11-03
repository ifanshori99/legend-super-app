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
  canTransitionTenant,
  checkCountQuota,
  modulesOutsidePackage,
  evaluateCostCap,
  legalEntitySchema,
  orgEndpoints,
  outletSchema,
  platformEndpoints,
  tenantSchema,
  tenantUsageSchema,
  tenantUsageViewSchema,
  npwpLast4,
} from "@starter/shared/platform";
import type { Tenant } from "@starter/shared/platform";
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
];

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
