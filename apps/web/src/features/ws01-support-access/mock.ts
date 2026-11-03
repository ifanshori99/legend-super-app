// Mock mode for support access (VITE_API_MOCK=true; PRD v1.7 §3 F4, TEN-04).
//
// Session times are rebased on the mock's own clock so the active session has
// a real countdown. The mock cannot compute TOTP: any 6-digit code is
// accepted except 000000, which simulates a wrong code. Opening a second
// session for the same tenant answers SUPPORT_ACCESS_ALREADY_ACTIVE, as the
// API does. The scenarios (empty/error/slow/offline) come from the runtime.
import {
  cafeLegendPlatformFixtures,
  orgEndpoints,
  platformEndpoints,
  supportAccessExpiry,
  supportAccessGrantSchema,
  supportAccessStatus,
  tenantSchema,
  type SupportAccessGrant,
} from "@starter/shared/platform";
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";

const fixtures = cafeLegendPlatformFixtures;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function grantId(n: number): string {
  return `5ac0000b-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

type Seed = {
  n: number;
  tenantId: string;
  reason: string;
  startOffset: number;
  durationMinutes: 15 | 30 | 60 | 120;
  endedAfterMs?: number;
};

function build(seed: Seed): SupportAccessGrant {
  const startedAt = iso(seed.startOffset);
  const endedAt =
    seed.endedAfterMs === undefined
      ? null
      : new Date(Date.parse(startedAt) + seed.endedAfterMs).toISOString();
  return supportAccessGrantSchema.parse({
    id: grantId(seed.n),
    tenantId: seed.tenantId,
    superAdminUserId: fixtures.superAdmin.id,
    reason: seed.reason,
    accessMode: "read_only",
    durationMinutes: seed.durationMinutes,
    startedAt,
    expiresAt: supportAccessExpiry(startedAt, seed.durationMinutes),
    mfaVerifiedAt: new Date(Date.parse(startedAt) - 20_000).toISOString(),
    tenantAdminNotifiedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
    endedAt,
    endedBy: endedAt ? fixtures.superAdmin.id : null,
  });
}

const grants = createMockStore<SupportAccessGrant[]>(() => [
  build({
    n: 3,
    tenantId: fixtures.tenant.id,
    reason:
      "Membantu admin tenant memeriksa pengaturan pajak yang tidak tampil di struk.",
    startOffset: -12 * MINUTE,
    durationMinutes: 60,
  }),
  build({
    n: 2,
    tenantId: fixtures.tenant.id,
    reason:
      "Memeriksa laporan selisih kas outlet BDG-01 atas permintaan owner.",
    startOffset: -3 * DAY,
    durationMinutes: 60,
    endedAfterMs: 25 * MINUTE,
  }),
  build({
    n: 1,
    tenantId: fixtures.suspendedTenant.id,
    reason:
      "Mengecek data tagihan sebelum tenant ditangguhkan atas permintaan finance.",
    startOffset: -9 * DAY,
    durationMinutes: 30,
  }),
]);

const tenants = [fixtures.tenant, fixtures.suspendedTenant].map((row) =>
  tenantSchema.parse(row),
);

function sorted(rows: readonly SupportAccessGrant[]) {
  return [...rows].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
}

// platformEndpoints.listTenants is served by ws01-platform-tenants/mock.ts.

registerMock(platformEndpoints.listSupportAccess, ({ query, scenario }) =>
  paginateFixture(
    sorted(
      grants
        .get()
        .filter((row) => !query.tenantId || row.tenantId === query.tenantId),
    ),
    query,
    (row) => row.id,
    scenario,
  ),
);

registerMock(orgEndpoints.listSupportAccess, ({ query, scenario }) =>
  paginateFixture(
    sorted(grants.get().filter((row) => row.tenantId === fixtures.tenant.id)),
    query,
    (row) => row.id,
    scenario,
  ),
);

registerMock(platformEndpoints.requestSupportAccess, ({ params, body }) => {
  const tenant = tenants.find((row) => row.id === params.tenantId);
  if (!tenant) throw new ApiError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  if (body.mfaCode === "000000")
    throw new ApiError(
      401,
      "MFA_INVALID",
      "Kode verifikasi salah atau kedaluwarsa.",
    );
  const now = new Date();
  const running = grants
    .get()
    .some(
      (row) =>
        row.tenantId === tenant.id &&
        supportAccessStatus(row, now) === "active",
    );
  if (running)
    throw new ApiError(
      409,
      "SUPPORT_ACCESS_ALREADY_ACTIVE",
      "Anda sudah memiliki sesi support access aktif untuk tenant ini.",
    );
  const startedAt = now.toISOString();
  const created = supportAccessGrantSchema.parse({
    id: grantId(0x100 + grants.get().length),
    tenantId: tenant.id,
    superAdminUserId: fixtures.superAdmin.id,
    reason: body.reason,
    accessMode: body.accessMode,
    durationMinutes: body.durationMinutes,
    startedAt,
    expiresAt: supportAccessExpiry(startedAt, body.durationMinutes),
    mfaVerifiedAt: new Date(now.getTime() - 1000).toISOString(),
    tenantAdminNotifiedAt: startedAt,
    endedAt: null,
    endedBy: null,
  });
  grants.set([created, ...grants.get()]);
  return { data: created };
});

registerMock(platformEndpoints.endSupportAccess, ({ params }) => {
  const current = grants.get().find((row) => row.id === params.grantId);
  if (!current) throw new ApiError(404, "NOT_FOUND", "Sesi tidak ditemukan.");
  const now = new Date();
  if (supportAccessStatus(current, now) !== "active")
    throw new ApiError(409, "CONFLICT", "Sesi ini sudah berakhir.");
  const ended = supportAccessGrantSchema.parse({
    ...current,
    endedAt: now.toISOString(),
    endedBy: fixtures.superAdmin.id,
  });
  grants.set(grants.get().map((row) => (row.id === ended.id ? ended : row)));
  return { data: ended };
});
