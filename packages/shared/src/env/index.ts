import { z } from "zod";

// Deployment settings for PRD v1.7 §3 (Environment & Deployment) and §7
// (synthetic data policy). They are deliberately separate from NODE_ENV, which
// only selects Node runtime behavior. The API, the web server, and the future
// worker and edge runtimes validate these three settings with this module, so a
// process cannot start while disagreeing with the others about its data policy.

export type DeploymentMode = "development" | "staging" | "production";
export type DataClassification = "synthetic" | "real";

const deploymentModeSchema = z
  .enum(["development", "staging", "production"])
  .default("development");

// Edge is a deployment topology, not an environment of its own.
const edgeModeSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const dataClassificationSchema = z
  .enum(["synthetic", "real"])
  .default("synthetic");

// Spread into a runtime's own env schema (the API adds its database and auth
// settings) so the deployment settings are defined in exactly one place.
export const deploymentEnvShape = {
  DEPLOYMENT_MODE: deploymentModeSchema,
  EDGE_MODE: edgeModeSchema,
  DATA_CLASSIFICATION: dataClassificationSchema,
};

// Only production may hold real data. Development and staging are synthetic
// only, including copies of production data (docs/deployment.md).
export function deploymentPolicyCheck(values: {
  DEPLOYMENT_MODE: DeploymentMode;
  DATA_CLASSIFICATION: DataClassification;
}): boolean {
  return (
    values.DEPLOYMENT_MODE === "production" ||
    values.DATA_CLASSIFICATION === "synthetic"
  );
}

export const DEPLOYMENT_POLICY_MESSAGE =
  "Only synthetic data is permitted outside production.";

export const deploymentEnvSchema = z
  .object(deploymentEnvShape)
  .refine(deploymentPolicyCheck, {
    path: ["DATA_CLASSIFICATION"],
    message: DEPLOYMENT_POLICY_MESSAGE,
  });

export type DeploymentSettings = z.infer<typeof deploymentEnvSchema>;

export type DeploymentEnvResult =
  { ok: true; data: DeploymentSettings } | { ok: false; problems: string[] };

// Reads the three settings from a process environment without touching it.
// Entries call this so a missing or contradictory setting is reported before
// the runtime accepts traffic.
export function parseDeploymentEnv(
  source: Record<string, string | undefined>,
): DeploymentEnvResult {
  const parsed = deploymentEnvSchema.safeParse({
    DEPLOYMENT_MODE: source.DEPLOYMENT_MODE,
    EDGE_MODE: source.EDGE_MODE,
    DATA_CLASSIFICATION: source.DATA_CLASSIFICATION,
  });
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    // Field names and messages only: never echo the values themselves, they
    // can hold a leaked secret when a variable name is mistyped.
    problems: parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
    ),
  };
}

export function formatDeploymentEnvProblems(
  problems: readonly string[],
): string {
  return problems.map((problem) => `  ${problem}`).join("\n");
}

// For runtime entrypoints: throws one Error listing every invalid setting so
// the caller can log it and exit non-zero at startup.
export function assertDeploymentEnv(
  source: Record<string, string | undefined>,
): DeploymentSettings {
  const result = parseDeploymentEnv(source);
  if (!result.ok)
    throw new Error(
      `Invalid deployment environment:\n${formatDeploymentEnvProblems(result.problems)}`,
    );
  return result.data;
}

// Importers must classify each input explicitly before persisting any records.
// An unknown classification is an error, not a default: guessing synthetic
// would let real data through.
export function assertDataImportAllowed(
  settings: Pick<DeploymentSettings, "DEPLOYMENT_MODE">,
  classification: unknown,
): void {
  const dataType = z.enum(["synthetic", "real"]).parse(classification);
  if (dataType === "real" && settings.DEPLOYMENT_MODE !== "production")
    throw new Error("Real data imports are only permitted in production.");
}
