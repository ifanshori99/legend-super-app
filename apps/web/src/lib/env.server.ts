import {
  formatDeploymentEnvProblems,
  parseDeploymentEnv,
  type DeploymentSettings,
} from "@starter/shared/env";

// The web server's deployment settings from PRD v1.7 §3 (Environment &
// Deployment). Validation runs when this module is first evaluated: TanStack
// Start strips `.server.ts` modules from the browser bundle, and the server
// entries (src/server.ts, server/plugins/deployment-env.ts) import it first, so a production server refuses to boot with a
// deployment mode, edge topology, or data classification the API would reject.
//
// The worker and edge runtimes do not exist yet. Their entrypoints must call
// assertDeploymentEnv from @starter/shared/env before serving traffic; see
// docs/deployment.md ("Startup validation").
function load(): DeploymentSettings {
  const result = parseDeploymentEnv(process.env);
  if (!result.ok) {
    // Field names and messages only: never print the values themselves.
    console.error(
      `Invalid web environment:\n${formatDeploymentEnvProblems(result.problems)}`,
    );
    process.exit(1);
  }
  // Mock mode (VITE_API_MOCK=true) grants every area to a cookie-chosen role
  // template and serves fixtures; it is a review tool, never a deployment.
  // Vite inlines the flag at build time, so a production build made with it
  // refuses to boot instead of trusting "never set it" in the docs.
  const mockBuild =
    import.meta.env?.VITE_API_MOCK === "true" ||
    process.env.VITE_API_MOCK === "true";
  if (mockBuild && result.data.DEPLOYMENT_MODE !== "development") {
    console.error(
      "Invalid web environment:\n  VITE_API_MOCK: mock mode is only allowed with DEPLOYMENT_MODE=development",
    );
    process.exit(1);
  }
  return result.data;
}

// Parsed once per process, matching the API's env module.
export const webEnv = load();
