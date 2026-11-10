// Fail-closed getters of the permission middleware (bead legend-tjey, from the
// legend-fsb7 review; TEN-03). A handler that reads a context its route never
// minted must throw, never fall back to a wider scope.
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";

const tenant = establishTenantContext({
  tenantId: "0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70",
  brandId: null,
  source: "session",
});
const tenantWide = establishScopedTenantContext(tenant, { kind: "tenant" });

vi.mock("./auth", () => ({
  getAuth: () => ({ user: { id: "11111111-1111-4111-8111-111111111111" } }),
}));
vi.mock("./tenant", () => ({ getTenantContext: () => tenant }));
vi.mock("../lib/mfa", () => ({ sessionMfaVerifiedAt: async () => null }));
vi.mock("../services/permission-resolver", () => ({
  loadTenantAccess: async () => ({
    assignments: [],
    roles: [],
    org: { brands: [], outlets: [], stations: [] },
  }),
  // The caller holds the permission tenant-wide.
  resolveAccessSnapshot: () => ({
    contextFor: () => tenantWide,
    stationsFor: () => [],
  }),
}));

const {
  getScopedTenantContext,
  getStationScope,
  requireStationScopePermission,
} = await import("./permissions");

function fakeResponse(): Response {
  return { setHeader: vi.fn() } as unknown as Response;
}

describe("permission middleware fail-closed getters (legend-tjey)", () => {
  let req: Request;
  beforeEach(() => {
    // A real request always carries `headers` (legend-aruta reads X-Acting-Staff).
    req = { headers: {} } as unknown as Request;
  });

  it("TEN-03 getStationScope throws on a route without requireStationScopePermission", () => {
    expect(() => getStationScope(req)).toThrow(
      "getStationScope() used without requireStationScopePermission",
    );
  });

  it("TEN-03 getScopedTenantContext throws on a station-scope route", async () => {
    const next = vi.fn();
    await requireStationScopePermission("menu.item.view")(
      req,
      fakeResponse(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    // The station route only exposes its context through the station getter…
    expect(getStationScope(req)).toEqual({ context: tenantWide });
    // …so the outlet-wide getter refuses it instead of skipping the station
    // narrowing (legend-fsb7).
    expect(() => getScopedTenantContext(req)).toThrow(
      "getScopedTenantContext() used without requireTenantPermission",
    );
  });
});
