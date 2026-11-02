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
