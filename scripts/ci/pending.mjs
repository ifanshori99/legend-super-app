// Remaining explicit placeholders. Lighthouse and real tenant isolation are no
// longer placeholders (legend-wwsa); only the coverage gate is still pending.
console.log(
  "INFO: Lighthouse /menu and /t/* run in the separate `lighthouse` CI job (pnpm lighthouse).",
);
console.log(
  "INFO: Cross-tenant isolation runs in `pnpm check` (apps/api/src/test/tenant-isolation-*.test.ts, legend-wwsa).",
);
console.log(
  "SKIP: >=80% business-logic coverage gate (domain modules and coverage provider pending; legend-dd0g)",
);
