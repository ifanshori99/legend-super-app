// These checks depend on Legend modules that have not landed in this branch.
// See the follow-up beads before replacing these explicit placeholders.
console.log(
  "INFO: Lighthouse /menu and /t/* run in the separate `lighthouse` CI job (pnpm lighthouse).",
);
console.log(
  "SKIP: Real tenant isolation adapter (tenant modules pending; legend-wwsa)",
);
console.log(
  "SKIP: >=80% business-logic coverage gate (domain modules and coverage provider pending; legend-dd0g)",
);
