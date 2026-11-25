// Operational data-key rotation (brief 466 item 4):
//   pnpm db:rotate-data-key [--tenant <id>] [--force] [--dry-run]
//
// Second rollout of a key rotation (docs/deployment.md "Rotasi kunci data"):
// once every process knows the new key and DATA_ENCRYPTION_ACTIVE_KEY_VERSION
// points at it, this walks every tenant (whatever its status) and re-seals the
// stale integration credentials and AI provider keys to the ACTIVE version
// (rotateIntegrationCredentials, rotateAiProviderKeys; actor system, one audit
// row per row). Each tenant runs under a trusted job context with tenant-wide
// scope, so RLS still applies. A tenant that fails is recorded and the others
// still run; the exit code reports it. Safe to repeat: a second run only
// touches rows that are still stale. `remaining` counts the stale rows of ALL
// tenants after the run (even with --tenant); `remainingComplete` is false when
// a tenant's count failed (that tenant is failed too). The report holds counts and
// tenant ids only, never a key, a credential or an error carrying row content.
//
// The app modules are imported inside the function so the CLI can load the
// env files before `db` and the key ring read their configuration.
import { and, isNull, ne, or, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { aiProviderConfigs } from "./schema/ai-provider.ts";
import { tenantIntegrations } from "./schema/platform-integrations.ts";

export type DataKeyRotationOptions = {
  tenantId?: string;
  force?: boolean;
  dryRun?: boolean;
};

export type DataKeyRotationTenantReport = {
  tenantId: string;
  /** Rows re-sealed; with dryRun, the rows that WOULD be re-sealed. */
  integrationsRotated: number;
  aiKeysRotated: number;
  error?: string;
};

export type DataKeyRotationReport = {
  activeVersion: number;
  dryRun: boolean;
  tenants: DataKeyRotationTenantReport[];
  totals: {
    integrationsRotated: number;
    aiKeysRotated: number;
    failedTenants: string[];
  };
  /** Rows of all tenants whose key version is not the active one, after the run. */
  remaining: { integrations: number; aiKeys: number };
  /**
   * False when the stale count of at least one tenant could not be read (that
   * tenant is then in `totals.failedTenants`): `remaining` is a lower bound.
   */
  remainingComplete: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jobContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
}

/**
 * A message safe to put in the report. Driver errors go through
 * `databaseError` (drizzle wraps the query and its parameters in the message).
 * Coded domain errors (HttpError, PlatformError) report the class and the
 * constant code only. Anything else (a JSON.parse SyntaxError, a crypto
 * failure) gets a fixed text: its message can quote the opened value.
 */
function safeError(
  error: unknown,
  databaseError: (error: unknown) => string,
): string {
  // Drizzle wraps a failed query in an error whose `cause` is the original.
  const domain = [error, (error as { cause?: unknown } | null)?.cause].find(
    (candidate): candidate is Error =>
      candidate instanceof Error &&
      (candidate.name === "HttpError" || candidate.name === "PlatformError"),
  );
  if (domain) {
    const code = (domain as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
      ? `${domain.name} (${code})`
      : domain.name;
  }
  const driver =
    typeof error === "object" &&
    error !== null &&
    ("code" in error ||
      (error instanceof Error &&
        typeof error.cause === "object" &&
        error.cause !== null &&
        "code" in error.cause));
  if (driver) return databaseError(error).slice(0, 200);
  return "Stored value could not be processed (details withheld).";
}

export async function runDataKeyRotation(
  options: DataKeyRotationOptions = {},
): Promise<DataKeyRotationReport> {
  const { tenantId, force = false, dryRun = false } = options;
  if (tenantId !== undefined && !UUID.test(tenantId))
    throw new Error("tenantId must be a tenant id (UUID).");

  const { db } = await import("./index.ts");
  const { databaseError } = await import("./connection.ts");
  const { withTenant } = await import("./tenant.ts");
  const { currentSealVersion } = await import("../lib/secrets.ts");
  const { setAuditWriter } = await import("../services/audit-writer.ts");
  const { coreAuditWriter } = await import("../services/core-audit-writer.ts");
  const { rotateIntegrationCredentials } =
    await import("../services/platform-integration.service.ts");
  const { rotateAiProviderKeys } =
    await import("../services/ai-provider-config.service.ts");
  // The default audit writer fails closed; a CLI process never ran app.ts.
  setAuditWriter(coreAuditWriter);

  const activeVersion = currentSealVersion();

  // Every tenant id, suspended and archived included (no RLS on this table).
  const listed = await db.execute(
    sql`SELECT id FROM public.tenants ORDER BY id`,
  );
  const allIds = listed.rows.map((row) => String(row.id));
  if (tenantId !== undefined && !allIds.includes(tenantId))
    throw new Error(`Tenant ${tenantId} does not exist.`);
  const targetIds = tenantId === undefined ? allIds : [tenantId];

  /** Stale rows of a tenant: not at the active version (or all, with force). */
  async function countStale(
    id: string,
    includeAll: boolean,
  ): Promise<{ integrations: number; aiKeys: number }> {
    return withTenant(db, jobContext(id), async (tx) => {
      const [integrations] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(tenantIntegrations)
        .where(
          and(
            sql`${tenantIntegrations.tenantId} = ${id}`,
            sql`${tenantIntegrations.credentialsEncrypted} IS NOT NULL`,
            includeAll
              ? sql`true`
              : or(
                  isNull(tenantIntegrations.credentialsKeyVersion),
                  ne(tenantIntegrations.credentialsKeyVersion, activeVersion),
                ),
          ),
        );
      const [aiKeys] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(aiProviderConfigs)
        .where(
          and(
            sql`${aiProviderConfigs.tenantId} = ${id}`,
            sql`${aiProviderConfigs.apiKeyEncrypted} IS NOT NULL`,
            includeAll
              ? sql`true`
              : or(
                  isNull(aiProviderConfigs.apiKeyKeyVersion),
                  ne(aiProviderConfigs.apiKeyKeyVersion, activeVersion),
                ),
          ),
        );
      return {
        integrations: Number(integrations?.n ?? 0),
        aiKeys: Number(aiKeys?.n ?? 0),
      };
    });
  }

  const tenants: DataKeyRotationTenantReport[] = [];
  for (const id of targetIds) {
    const entry: DataKeyRotationTenantReport = {
      tenantId: id,
      integrationsRotated: 0,
      aiKeysRotated: 0,
    };
    const errors: string[] = [];
    if (dryRun) {
      try {
        const stale = await countStale(id, force);
        entry.integrationsRotated = stale.integrations;
        entry.aiKeysRotated = stale.aiKeys;
      } catch (error) {
        errors.push(safeError(error, databaseError));
      }
    } else {
      // Each part has its own transaction; a failure of one still lets the
      // other run (the failed one rolled back whole).
      try {
        entry.integrationsRotated = (
          await rotateIntegrationCredentials(jobContext(id), {
            actorUserId: null,
            force,
          })
        ).rotated;
      } catch (error) {
        errors.push(`integrations: ${safeError(error, databaseError)}`);
      }
      try {
        entry.aiKeysRotated = (
          await rotateAiProviderKeys(jobContext(id), {
            actorUserId: null,
            force,
          })
        ).rotated;
      } catch (error) {
        errors.push(`ai keys: ${safeError(error, databaseError)}`);
      }
    }
    if (errors.length > 0) entry.error = errors.join("; ");
    tenants.push(entry);
  }

  // What is still stale in the whole database, locked rows included. A tenant
  // whose count fails is reported as failed; the others are still counted.
  const remaining = { integrations: 0, aiKeys: 0 };
  let remainingComplete = true;
  for (const id of allIds) {
    let entry = tenants.find((t) => t.tenantId === id);
    try {
      const stale = await countStale(id, false);
      remaining.integrations += stale.integrations;
      remaining.aiKeys += stale.aiKeys;
      // rotateAiProviderKeys skips a key that will not open without a trace
      // here, so a key still stale after a real run is reported on its tenant.
      if (
        entry &&
        !dryRun &&
        stale.aiKeys > 0 &&
        !entry.error?.includes("ai keys:")
      )
        entry.error = [
          entry.error,
          `ai keys: ${stale.aiKeys} key(s) could not be re-sealed (unreadable, skipped)`,
        ]
          .filter(Boolean)
          .join("; ");
    } catch (error) {
      remainingComplete = false;
      if (!entry) {
        entry = { tenantId: id, integrationsRotated: 0, aiKeysRotated: 0 };
        tenants.push(entry);
      }
      entry.error = [
        entry.error,
        `remaining count: ${safeError(error, databaseError)}`,
      ]
        .filter(Boolean)
        .join("; ");
    }
  }

  return {
    activeVersion,
    dryRun,
    tenants,
    totals: {
      integrationsRotated: tenants.reduce(
        (n, t) => n + t.integrationsRotated,
        0,
      ),
      aiKeysRotated: tenants.reduce((n, t) => n + t.aiKeysRotated, 0),
      failedTenants: tenants.filter((t) => t.error).map((t) => t.tenantId),
    },
    remaining,
    remainingComplete,
  };
}

const USAGE =
  "Usage: pnpm db:rotate-data-key [--tenant <id>] [--force] [--dry-run]";

export function parseArgs(rawArgs: string[]): DataKeyRotationOptions {
  // pnpm forwards a literal "--" when called as `pnpm db:rotate-data-key -- ...`.
  const args = rawArgs.filter((arg) => arg !== "--");
  const options: DataKeyRotationOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--force" && !options.force) options.force = true;
    else if (arg === "--dry-run" && !options.dryRun) options.dryRun = true;
    else if (arg === "--tenant" && args[i + 1] && !options.tenantId) {
      options.tenantId = args[++i]!;
      if (!UUID.test(options.tenantId))
        throw new Error(`--tenant must be a tenant id (UUID).`);
    } else throw new Error("Unknown or repeated argument.");
  }
  return options;
}

/** Returns the exit code: 2 usage, 1 failed tenant or rows left, 0 ok. */
export async function cli(args: string[]): Promise<number> {
  let options: DataKeyRotationOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  await import("../load-env.ts");
  // No data-import guard: nothing is imported, the deployment's own rows are
  // re-sealed in place under the same plaintext.
  const { pool } = await import("./index.ts");
  try {
    const report = await runDataKeyRotation(options);
    console.log(JSON.stringify(report, null, 2));
    if (report.totals.failedTenants.length > 0) return 1;
    if (!report.remainingComplete) return 1;
    if (!report.dryRun) {
      if (report.remaining.integrations + report.remaining.aiKeys > 0) return 1;
    }
    return 0;
  } catch (error) {
    const { databaseError } = await import("./connection.ts");
    console.error(safeError(error, databaseError));
    return 1;
  } finally {
    await pool.end();
  }
}
