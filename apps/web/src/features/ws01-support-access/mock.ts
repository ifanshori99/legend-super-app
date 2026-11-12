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
  supportAccessRequestSchema,
  SUPPORT_ACCESS_APPROVAL_WINDOW_HOURS,
  supportAccessStatus,
  tenantSchema,
  type SupportAccessGrant,
  type SupportAccessRequest,
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
  if (body.accessMode === "read_write")
    throw new ApiError(
      409,
      "SUPPORT_ACCESS_OWNER_APPROVAL_REQUIRED",
      "Akses baca dan tulis harus disetujui owner tenant.",
    );
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

// read_write needs the tenant owner (legend-8r77t, founder Q37). The request
// waits up to 24 hours; approving opens a read_write grant, rejecting opens
// none. A decision on a decided or expired request answers 409.
const HOUR = 60 * MINUTE;
const OWNER_ID = "0c0c0000-0000-4000-8000-000000000001";

function requestId(n: number): string {
  return `5ac0000c-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function buildRequest(seed: {
  n: number;
  reason: string;
  requestedOffset: number;
  durationMinutes: 15 | 30;
  status: SupportAccessRequest["status"];
  grant?: SupportAccessGrant;
}): SupportAccessRequest {
  const requestedAt = iso(seed.requestedOffset);
  const decided = seed.status === "approved" || seed.status === "rejected";
  return supportAccessRequestSchema.parse({
    id: requestId(seed.n),
    tenantId: fixtures.tenant.id,
    superAdminUserId: fixtures.superAdmin.id,
    reason: seed.reason,
    accessMode: "read_write",
    durationMinutes: seed.durationMinutes,
    mfaVerifiedAt: new Date(Date.parse(requestedAt) - 20_000).toISOString(),
    requestedAt,
    approvalExpiresAt: new Date(
      Date.parse(requestedAt) + SUPPORT_ACCESS_APPROVAL_WINDOW_HOURS * HOUR,
    ).toISOString(),
    status: seed.status,
    decidedAt: decided
      ? new Date(Date.parse(requestedAt) + 10 * MINUTE).toISOString()
      : null,
    decidedBy: decided ? OWNER_ID : null,
    grantId: seed.grant?.id ?? null,
    ownerNotifiedAt: new Date(Date.parse(requestedAt) + 1000).toISOString(),
  });
}

const requests = createMockStore<SupportAccessRequest[]>(() => [
  buildRequest({
    n: 1,
    reason:
      "Memperbaiki selisih stok bahan baku outlet BDG-01 yang tidak bisa dikoreksi dari aplikasi.",
    requestedOffset: -2 * HOUR,
    durationMinutes: 30,
    status: "pending",
  }),
  buildRequest({
    n: 2,
    reason:
      "Mengoreksi nomor struk ganda pada transaksi kemarin atas permintaan owner.",
    requestedOffset: -2 * DAY,
    durationMinutes: 15,
    status: "rejected",
  }),
  buildRequest({
    n: 3,
    reason: "Membetulkan pengaturan pajak outlet setelah migrasi data awal.",
    requestedOffset: -3 * DAY,
    durationMinutes: 30,
    status: "expired",
  }),
]);

registerMock(orgEndpoints.listSupportAccessRequests, ({ query, scenario }) =>
  paginateFixture(
    [...requests.get()].sort(
      (a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt),
    ),
    query,
    (row) => row.id,
    scenario,
  ),
);

registerMock(
  platformEndpoints.requestSupportWriteAccess,
  ({ params, body }) => {
    const tenant = tenants.find((row) => row.id === params.tenantId);
    if (!tenant)
      throw new ApiError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
    if (body.mfaCode === "000000")
      throw new ApiError(
        401,
        "MFA_INVALID",
        "Kode verifikasi salah atau kedaluwarsa.",
      );
    const created = supportAccessRequestSchema.parse({
      id: requestId(0x100 + requests.get().length),
      tenantId: tenant.id,
      superAdminUserId: fixtures.superAdmin.id,
      reason: body.reason,
      accessMode: "read_write",
      durationMinutes: body.durationMinutes,
      mfaVerifiedAt: iso(-1000),
      requestedAt: iso(),
      approvalExpiresAt: iso(SUPPORT_ACCESS_APPROVAL_WINDOW_HOURS * HOUR),
      status: "pending",
      decidedAt: null,
      decidedBy: null,
      grantId: null,
      ownerNotifiedAt: iso(),
    });
    requests.set([created, ...requests.get()]);
    return { data: created };
  },
);

function decide(id: string, decision: "approve" | "reject") {
  const current = requests.get().find((row) => row.id === id);
  if (!current)
    throw new ApiError(404, "NOT_FOUND", "Permintaan tidak ditemukan.");
  const now = Date.now();
  if (
    current.status !== "pending" ||
    Date.parse(current.approvalExpiresAt) <= now
  )
    throw new ApiError(
      409,
      "CONFLICT",
      "Permintaan ini sudah diputuskan atau kedaluwarsa.",
    );
  let grant: SupportAccessGrant | undefined;
  if (decision === "approve") {
    const startedAt = new Date(now).toISOString();
    grant = supportAccessGrantSchema.parse({
      id: grantId(0x200 + grants.get().length),
      tenantId: current.tenantId,
      superAdminUserId: current.superAdminUserId,
      reason: current.reason,
      accessMode: "read_write",
      durationMinutes: current.durationMinutes,
      startedAt,
      expiresAt: supportAccessExpiry(startedAt, current.durationMinutes),
      mfaVerifiedAt: current.mfaVerifiedAt,
      tenantAdminNotifiedAt: startedAt,
      endedAt: null,
      endedBy: null,
    });
    grants.set([grant, ...grants.get()]);
  }
  const decided = supportAccessRequestSchema.parse({
    ...current,
    status: decision === "approve" ? "approved" : "rejected",
    decidedAt: new Date(now).toISOString(),
    decidedBy: OWNER_ID,
    grantId: grant?.id ?? null,
  });
  requests.set(requests.get().map((row) => (row.id === id ? decided : row)));
  return { data: decided };
}

registerMock(orgEndpoints.approveSupportAccessRequest, ({ params }) =>
  decide(params.requestId, "approve"),
);
registerMock(orgEndpoints.rejectSupportAccessRequest, ({ params }) =>
  decide(params.requestId, "reject"),
);
