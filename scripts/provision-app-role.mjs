// Local development and test harness entry point. The implementation lives in
// apps/api/src/db/provision-roles.ts so the migrator image ships the same code
// as the first-boot job (legend-zoqc); Node loads it through type stripping.
export {
  provisionAppRole,
  provisionRoles,
  provisionWorkerRole,
} from "../apps/api/src/db/provision-roles.ts";
