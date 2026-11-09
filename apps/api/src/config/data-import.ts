// Data-import guard registry (bead legend-v4ld; PRD v1.7 §3 and §7).
//
// Every code path that bulk-writes data from an external or synthetic source
// is a "data import source". Each one is registered here with an explicit
// classification and must call `guardDataImport("<id>")` before its first
// write. `data-import-registry.test.ts` fails when a registered source stops
// calling the guard, or when a new import/seed/backfill file or script appears
// without being registered (or explicitly listed as not writing data).
//
// This module imports only @starter/shared/env, never ./env.ts, so scripts that
// run as the migration owner (seed-dev-tenant.ts) can use it without loading
// the API's full runtime configuration.
import {
  assertDataImportAllowed,
  parseDeploymentEnv,
  type DataClassification,
  type DeploymentMode,
  type DeploymentSettings,
} from "@starter/shared/env";
import { HttpError } from "../lib/http-error.ts";

export type DataImportSource = {
  /**
   * What the input is. "synthetic" and "real" are fixed facts about the source.
   * "deployment" means a tenant-supplied upload whose classification is the
   * deployment's declared DATA_CLASSIFICATION: a development or staging
   * deployment only ever holds synthetic uploads, production holds real ones.
   */
  classification: DataClassification | "deployment";
  /** Deployment modes this source may run in. Omitted means any mode. */
  modes?: readonly DeploymentMode[];
  /** Where the guard call lives, checked by the registry test. */
  file: string;
  /** Text that starts the write entrypoint inside `file` (default: file start). */
  entry?: string;
  /** Text of the first write/connection; the guard call must come before it. */
  beforeWrite: string;
  description: string;
};

export const DATA_IMPORT_SOURCES = {
  "menu-import.commit": {
    classification: "deployment",
    file: "apps/api/src/services/menu-import.service.ts",
    entry: "export async function commitMenuImport(",
    beforeWrite: "withTenant(",
    description: "Menu CSV/spreadsheet upload committed by commitMenuImport.",
  },
  "seed.dev-tenant": {
    classification: "synthetic",
    modes: ["development"],
    file: "apps/api/src/db/seed-dev-tenant.ts",
    beforeWrite: "new Pool(",
    description: "Synthetic Cafe Legend tenant seeded as the migration owner.",
  },
} as const satisfies Record<string, DataImportSource>;

export type DataImportSourceId = keyof typeof DATA_IMPORT_SOURCES;

// An HttpError so that a blocked upload answers 403 instead of a bare 500.
export class DataImportBlockedError extends HttpError {
  constructor(
    readonly sourceId: string,
    message: string,
  ) {
    super(403, "DATA_IMPORT_BLOCKED", message);
    this.name = "DataImportBlockedError";
  }
}

function deploymentFromProcess(): DeploymentSettings {
  const result = parseDeploymentEnv(process.env);
  if (!result.ok)
    throw new DataImportBlockedError(
      "deployment",
      "Data import blocked: the deployment environment is invalid.",
    );
  return result.data;
}

/**
 * Call before the first write of an import source. Throws when the source is
 * unregistered, runs in a mode it is not allowed in, or would put real data
 * outside production (and so would let production data reach another
 * environment). Idempotent and side-effect free.
 */
export function guardDataImport(
  sourceId: DataImportSourceId,
  deployment: DeploymentSettings = deploymentFromProcess(),
): void {
  const source: DataImportSource | undefined = DATA_IMPORT_SOURCES[sourceId];
  if (!source)
    throw new DataImportBlockedError(
      sourceId,
      `Data import blocked: "${String(sourceId)}" is not a registered import source.`,
    );
  if (source.modes && !source.modes.includes(deployment.DEPLOYMENT_MODE))
    throw new DataImportBlockedError(
      sourceId,
      `Data import blocked: "${sourceId}" is not permitted in ${deployment.DEPLOYMENT_MODE}.`,
    );
  const classification =
    source.classification === "deployment"
      ? deployment.DATA_CLASSIFICATION
      : source.classification;
  try {
    assertDataImportAllowed(deployment, classification);
  } catch (error) {
    throw new DataImportBlockedError(
      sourceId,
      error instanceof Error ? error.message : "Data import blocked.",
    );
  }
}
