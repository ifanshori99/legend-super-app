// Bead legend-mp44v, contract docs/briefs/sub-302-design.md D14: gateway
// routing moved to org.settings.manage on the API, so the payment back office
// must open for an account that holds only that permission (owner and
// tenant_admin). Today the page guard and the nav entry list payment.* only.
import {
  PAYMENT_ADMIN_PERMISSIONS,
  routingSaveErrorKey,
  visiblePaymentAdminTabs,
} from "@/features/ws05-payment-admin/lib";
import nav from "@/features/ws05-payment-admin/nav";

describe("ws05 routing: org.settings.manage opens the payment back office", () => {
  test("PAYMENT_ADMIN_PERMISSIONS includes org.settings.manage", () => {
    expect(PAYMENT_ADMIN_PERMISSIONS).toContain("org.settings.manage");
  });

  test("existing payment permissions stay in the guard list", () => {
    expect(PAYMENT_ADMIN_PERMISSIONS).toEqual(
      expect.arrayContaining([
        "payment.transaction.view",
        "payment.reconcile",
        "payment.edc.manage",
      ]),
    );
  });

  test("the Pembayaran nav entry shows for org.settings.manage", () => {
    const entry = nav.find((item) => item.to === "/kelola/pembayaran");
    expect(entry).toBeDefined();
    expect(entry?.anyPermission).toContain("org.settings.manage");
  });

  test("nav and page guard list the same permissions", () => {
    const entry = nav.find((item) => item.to === "/kelola/pembayaran");
    expect([...(entry?.anyPermission ?? [])].sort()).toEqual(
      [...PAYMENT_ADMIN_PERMISSIONS].sort(),
    );
  });
});

describe("ws05 payment back office: tabs follow the API permissions", () => {
  test("org.integration.manage opens the page and shows only the Duitku tab", () => {
    expect(PAYMENT_ADMIN_PERMISSIONS).toContain("org.integration.manage");
    expect(visiblePaymentAdminTabs(["org.integration.manage"])).toEqual([
      "duitku",
    ]);
  });

  test("the default tab is the first visible one", () => {
    expect(visiblePaymentAdminTabs(["payment.edc.manage"])[0]).toBe("edc");
    expect(
      visiblePaymentAdminTabs(["payment.reconcile", "org.settings.manage"]),
    ).toEqual(["routing", "unallocated", "reconciliation", "refund-holds"]);
  });

  test("each payment tab needs its own permission", () => {
    expect(visiblePaymentAdminTabs(["payment.transaction.view"])).toEqual([
      "refunds",
    ]);
    expect(visiblePaymentAdminTabs(["payment.edc.manage"])).not.toContain(
      "refunds",
    );
    expect(visiblePaymentAdminTabs([])).toEqual([]);
  });
});

describe("ws05 routing: save errors map to Indonesian message keys", () => {
  test("a gateway the tenant cannot use gets its own message", () => {
    expect(
      routingSaveErrorKey({
        code: "VALIDATION_ERROR",
        message: "GATEWAY_NOT_AVAILABLE: duitku has no active integration.",
      }),
    ).toBe("paymentAdmin.routing.errors.gatewayNotAvailable");
  });

  test("other codes map to a fixed key, never the raw API text", () => {
    expect(
      routingSaveErrorKey({ code: "VALIDATION_ERROR", message: "x" }),
    ).toBe("paymentAdmin.routing.errors.invalid");
    expect(routingSaveErrorKey({ code: "FORBIDDEN" })).toBe(
      "paymentAdmin.routing.errors.forbidden",
    );
    expect(routingSaveErrorKey({ code: "NETWORK_ERROR" })).toBe(
      "paymentAdmin.routing.errors.offline",
    );
    expect(routingSaveErrorKey(new Error("boom"))).toBe(
      "paymentAdmin.routing.errors.generic",
    );
  });
});
