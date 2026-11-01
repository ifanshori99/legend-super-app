// TEN-03 / AUTH-05: the server resolver's pure decisions. The DB-loading half
// is exercised by platform-access-api.test.ts against the real tenant
// transaction and RLS.
import { describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { establishTenantContext } from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import { resolveAccessSnapshot } from "./permission-resolver.ts";

const fx = cafeLegendAccessFixtures;
const { bandung, bandung2 } = fx.outletIds;
const stationBarKopi = fx.stations.find((row) => row.code === "bar_kopi")!.id;
const tenant = establishTenantContext({
  tenantId: fx.tenantId,
  brandId: null,
  source: "session",
});

function snapshotFor(
  userKey: keyof typeof fx.users,
  overrides: Partial<Parameters<typeof resolveAccessSnapshot>[0]> = {},
) {
  return resolveAccessSnapshot({
    tenant,
    userId: fx.users[userKey].id,
    assignments: fx.assignments,
    roles: fx.roles,
    org: fx.org,
    mfaVerified: false,
    now: fx.now,
    ...overrides,
  });
}

describe("TEN-03 permission resolver", () => {
  it("denies access when no verified assignment exists", () => {
    const result = resolveAccessSnapshot({
      tenant,
      userId: "22222222-2222-4222-8222-222222222222",
      assignments: [],
      roles: [],
      org: { brands: [], outlets: [], stations: [] },
      mfaVerified: false,
      now: new Date(),
    });
    expect(result.permissions).toEqual([]);
    expect(
      result.contextFor("org.structure.manage", { type: "tenant" }),
    ).toBeNull();
  });

  it("denies an assignment that belongs to another tenant", () => {
    const otherTenant = establishTenantContext({
      tenantId: tenantIdSchema.parse("99999999-9999-4999-8999-999999999999"),
      brandId: null,
      source: "session",
    });
    const result = resolveAccessSnapshot({
      tenant: otherTenant,
      userId: fx.users.owner.id,
      assignments: fx.assignments,
      roles: fx.roles,
      org: fx.org,
      mfaVerified: false,
      now: fx.now,
    });
    expect(result.permissions).toEqual([]);
    expect(result.allows("org.structure.manage", { type: "tenant" })).toBe(
      false,
    );
  });

  it("returns the catalog-ordered union of active permissions", () => {
    const owner = snapshotFor("owner");
    expect(owner.permissions).toContain("org.structure.manage");
    expect(owner.permissions).toContain("access.role.assign");
    expect(owner.permissions).toContain("payroll.lock");
    expect(owner.permissions).not.toContain("self.profile.view");
    expect(owner.permissions).not.toContain("platform.tenant.manage");
    // No duplicates.
    expect(new Set(owner.permissions).size).toBe(owner.permissions.length);
  });

  it("applies the assignment window: ended and future grants add nothing", () => {
    // The supervisor's acting outlet-manager post ended at 2026-10-31T17:00Z;
    // the fixture clock is 2026-11-01T05:00Z.
    const supervisor = snapshotFor("supervisor");
    expect(supervisor.permissions).not.toContain("hr.schedule.manage");
    expect(supervisor.permissions).toContain("kds.expo.operate");
    // supervisor2's second supervisor post starts 2026-12-01.
    const notYet = snapshotFor("supervisor2");
    expect(
      notYet.allows("kds.expo.operate", { type: "outlet", id: bandung2 }),
    ).toBe(false);
    expect(
      notYet.allows("kds.expo.operate", { type: "outlet", id: bandung }),
    ).toBe(true);
  });

  it("keeps a narrow grant inside its scope and mints the matching outlet context", () => {
    const cashier = snapshotFor("cashier");
    expect(
      cashier.allows("pos.sale.create", { type: "outlet", id: bandung }),
    ).toBe(true);
    expect(
      cashier.allows("pos.sale.create", { type: "outlet", id: bandung2 }),
    ).toBe(false);
    // Outlet-scoped roles never reach tenant-wide administration.
    expect(cashier.allows("org.structure.manage", { type: "tenant" })).toBe(
      false,
    );
    const context = cashier.contextFor("pos.sale.create", {
      type: "outlet",
      id: bandung,
    });
    expect(context?.outletScope).toMatchObject({
      kind: "outlets",
      outletIds: [bandung],
    });

    const owner = snapshotFor("owner");
    expect(
      owner.contextFor("org.structure.manage", { type: "tenant" })?.outletScope,
    ).toMatchObject({ kind: "tenant" });
  });

  it("expands a brand-scoped grant to the brand's outlets only", () => {
    const manager = snapshotFor("generalManager");
    expect(
      manager.allows("dashboard.management.view", {
        type: "outlet",
        id: bandung,
      }),
    ).toBe(true);
    const context = manager.contextFor("dashboard.management.view", {
      type: "outlet",
      id: bandung,
    });
    expect(context?.outletScope.kind).toBe("outlets");
    // The brand grant covers both fixture outlets when they share the brand.
    const covered =
      context?.outletScope.kind === "outlets"
        ? context.outletScope.outletIds
        : [];
    expect(covered).toContain(bandung);
  });

  it("station scope reaches its own station and never a whole outlet", () => {
    const barista = snapshotFor("barista");
    const station = fx.stations.find((row) => row.code === "bar_kopi")!;
    expect(
      barista.allows("kds.ticket.process", { type: "station", id: station.id }),
    ).toBe(true);
    expect(
      barista.allows("kds.ticket.process", { type: "outlet", id: bandung }),
    ).toBe(false);
    // A station-only grant cannot produce an outlet-wide RLS context; the
    // caller must fail closed until a station-aware context exists (WS-03).
    expect(
      barista.contextFor("kds.ticket.process", {
        type: "station",
        id: stationBarKopi,
      }),
    ).toBeNull();
  });

  it("AUTH-05 reports mfa_required per §6 B without granting the factor", () => {
    expect(snapshotFor("owner").mfaRequired).toBe(true);
    expect(snapshotFor("finance").mfaRequired).toBe(true);
    expect(snapshotFor("cashier").mfaRequired).toBe(false);
    expect(snapshotFor("cashier").mfaVerified).toBe(false);
    expect(snapshotFor("cashier", { mfaVerified: true }).mfaVerified).toBe(
      true,
    );
  });

  it("contextFor never mints a context for a denied permission", () => {
    const cashier = snapshotFor("cashier");
    expect(cashier.contextFor("payroll.run", { type: "tenant" })).toBeNull();
    expect(
      cashier.contextFor("payroll.run", { type: "outlet", id: bandung }),
    ).toBeNull();
  });
});
