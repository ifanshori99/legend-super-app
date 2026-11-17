// legend-3z0ds: routers that now guard shared devices (expo, pickup, service
// requests, order issues, recovery, serving time, open bill, menu availability)
// must get the live cashier token. Sign-in and device routes keep going
// without it: a held call there would block sign-out.
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
const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

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

describe("actingStaffHeaderFor on shared-device guarded routers", () => {
  it.each([
    `/api/outlets/${outletId}/expo`,
    `/api/outlets/${outletId}/expo/${id}/delivered`,
    `/api/outlets/${outletId}/expo/runners`,
    `/api/outlets/${outletId}/pickup-display`,
    `/api/outlets/${outletId}/pickup-calls/${id}/call`,
    `/api/outlets/${outletId}/service-requests`,
    `/api/outlets/${outletId}/order-issues?status=open`,
    `/api/outlets/${outletId}/orders/${id}/issues`,
    `/api/outlets/${outletId}/serving-time-estimate`,
    `/api/outlets/${outletId}/open-bill-policy`,
    `/api/outlets/${outletId}/open-bill/approvers`,
    `/api/order-items/${id}/issues`,
    `/api/order-issues/${id}/resolve`,
    `/api/order-issue-charges/${id}/collect-at-pos`,
    `/api/service-requests/${id}/acknowledge`,
    `/api/service-requests/${id}/resolve`,
    `/api/menu/availability?outletId=${outletId}`,
    `/api/menu/availability/${id}/status`,
  ])("sends the live token on %s", (path) => {
    expect(actingStaffHeaderFor(path)).toEqual({
      [ACTING_STAFF_HEADER]: "pas_live-token",
    });
  });

  it.each([
    "/api/staff-pins/pos-session",
    "/api/me/access",
    "/api/emergency/press",
    "/api/notifications/push-subscriptions",
    `/api/notifications/push-subscriptions/${id}`,
    "/api/identity/push-devices",
    "/api/approvals",
    `/api/menu/items`,
    `/api/order-issues/${id}/options`,
    `/api/order-issues/${id}/customer-choice`,
    `/api/table-sessions/${id}/service-requests`,
    `/api/table-sessions/${id}/order-issues`,
  ])("does not send it on %s", (path) => {
    expect(actingStaffHeaderFor(path)).toEqual({});
  });
});
