// Mock mode for the platform ops screens (VITE_API_MOCK=true; bead legend-y6s).
// Scenarios (?mock=empty|slow|error|offline) come from the runtime.
//
// Endpoint ownership (one owner per endpoint, lib/mock/registry.ts): this file
// owns only the cross-tenant audit list (a contract gap, see contract-gap.ts).
// Packages, tenants, tenant usage AND the package/flag/limit change
// (setTenantPackage) belong to ws01-platform-tenants/mock.ts, so a change made
// on /platform/paket or /platform/kuota is the same tenant row the tenant list
// and detail screens read. The audit store is module state: it lives for the
// browser session and re-seeds on resetMockStores().
import { auditEventSchema, type AuditEvent } from "@starter/shared/audit";
import { cafeLegendPlatformFixtures as fixtures } from "@starter/shared/platform";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { listPlatformAuditEvents } from "./contract-gap";
import { auditMatches } from "./logic";

function uuid(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}
const ulid = (n: number) =>
  `01JBQ7Z8K3M4N5P6Q7R8S${String(n).padStart(5, "0")}`;

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

/**
 * Prepends one platform audit row (newest first). For the owner of a platform
 * write mock (ws01-platform-tenants/mock.ts setTenantPackage) so the change
 * shows up here in the same session. The row goes through auditEventSchema, so
 * an unmasked sensitive field is rejected like the real API would.
 */
export function recordPlatformAuditEvent(
  event: Omit<AuditEvent, "id" | "createdAt" | "retentionClass"> &
    Partial<Pick<AuditEvent, "createdAt">>,
): AuditEvent {
  const row = auditEventSchema.parse({
    retentionClass: "audit_2y",
    createdAt: new Date().toISOString(),
    ...event,
    id: ulid(1000 + audit.get().length),
  });
  audit.set([row, ...audit.get()]);
  return row;
}
