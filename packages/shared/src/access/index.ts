// @starter/shared/access — Legend RBAC contract (bead legend-0mc; PRD v1.7
// §3.7 RBAC, Organisasi & Matriks Approval, §6 B, TEN-03, AUTH-05, AUTH-06).
// Browser-safe: the web app uses it to hide UI, the API, AI tools and MCP
// tools use the same functions as the authoritative check.

export * from "./ids.ts";
export * from "./errors.ts";
export * from "./permissions.ts";
export * from "./roles.ts";
export * from "./scope.ts";
export * from "./grants.ts";
export * from "./approval.ts";
export * from "./schemas.ts";
export * from "./endpoints.ts";
export * from "./events.ts";
export * from "./fixtures.ts";
