// legend-fn7ur: one selectable loyalty program permission, with stored-role
// compatibility that preserves the original assignment's scope and MFA gate.
import { describe, expect, it } from "vitest";
import {
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  authorize,
  cafeLegendAccessFixtures as fixtures,
  normalizeCustomRolePermissions,
  permissionCodeSchema,
  myAccessViewSchema,
  rolePermissionsAsGranted,
  roleTemplate,
  type AccessTarget,
  type AssignmentScope,
} from "@starter/shared/access";
import { establishTenantContext } from "@starter/shared/core/server";
import { resolveAccessSnapshot } from "../services/permission-resolver.ts";

const legacy = "loyalty.program.manage";
const canonical = "crm.loyalty.manage";
const outletA = fixtures.outletIds.bandung;
const outletB = fixtures.outletIds.bandung2;
const assignment = fixtures.assignments.find(
  (row) => row.userId === fixtures.users.waiter.id,
)!;

function check(input: {
  stored: string;
  requested: string;
  scope: AssignmentScope;
  target: AccessTarget;
  mfaVerified?: boolean;
}) {
  return authorize({
    principal: {
      tenantId: fixtures.tenantId,
      userId: assignment.userId,
      assignments: [{ ...assignment, scope: input.scope }],
    },
    roles: [
      {
        id: assignment.roleId,
        permissions: [permissionCodeSchema.parse(input.stored)],
        mfaRequired: true,
      },
    ],
    org: fixtures.org,
    permission: permissionCodeSchema.parse(input.requested),
    target: input.target,
    now: fixtures.now,
    surface: "back_office",
    mfaVerified: input.mfaVerified ?? true,
  });
}

describe("legend-fn7ur loyalty program permission compatibility", () => {
  it("FN7UR-PERM-01 the selectable catalogue advertises one canonical permission and marketing retains access", () => {
    const codes = PERMISSION_CATALOG.map((entry) => entry.code);
    expect(codes.filter((code) => code === canonical)).toHaveLength(1);
    expect(codes).not.toContain(legacy);
    expect(
      rolePermissionsAsGranted(
        "marketing",
        roleTemplate("marketing").permissions,
      ),
    ).toContain(canonical);
  });

  it("FN7UR-PERM-02 old role input is accepted while custom-role storage and reads collapse aliases", () => {
    expect(permissionCodeSchema.safeParse(legacy).success).toBe(true);
    expect(normalizeCustomRolePermissions([legacy, canonical, legacy])).toEqual(
      { permissions: [canonical], mfaRequired: false },
    );
    for (const templateKey of [null, "marketing", "owner"]) {
      expect(
        rolePermissionsAsGranted(templateKey, [legacy, canonical]),
      ).toEqual([canonical]);
    }
    expect(() =>
      normalizeCustomRolePermissions(["crm.loyalty.everything"]),
    ).toThrow();
  });

  it("FN7UR-PERM-03 either spelling grants only its assigned outlet, with MFA still required", () => {
    for (const stored of [legacy, canonical]) {
      for (const requested of [legacy, canonical]) {
        const input = {
          stored,
          requested,
          scope: { type: "outlet", id: outletA } as const,
          target: { type: "outlet", id: outletA } as const,
        };
        expect(check(input).allowed).toBe(true);
        expect(check({ ...input, mfaVerified: false }).allowed).toBe(false);
        expect(
          check({ ...input, target: { type: "outlet", id: outletB } }).allowed,
        ).toBe(false);
        expect(check({ ...input, target: { type: "tenant" } }).allowed).toBe(
          false,
        );
        expect(check({ ...input, requested: "promo.manage" }).allowed).toBe(
          false,
        );
      }
    }
  });

  it("FN7UR-PERM-04 a brand-only alias grants the brand's outlets without tenant-wide elevation", () => {
    for (const stored of [legacy, canonical]) {
      const input = {
        stored,
        requested: canonical,
        scope: { type: "brand", id: fixtures.brandId } as const,
        target: { type: "outlet", id: outletA } as const,
      };
      expect(check(input).allowed).toBe(true);
      expect(check({ ...input, target: { type: "tenant" } }).allowed).toBe(
        false,
      );
    }
  });

  it("FN7UR-PERM-05 existing raw templates and wire codes preserve the legacy UI guard spelling", () => {
    expect(PERMISSION_CODES).toContain(legacy);
    expect(PERMISSION_CODES).toContain(canonical);
    for (const templateKey of ["owner", "marketing"] as const) {
      expect(roleTemplate(templateKey).permissions).toContain(legacy);
      expect(
        rolePermissionsAsGranted(
          templateKey,
          roleTemplate(templateKey).permissions,
        ),
      ).toContain(canonical);
    }
  });

  it("FN7UR-PERM-06 access snapshots and their response schema retain both UI spellings without widening brand scope", () => {
    for (const stored of [legacy, canonical]) {
      const snapshot = resolveAccessSnapshot({
        tenant: establishTenantContext({
          tenantId: fixtures.tenantId,
          brandId: null,
          source: "session",
        }),
        userId: assignment.userId,
        assignments: [
          {
            ...assignment,
            scope: { type: "brand", id: fixtures.brandId },
          },
        ],
        roles: [
          {
            id: assignment.roleId,
            permissions: [permissionCodeSchema.parse(stored)],
            mfaRequired: true,
            templateKey: null,
            allowedScopeTypes: ["brand"],
          },
        ],
        org: fixtures.org,
        mfaVerified: true,
        now: fixtures.now,
      });
      expect(snapshot.permissions).toEqual(
        expect.arrayContaining([legacy, canonical]),
      );
      expect(snapshot.permissions).not.toContain("promo.manage");
      for (const requested of [legacy, canonical]) {
        const permission = permissionCodeSchema.parse(requested);
        expect(snapshot.allows(permission, { type: "tenant" })).toBe(false);
        expect(
          snapshot.allows(permission, {
            type: "brand",
            id: fixtures.brandId,
          }),
        ).toBe(true);
      }
      const wire = myAccessViewSchema.parse({
        permissions: snapshot.permissions,
        mfaRequired: true,
        mfaVerified: true,
        stations: [],
        outlets: [],
        activeOutletId: null,
        supportSession: null,
      });
      expect(wire.permissions).toEqual(
        expect.arrayContaining([legacy, canonical]),
      );
    }
  });
});
