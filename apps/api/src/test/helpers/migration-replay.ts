// legend-edxtt: replays a data migration for ONE tenant only.
//
// Data migrations backfill with INSERT ... SELECT over every tenant. Replayed as
// the owner in a shared test database, such a scan can meet a tenant another
// test file is deleting (or an orphan row of a dead tenant) and fail the
// chart_of_accounts_tenant_id_tenants_id_fk foreign key (23503). The replay also
// lifts FORCE ROW LEVEL SECURITY, so a failure outside a transaction would leave
// it off. Here the replay runs in one transaction, as the non-BYPASSRLS runtime
// role with app.tenant_id set, so row level security limits every statement to
// the given tenant and no foreign tenant row is read or written. The role is not
// the table owner, so FORCE ROW LEVEL SECURITY statements are skipped: FORCE
// stays on and can never be left off.
import type { Pool } from "pg";

const FORCE_RLS_STATEMENT =
  /^\s*ALTER\s+TABLE\s+\S+\s+(?:NO\s+)?FORCE\s+ROW\s+LEVEL\s+SECURITY\s*;?\s*$/i;

const LOCK_TIMEOUT = "30s";

function runtimeRole(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) throw new Error("APP_DATABASE_URL is required for a scoped replay");
  const username = decodeURIComponent(new URL(url).username);
  if (!username) throw new Error("APP_DATABASE_URL has no username");
  return `"${username.replaceAll('"', '""')}"`;
}

/**
 * Runs the statements of `sql` (split on `--> statement-breakpoint`) in one
 * transaction as the runtime role, scoped to `tenantId`. `owner` must be the
 * migration owner (a superuser or a member of the runtime role).
 */
export async function replayMigrationForTenant(
  owner: Pool,
  sql: string,
  tenantId: string,
): Promise<void> {
  const role = runtimeRole();
  const client = await owner.connect();
  let rollbackFailure: Error | undefined;
  try {
    await client.query("BEGIN");
    // A stuck tenant deleter must fail the replay, not hang it.
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    // Keep concurrent tenant teardown from invalidating the replay.
    await client.query("LOCK TABLE public.tenants IN SHARE MODE");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    for (const statement of sql.split("--> statement-breakpoint")) {
      const code = statement.replace(/--.*$/gm, "").trim();
      if (!code || FORCE_RLS_STATEMENT.test(code)) continue;
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      rollbackFailure =
        rollbackError instanceof Error
          ? rollbackError
          : new Error(`Rollback failed: ${String(rollbackError)}`);
    }
    throw error;
  } finally {
    client.release(rollbackFailure);
  }
}
