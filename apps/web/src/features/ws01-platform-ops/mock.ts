// Mock mode for the platform ops screens (VITE_API_MOCK=true; bead legend-y6s).
// Serves the Cafe Legend platform fixtures through the same contract objects
// the API will use. Scenarios (?mock=empty|slow|error|offline) come from the
// runtime; "empty" is handled here so every list shows its empty state.
//
// Endpoint ownership: the audit list is this feature's alone (contract gap).
// The platform endpoints below (packages, tenants, tenant, usage, package
// change) are read by the tenant list/detail screens too, so they are
// registered after every eager mock module has loaded and only when nobody
// else registered them: one owner per endpoint (lib/mock/registry.ts).
import { auditEventSchema, type AuditEvent } from "@starter/shared/audit";
import {
  cafeLegendPlatformFixtures as fixtures,
  checkCountQuota,
  COST_CAPS,
  COUNT_QUOTAS,
  evaluateCostCap,
  modulesOutsidePackage,
  platformEndpoints,
  tenantSchema,
  tenantUsageSchema,
  type Tenant,
  type TenantUsage,
} from "@starter/shared/platform";
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock, type MockContext } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { listPlatformAuditEvents } from "./contract-gap";
import { auditMatches } from "./logic";

function uuid(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}
const ulid = (n: number) =>
  `01JBQ7Z8K3M4N5P6Q7R8S${String(n).padStart(5, "0")}`;

const tenants = createMockStore<Tenant[]>(() =>
  [fixtures.tenant, fixtures.suspendedTenant].map((row) =>
    tenantSchema.parse(structuredClone(row)),
  ),
);

/** The sample suspended tenant has no fixture usage; it runs a small outlet. */
const suspendedUsage = tenantUsageSchema.parse({
  month: fixtures.usage.month,
  outlets: 1,
  activeEmployees: 12,
  devices: 6,
  aiRequests: 0,
  whatsappCostIdr: 0,
  aiCostIdr: 0,
  emailCostIdr: 0,
});

function usageOf(tenant: Tenant): TenantUsage {
  return tenant.id === fixtures.tenant.id ? fixtures.usage : suspendedUsage;
}

function findTenant(tenantId: string): Tenant {
  const found = tenants.get().find((row) => row.id === tenantId);
  if (!found) throw new ApiError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  return found;
}

// ---------------------------------------------------------------- audit data

const AUDIT_SEED: readonly {
  action: string;
  objectType: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason?: string;
  sensitive?: boolean;
}[] = [
  {
    action: "tenant.package_changed",
    objectType: "tenant",
    before: { plan: "outlet-dasar", maxOutlets: 1 },
    after: { plan: "lengkap", maxOutlets: 5 },
    reason: "Upgrade paket sesuai kontrak baru tenant.",
  },
  {
    action: "support_access.started",
    objectType: "support_access",
    before: null,
    after: { accessMode: "read_only", durationMinutes: 60 },
    reason: "Memeriksa laporan selisih kas atas permintaan owner.",
    sensitive: true,
  },
  {
    action: "settings.updated",
    objectType: "outlet",
    before: { status: "preopening" },
    after: { status: "active" },
  },
  {
    action: "integration.status_changed",
    objectType: "integration",
    before: { status: "draft" },
    after: { status: "active" },
  },
  {
    action: "role.updated",
    objectType: "role",
    before: { permissions: 12 },
    after: { permissions: 14 },
  },
  {
    action: "theme.activated",
    objectType: "theme",
    before: { version: 1 },
    after: { version: 2 },
  },
  {
    action: "support_access.ended",
    objectType: "support_access",
    before: { endedAt: null },
    after: { endedAt: "ditutup oleh Super Admin" },
  },
  {
    action: "tenant.status_changed",
    objectType: "tenant",
    before: { status: "active" },
    after: { status: "suspended" },
    reason: "Tagihan paket belum dibayar lebih dari 30 hari.",
  },
];
const ACTORS = ["user", "system", "ai", "mcp_client", "device"] as const;

function seedAudit(): AuditEvent[] {
  const base = Date.parse("2026-11-03T03:00:00.000Z");
  const deviceId = uuid("d3d30000", 1);
  return Array.from({ length: 34 }, (_, index) => {
    const seed = AUDIT_SEED[index % AUDIT_SEED.length]!;
    const onMain = index % 3 !== 2;
    const tenantId = onMain ? fixtures.tenant.id : fixtures.suspendedTenant.id;
    // Package/status changes are Super Admin actions; the rest cycle actors.
    const actorType =
      seed.action.startsWith("tenant.") || seed.action.startsWith("support_")
        ? "user"
        : ACTORS[index % ACTORS.length]!;
    return auditEventSchema.parse({
      id: ulid(900 - index),
      tenantId,
      outletId: onMain ? fixtures.outlets[0].id : null,
      actorType,
      actorId:
        actorType === "system"
          ? null
          : actorType === "device"
            ? deviceId
            : actorType === "user"
              ? fixtures.superAdmin.id
              : uuid("a1a10000", index + 1),
      deviceId: actorType === "device" ? deviceId : null,
      action: seed.action,
      objectType: seed.objectType,
      objectId: uuid("0b0b0000", index + 1),
      reason: seed.reason ?? null,
      maskedChanges: { before: seed.before, after: seed.after },
      ipHash: null,
      sensitiveAccess: seed.sensitive === true,
      retentionClass: "audit_2y",
      createdAt: new Date(base - index * 47 * 60_000).toISOString(),
    });
  });
}

const audit = createMockStore<AuditEvent[]>(seedAudit);

// ----------------------------------------------------------------- handlers

registerMock(listPlatformAuditEvents, ({ query, scenario }) =>
  paginateFixture(
    audit.get().filter((event) => auditMatches(event, query)),
    query,
    (event) => event.id,
    scenario,
  ),
);

const handlers = {
  listPackages: ({
    scenario,
  }: MockContext<typeof platformEndpoints.listPackages>) => ({
    data: scenario === "empty" ? [] : structuredClone(fixtures.packages),
  }),
  listTenants: ({
    query,
    scenario,
  }: MockContext<typeof platformEndpoints.listTenants>) =>
    paginateFixture(
      tenants
        .get()
        .filter(
          (row) =>
            (!query.status || row.status === query.status) &&
            (!query.q ||
              row.name.toLowerCase().includes(query.q.toLowerCase())),
        ),
      query,
      (row) => row.id,
      scenario,
    ),
  getTenant: ({ params }: MockContext<typeof platformEndpoints.getTenant>) => ({
    data: findTenant(params.tenantId),
  }),
  getTenantUsage: ({
    params,
  }: MockContext<typeof platformEndpoints.getTenantUsage>) => {
    const tenant = findTenant(params.tenantId);
    const usage = usageOf(tenant);
    return {
      data: {
        usage,
        limits: tenant.limits,
        quotas: COUNT_QUOTAS.map((quota) => {
          const { limit, used, remaining } = checkCountQuota(
            tenant.limits,
            usage,
            quota,
          );
          return { quota, limit, used, remaining };
        }),
        costCaps: COST_CAPS.map((cap) => {
          const { state, capIdr, spentIdr, remainingIdr } = evaluateCostCap(
            tenant.limits,
            usage,
            cap,
          );
          return { cap, state, capIdr, spentIdr, remainingIdr };
        }),
      },
    };
  },
  setTenantPackage: ({
    params,
    body,
  }: MockContext<typeof platformEndpoints.setTenantPackage>) => {
    const tenant = findTenant(params.tenantId);
    const pkg = fixtures.packages.find((row) => row.key === body.plan);
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
    const updated = tenantSchema.parse({
      ...tenant,
      plan: body.plan,
      featureFlags: body.featureFlags,
      limits: body.limits,
    });
    tenants.set(
      tenants.get().map((row) => (row.id === updated.id ? updated : row)),
    );
    audit.set([
      auditEventSchema.parse({
        id: ulid(1000 + audit.get().length),
        tenantId: tenant.id,
        outletId: null,
        actorType: "user",
        actorId: fixtures.superAdmin.id,
        deviceId: null,
        action: "tenant.package_changed",
        objectType: "tenant",
        objectId: tenant.id,
        reason: body.reason,
        maskedChanges: {
          before: {
            plan: tenant.plan,
            modules: tenant.featureFlags.modules.length,
          },
          after: {
            plan: updated.plan,
            modules: updated.featureFlags.modules.length,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: new Date().toISOString(),
      }),
      ...audit.get(),
    ]);
    return { data: updated };
  },
};

// listPackages / listTenants / getTenant / getTenantUsage are owned by
// ws01-platform-tenants/mock.ts (one owner per endpoint); this file owns the
// package change.
registerMock(platformEndpoints.setTenantPackage, handlers.setTenantPackage);
