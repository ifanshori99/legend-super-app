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
  /**
   * Fail closed: when DEPLOYMENT_MODE is not set explicitly (the shared parser
   * would default it to development), the source may only run against a local
   * database host. Set it to the explicit mode to target any other host.
   */
  failClosedMode?: boolean;
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
  "payment-settlement.import": {
    classification: "deployment",
    file: "apps/api/src/services/payment-settlement-import.service.ts",
    entry: "export async function importSettlement(",
    beforeWrite: "withTenant(",
    description:
      "Gateway and EDC bank settlement report upload committed by importSettlement.",
  },
  "edc-settlement.csv-import": {
    classification: "deployment",
    file: "apps/api/src/services/edc-settlement-import.service.ts",
    entry: "export async function importEdcSettlementCsv(",
    beforeWrite: "withTenant(",
    description:
      "EDC bank settlement CSV upload (X2) matched to EDC sales by importEdcSettlementCsv.",
  },
  "seed.dev-tenant": {
    classification: "synthetic",
    modes: ["development"],
    failClosedMode: true,
    file: "apps/api/src/db/seed-dev-tenant.ts",
    beforeWrite: "new Pool(",
    description: "Synthetic Cafe Legend tenant seeded as the migration owner.",
  },
  "edge.bootstrap": {
    // The bundle comes from the cloud API of the deployment this node belongs
    // to; its rows are that deployment's data, so it follows its classification.
    classification: "deployment",
    file: "apps/api/src/edge/bootstrap.ts",
    entry: "export async function bootstrapEdgeNodeIfNeeded(",
    beforeWrite: "insertBundleRows(tx, bundle)",
    description:
      "Edge node first start: tenant, legal entity, brand and outlet rows from the signed cloud bundle.",
  },
  "backfill.tenant-defaults": {
    // Standard chart, UOM, stock location and tax defaults for the
    // deployment's own existing tenants (insert-only, from code templates).
    classification: "deployment",
    file: "apps/api/src/db/backfill-tenant-defaults.ts",
    beforeWrite: "await db",
    description:
      "pnpm db:backfill-defaults: standard defaults inserted for tenants created before provisioning existed.",
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

/** Where the import will write; read by sources with `failClosedMode`. */
export type DataImportTarget = {
  databaseUrl?: string;
  /** Raw process environment, to tell "unset" apart from the parsed default. */
  env?: Record<string, string | undefined>;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// libpq-style parameters that make the driver connect elsewhere than the URL host.
const HOST_OVERRIDE_PARAMS = ["host", "hostaddr", "service"];

export function isLocalDatabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (HOST_OVERRIDE_PARAMS.some((name) => url.searchParams.has(name)))
      return false;
    const host = url.hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
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
  target: DataImportTarget = {},
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
  if (
    "failClosedMode" in source &&
    source.failClosedMode &&
    !(target.env ?? process.env).DEPLOYMENT_MODE?.trim() &&
    !isLocalDatabaseUrl(target.databaseUrl)
  )
    throw new DataImportBlockedError(
      sourceId,
      `Data import blocked: DEPLOYMENT_MODE is not set, so "${sourceId}" only runs against a local database. Set DEPLOYMENT_MODE explicitly.`,
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
