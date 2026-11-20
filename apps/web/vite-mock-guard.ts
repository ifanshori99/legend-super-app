// Build guard (legend-x73li): mock mode serves fixtures and grants every area
// to a cookie-chosen role, so a staging or production bundle must never carry
// it. `lib/env.server.ts` refuses to boot such a build; this stops it earlier,
// at build time. A development build (the demo build) stays allowed.
export function assertNoMockInDeployedBuild(options: {
  command: "build" | "serve";
  mock: string | undefined;
  deploymentMode: string | undefined;
}): void {
  if (options.command !== "build" || options.mock !== "true") return;
  if ((options.deploymentMode ?? "development") === "development") return;
  throw new Error(
    "VITE_API_MOCK: mock mode is only allowed with DEPLOYMENT_MODE=development",
  );
}
