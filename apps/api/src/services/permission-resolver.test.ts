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
    // A station-only grant cannot produce outlet-wide reach: no tenant,
    // brand or outlet target mints a context, so a non-station route stays
    // closed (TEN-03). A station target is the one exception: the context's
    // RLS reach is that station's outlet and the service re-asserts the
    // station itself (legend-fsb7).
    expect(
      barista.contextFor("kds.ticket.process", { type: "tenant" }),
    ).toBeNull();
    expect(
      barista.contextFor("kds.ticket.process", { type: "outlet", id: bandung }),
    ).toBeNull();
    const stationContext = barista.contextFor("kds.ticket.process", {
      type: "station",
      id: stationBarKopi,
    });
    expect(
      stationContext?.outletScope.kind === "outlets"
        ? stationContext.outletScope.outletIds
        : null,
    ).toEqual([station.outletId]);
    // Another station is outside the assignment and mints nothing.
    expect(
      barista.contextFor("kds.ticket.process", {
        type: "station",
        id: fx.stations.find((row) => row.code === "dapur_panas")!.id,
      }),
    ).toBeNull();
  });

  it("a station target mints exactly that station's outlet, even beside an outlet grant elsewhere (legend-fsb7)", () => {
    // Kitchen Lead holds kds.ticket.process for the whole of Bandung; give it
    // one more station-scoped grant at Bandung 2. The station target must run
    // with Bandung 2's reach, not the unrelated Bandung outlet reach.
    const stationAtBandung2 = fx.stations.find(
      (row) => row.code === "bar_kopi_2",
    )!;
    const barista = fx.assignments.find(
      (row) => row.userId === fx.users.barista.id,
    )!;
    const extra = {
      ...barista,
      id: "00000000-0000-4000-8000-00000000f5b7" as typeof barista.id,
      userId: fx.users.kitchenLead.id,
      scope: { type: "station" as const, id: stationAtBandung2.id },
    } as unknown as (typeof fx.assignments)[number];
    const lead = snapshotFor("kitchenLead", {
      assignments: [...fx.assignments, extra],
    });
    const context = lead.contextFor("kds.ticket.process", {
      type: "station",
      id: stationAtBandung2.id,
    });
    expect(
      context?.outletScope.kind === "outlets"
        ? context.outletScope.outletIds
        : null,
    ).toEqual([bandung2]);
  });

  it("station reach lists only the stations a permission reaches (legend-fsb7)", () => {
    expect(snapshotFor("barista").stationsFor("kds.ticket.process")).toEqual([
      stationBarKopi,
    ]);
    expect(snapshotFor("cook").stationsFor("kds.ticket.process")).toEqual([
      fx.stations.find((row) => row.code === "dapur_panas")!.id,
    ]);
    // An outlet-scoped role reaches every station of its outlet, not others.
    // Kitchen Lead holds kds.ticket.process at outlet scope (fixture user
    // kitchenLead); Outlet Manager has no ticket permission, so it reaches no
    // station for it.
    expect(
      snapshotFor("kitchenLead").stationsFor("kds.ticket.process"),
    ).toEqual(
      fx.stations
        .filter((row) => row.outletId === bandung)
        .map((row) => row.id),
    );
    expect(
      snapshotFor("outletManager").stationsFor("kds.ticket.process"),
    ).toEqual([]);
    // No permission, no station.
    expect(snapshotFor("barista").stationsFor("menu.item.view")).toEqual([]);
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
