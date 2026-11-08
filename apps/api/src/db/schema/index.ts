// Export every table here. Drizzle Kit, the shared pool, and Better Auth use this entrypoint.
export * from "./user";
export * from "./session";
export * from "./account";
export * from "./verification";
export * from "./identity-mfa";
export * from "./notes";

export * from "./core-events";

export * from "./platform-org";
export * from "./menu";
export * from "./platform-domains";
export * from "./platform-packages";
export * from "./platform-integrations";
export * from "./platform-themes";
export * from "./platform-support";
export * from "./platform-access";
export * from "./core-audit";
export * from "./core-storage";
export * from "./notification";
export * from "./inventory";
export * from "./floor";
export * from "./payment";
export * from "./accounting";
export * from "./identity";
// WS-05 versioned tax / service-charge rules, calculation options, snapshots.
export * from "./tax";

export * from "./payment-admin";
// WS-01 generic approval requests (legend-y5q).
export * from "./platform-approval";
// WS-08 promo engine: promotions, vouchers, redemptions (legend-7x4g).
export * from "./crm-promo";
// WS-03 waiter call / bill request (legend-7qg).
export * from "./service-request";
// WS-01 device PIN + supervisor override (legend-dxb).
export * from "./device-pin";
// WS-03 QR order carts/orders (legend-e2x).
export * from "./qr-order";
export * from "./reservation";
export * from "./facility";
export * from "./hris";
// WS-10 leave, balances, accrual, holidays, overtime (legend-hggk).
export * from "./hris-leave";
// WS-07 AP/AR, fixed assets, budgets (legend-hpgo).
export * from "./accounting-ap-fa";
// WS-06 inventory setup writes (legend-gjmk).
export * from "./inventory-setup";
// WS-03 menu import + printable menu (legend-dmi).
export * from "./menu-import";
// WS-06 production, waste, alerts (legend-ugo).
export * from "./inventory-ops";
// WS-01 text overrides + consents (legend-cv3).
export * from "./text-overrides";
export * from "./consents";

export * from "./operations";
// WS-02 edge node registry + cloud <-> edge link (legend-2pi).
export * from "./edge-node";
// WS-04 POS order service (legend-kk7).
export * from "./pos-order";
