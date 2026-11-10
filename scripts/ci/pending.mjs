// Notes on gates that run elsewhere. Nothing here is a placeholder any more:
// Lighthouse and tenant isolation (legend-wwsa) and the business-logic coverage
// gate (legend-dd0g) all run for real.
console.log(
  "INFO: Lighthouse /menu and /t/* run in the separate `lighthouse` CI job (pnpm lighthouse).",
);
console.log(
  "INFO: Cross-tenant isolation runs in `pnpm check` (apps/api/src/test/tenant-isolation-*.test.ts, legend-wwsa).",
);
console.log(
  "INFO: Business-logic coverage thresholds are enforced inside `pnpm check` in CI (LEGEND_COVERAGE=1, apps/api/vitest.config.ts, legend-dd0g).",
);
