// legend-42gqp: the floor board alias GET /api/outlets/:id/floor is guarded
// like the POS routes, so the live cashier token must ride on it. Other
// /api/outlets/:id/* routes (reservation-policy and so on) stay without it.
import { ACTING_STAFF_HEADER } from "@starter/shared/pos/acting-staff";
import {
  actingStaffHeaderFor,
  clearActingStaffToken,
  writeActingStaffToken,
} from "@/lib/api/acting-staff";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const outletId = "0b6f1d52-3c1e-4c53-9f0e-6a1b2c3d4e5f";

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    location: { pathname: "/pos/kasir", assign: () => undefined },
  });
  writeActingStaffToken({
    token: "pas_live-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  } as Parameters<typeof writeActingStaffToken>[0]);
});

afterEach(() => {
  clearActingStaffToken();
  vi.unstubAllGlobals();
});

describe("actingStaffHeaderFor on the outlet floor alias", () => {
  it("sends the live token on GET /api/outlets/:id/floor", () => {
    expect(actingStaffHeaderFor(`/api/outlets/${outletId}/floor`)).toEqual({
      [ACTING_STAFF_HEADER]: "pas_live-token",
    });
    expect(
      actingStaffHeaderFor(`/api/outlets/${outletId}/floor?zone=a`),
    ).toEqual({ [ACTING_STAFF_HEADER]: "pas_live-token" });
  });

  it("does not send it on /api/outlets/:id/reservation-policy", () => {
    expect(
      actingStaffHeaderFor(`/api/outlets/${outletId}/reservation-policy`),
    ).toEqual({});
  });
});
