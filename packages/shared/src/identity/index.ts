// @starter/shared/identity — Legend identity & access contract (bead
// legend-7sz; PRD v1.7 §3 F6 "Autentikasi & Identitas", §3 F7 "RBAC,
// Organisasi & Matriks Approval", §6 B, AUTH-01..07, flow §4 C/R).
//
// Browser-safe and Node-safe: no Node-only or DOM-only API. The API, the web
// app, the edge runtime and the mock runtime all import this subpath.
//
// The RBAC pieces this module uses (roles, role assignments, approval matrix,
// the POS override record, permission catalog) are owned by
// `@starter/shared/access` and imported, never redefined.
export * from "./ids.ts";
export * from "./errors.ts";
export * from "./limits.ts";
export * from "./login-code.ts";
export * from "./digest.ts";
export * from "./schemas.ts";
export * from "./machines.ts";
export * from "./inputs.ts";
export * from "./endpoints.ts";
export * from "./events.ts";
export * from "./fixtures.ts";
