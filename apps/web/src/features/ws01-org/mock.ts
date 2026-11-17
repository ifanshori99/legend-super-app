// Mock handlers for outlet settings (`VITE_API_MOCK=true`), so the screen
// works with no API (docs/frontend.md "Typed endpoints and mock mode").
//
// One owner per endpoint (bead legend-jzud): `GET /api/org/outlets` belongs to
// features/ws07-accounting/mock.ts and is NOT registered again here; this file
// owns only `PATCH /api/org/outlets/:outletId`, which no other feature
// registers. That list handler reads `cafeLegendPlatformFixtures.outlets`
// lazily, so a save is written back into the same fixture rows; a reload then
// still shows the new cutoff (sessionStorage keeps the save for this tab).
//
// legend-5kop: the sessionStorage snapshot lives in outlet-store.ts, which the
// app-level tenant resolver reads too, and a cutoff change appends an audit
// event to the audit log mock (features/ws11-audit/mock.ts, the store the
// /audit screen lists). Importing that module is safe: the mock transport
// loads every feature's mock.ts eagerly anyway, so this only shares the one
// registered list handler and its mutable store.
import {
  cafeLegendPlatformFixtures,
  orgEndpoints,
  type Outlet,
  type TenantDomain,
} from "@starter/shared/platform";
import { ApiError } from "../../lib/api/errors.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { appendMockAuditEvent } from "../ws11-audit/mock.ts";
import { readSavedOutlets, writeSavedOutlets } from "./outlet-store.ts";

/** The pristine rows, captured before any save mutates the shared fixtures. */
const pristine: Outlet[] = cafeLegendPlatformFixtures.outlets.map((outlet) => ({
  ...outlet,
}));

/**
 * The accounting list mock serves `cafeLegendPlatformFixtures.outlets`; write
 * the saved rows back there so both endpoints show the same outlet.
 */
function syncFixtures(outlets: readonly Outlet[]): void {
  for (const outlet of outlets) {
    const row = cafeLegendPlatformFixtures.outlets.find(
      (candidate) => candidate.id === outlet.id,
    );
    if (row) Object.assign(row, outlet);
  }
}

function seed(): Outlet[] {
  const rows = (readSavedOutlets() ?? pristine).map((outlet) => ({
    ...outlet,
  }));
  syncFixtures(rows);
  return rows;
}

// createMockStore also re-seeds on resetMocks(), which restores the fixtures
// (and re-applies this tab's saved rows, like a reload would).
const store = createMockStore<Outlet[]>(seed);

registerMock(orgEndpoints.updateOutlet, ({ params, body }) => {
  const rows = store.get();
  const index = rows.findIndex((outlet) => outlet.id === params.outletId);
  if (index === -1)
    throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  const current = rows[index];

  const updated: Outlet = {
    ...current,
    name: body.name ?? current.name,
    address: body.address ?? current.address,
    businessDayCutoff: body.businessDayCutoff ?? current.businessDayCutoff,
    legalEntityId: body.legalEntityId ?? current.legalEntityId,
    regionId: body.regionId !== undefined ? body.regionId : current.regionId,
    geofence: body.geofence !== undefined ? body.geofence : current.geofence,
    openingHours: body.openingHours ?? current.openingHours,
  };
  const next = rows.map((outlet, rowIndex) =>
    rowIndex === index ? updated : outlet,
  );
  store.set(next);
  syncFixtures([updated]);
  writeSavedOutlets(next);
  // PRD v1.7 §3 "Pengaturan" / contracts.md D-CORE-7: a cutoff change is an
  // audited settings change. The audit trail screen lists this store, so the
  // event is visible on /audit without leaving the SPA.
  if (updated.businessDayCutoff !== current.businessDayCutoff) {
    appendMockAuditEvent({
      action: "outlet.business_day_cutoff.updated",
      objectType: "outlet",
      objectId: updated.id,
      outletId: updated.id,
      before: { businessDayCutoff: current.businessDayCutoff },
      after: { businessDayCutoff: updated.businessDayCutoff },
    });
  }
  return { data: updated };
});

// ------------------------------------------------- custom domains (legend-az8z5)
// Mock for the domain verification screen (mockup
// design/mockups/platform/domain-verification.html). Seeded states: a verified
// platform subdomain and custom domain (fixtures), a pending custom domain
// with its TXT record, and a pending one whose check always fails
// (`gagal.` prefix). Add rejects reserved and taken names with the contract
// codes (DOMAIN_RESERVED 422, DOMAIN_TAKEN 409).
const VERIFICATION_NAME_PREFIX = "_legend-verify";
const FAILING_PREFIX = "gagal.";
const RESERVED_SUFFIXES = [".platform.example", ".legend.example"];
const TAKEN_HOSTNAMES = new Set<string>([
  cafeLegendPlatformFixtures.suspendedDomain.hostname,
  "toko.contoh.example",
]);

function verificationFor(hostname: string): TenantDomain["verification"] {
  return {
    type: "TXT",
    name: `${VERIFICATION_NAME_PREFIX}.${hostname}`,
    value: `legend-verify=${hostname.replace(/\./g, "-")}-mock-token`,
  };
}

function seedDomains(): TenantDomain[] {
  const rows = cafeLegendPlatformFixtures.domains.map((domain) =>
    domain.verifiedAt === null
      ? { ...domain, verification: verificationFor(domain.hostname) }
      : { ...domain },
  );
  const [first] = cafeLegendPlatformFixtures.domains;
  const failing: TenantDomain = {
    ...first,
    id: newIdempotencyKey() as TenantDomain["id"],
    hostname: `${FAILING_PREFIX}cafelegend.example`,
    kind: "custom",
    tlsStatus: "pending",
    verifiedAt: null,
    verification: verificationFor(`${FAILING_PREFIX}cafelegend.example`),
  };
  return [...rows, failing];
}

const domainStore = createMockStore<TenantDomain[]>(seedDomains);

registerMock(orgEndpoints.listDomains, () => ({ data: domainStore.get() }));

registerMock(orgEndpoints.addDomain, ({ body }) => {
  const rows = domainStore.get();
  const hostname = body.hostname;
  if (RESERVED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))
    throw new ApiError(
      422,
      "DOMAIN_RESERVED",
      "Domain ini dicadangkan dan tidak dapat digunakan.",
    );
  if (
    TAKEN_HOSTNAMES.has(hostname) ||
    rows.some((domain) => domain.hostname === hostname)
  )
    throw new ApiError(409, "DOMAIN_TAKEN", "Domain ini sudah digunakan.");
  const created: TenantDomain = {
    ...rows[0],
    id: crypto.randomUUID() as TenantDomain["id"],
    brandId: body.brandId,
    hostname,
    kind: "custom",
    tlsStatus: "pending",
    verifiedAt: null,
    verification: verificationFor(hostname),
    createdAt: new Date().toISOString(),
  };
  domainStore.set([...rows, created]);
  return { data: created };
});

registerMock(orgEndpoints.verifyDomain, ({ params }) => {
  const rows = domainStore.get();
  const current = rows.find((domain) => domain.id === params.domainId);
  if (!current) throw new ApiError(404, "NOT_FOUND", "Domain tidak ditemukan.");
  if (current.verifiedAt !== null) return { data: current };
  if (current.hostname.startsWith(FAILING_PREFIX))
    throw new ApiError(
      422,
      "DOMAIN_VERIFICATION_FAILED",
      "Record TXT belum ditemukan.",
    );
  const verified: TenantDomain = {
    ...current,
    tlsStatus: "active",
    verifiedAt: new Date().toISOString(),
    verification: null,
  };
  domainStore.set(
    rows.map((domain) => (domain.id === verified.id ? verified : domain)),
  );
  return { data: verified };
});

registerMock(orgEndpoints.removeDomain, ({ params }) => {
  const rows = domainStore.get();
  if (!rows.some((domain) => domain.id === params.domainId))
    throw new ApiError(404, "NOT_FOUND", "Domain tidak ditemukan.");
  domainStore.set(rows.filter((domain) => domain.id !== params.domainId));
});
