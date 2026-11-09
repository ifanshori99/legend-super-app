// One-off repair (bead legend-d21p): before commit 5316426a, `runRefundPayout`
// claimed approved refunds (payout_attempts + 1) even though the refund port was
// unconfigured; the port then threw SERVICE_UNAVAILABLE, stored in
// last_payout_error. After 8 attempts the sweep flagged MANUAL_RECONCILIATION.
// Those refunds were never sent, but attempts > 0 now reads as "maybe sent", so
// they would never be POSTed once DOIT_REFUNDS_ENABLED=true. This script puts
// them back to a clean "never attempted" state.
//
// After the switch is on, a real DOIT POST that times out or gets a 5xx is also
// stored as SERVICE_UNAVAILABLE and ends MANUAL_RECONCILIATION with no
// provider_ref and no polls: the same shape as a pre-switch row. Ops may also
// have paid MANUAL_RECONCILIATION refunds by hand. So --apply only touches rows
// last updated before the cutoff (--touched-before: start of the FIRST worker
// built from 5316426a or later in that environment) AND listed in a
// file that finance has reviewed (--ids).
//
// Run order, per environment:
//   (a) deploy a build that contains this runner, DOIT_REFUNDS_ENABLED off. The
//       cutoff is the start time of the FIRST worker built from 5316426a or later
//       (too early is safe, too late is not), not this deploy's time.
//   (b) pnpm db:reset-preswitch-refunds --touched-before <cutoff>
//       (dry-run: prints the rows, their amount and decision time, and an id list)
//   (c) finance confirms no listed refund was paid by hand; save the reviewed
//       ids to a file, one per line.
//   (d) pnpm db:reset-preswitch-refunds --apply --touched-before <cutoff> --ids <file>
//   (e) dry-run with --touched-before <t> --ids <file>; expect 0 rows. A plain
//       dry-run must list only the ids finance kept out; close each with
//       POST .../refunds/<id>/settle-manually (settleRefundManually: ends it
//       `completed`, SETTLED_OUTSIDE_PROVIDER, no payout).
//   (f) only then turn on DOIT_REFUNDS_ENABLED.
//
// Reads MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE (a path to a file
// holding the URL, not both); with neither set it falls back to the local dev
// DATABASE_URL. URLs are never printed. Runs as the migration owner (like
// seed-dev-tenant.ts), one transaction per tenant so each UPDATE and its audit
// row commit together. The guards below abort an --apply before any write; a
// dry-run only warns.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  createUlid,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { recordAudit } from "../services/core-audit.ts";
import { databaseError, databaseUrl } from "./connection";
import * as schema from "./schema";

export const RESET_ACTION = "payment.refund_payout_preswitch_reset";
export const RESET_REASON = "legend-d21p Q17 founder 2026-11-09";
const RESETTABLE_ERRORS = [
  "SERVICE_UNAVAILABLE",
  "MANUAL_RECONCILIATION",
  "PAYOUT_QUARANTINED",
] as const;

export const USAGE =
  "Usage: db:reset-preswitch-refunds [--dry-run | --apply] [--touched-before <ISO>] [--ids <file>]\n" +
  "  (production image: node dist/reset-preswitch-refunds.js with the same options)\n" +
  "  --dry-run                 (default) list the refunds that would be reset, write nothing\n" +
  "  --apply                   reset them and write one audit row per refund\n" +
  "  --touched-before <ISO>    only rows last updated before this time: start of the FIRST\n" +
  "                            worker built from 5316426a or later, with offset,\n" +
  "                            e.g. 2026-11-09T03:00:00Z; required for --apply\n" +
  "  --ids <file>              reviewed refund ids, one uuid per line (blank and # lines\n" +
  "                            ignored); required for --apply, only these rows are touched\n" +
  "Run order: (a) deploy a build with this runner, DOIT_REFUNDS_ENABLED off; take the cutoff\n" +
  "  from the first worker built from 5316426a or later (too early is safe, too late is not);\n" +
  "  (b) dry-run with --touched-before; (c) finance confirms no listed refund was paid\n" +
  "  by hand, save the reviewed ids to a file; (d) --apply --touched-before <t> --ids <file>;\n" +
  "  (e) dry-run with the same --touched-before and --ids, expect 0 (a plain dry-run lists only ids kept out);\n" +
  "  (f) only then turn on DOIT_REFUNDS_ENABLED.";

/** A guard refused the run; nothing was written. */
export class PreswitchResetAborted extends Error {}

/** Bad arguments or input file; nothing was read or written. Exit code 2. */
export class PreswitchResetUsageError extends Error {}

export type PreswitchRefund = {
  tenantId: string;
  outletId: string;
  id: string;
  amountIdr: number;
  decidedAt: string | null;
  payoutAttempts: number;
  lastPayoutError: string;
};

export type PreswitchResetResult = {
  apply: boolean;
  candidates: PreswitchRefund[];
  reset: number;
  /** Ids from --ids that no longer match every criterion; never touched. */
  skipped: string[];
  /** Rows proving the DOIT refund switch was on at some point (guard 2). */
  switchEvidence: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Explicit offset required: a local time would shift the cutoff by hours.
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Parses the --ids file: one uuid per line, blank and `#` lines ignored. */
export function parseIdsFile(text: string): string[] {
  const ids: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (!UUID.test(line))
      throw new PreswitchResetUsageError(
        `--ids file line ${index + 1} is not a refund uuid.`,
      );
    ids.push(line.toLowerCase());
  });
  if (ids.length === 0)
    throw new PreswitchResetUsageError("--ids file lists no refund ids.");
  return [...new Set(ids)];
}

/**
 * `new Date` rolls an impossible date over (2026-11-31 becomes Dec 1), which
 * would move the cutoff a day late. Shift the parsed instant back by the typed
 * offset and require the same year, month and day that were typed.
 */
function sameCalendarDate(value: string, parsed: Date): boolean {
  const offset = /(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!offset) return false;
  const minutes =
    offset[1] === "Z"
      ? 0
      : (offset[2] === "-" ? -1 : 1) *
        (Number(offset[3]) * 60 + Number(offset[4]));
  const local = new Date(parsed.getTime() + minutes * 60_000);
  return local.toISOString().slice(0, 10) === value.slice(0, 10);
}

export function parseCutoff(value: string): Date {
  const cutoff = new Date(value);
  if (
    !ISO_WITH_OFFSET.test(value) ||
    Number.isNaN(cutoff.getTime()) ||
    !sameCalendarDate(value, cutoff)
  )
    throw new PreswitchResetUsageError(
      "--touched-before must be an ISO time with offset, e.g. 2026-11-09T03:00:00Z.",
    );
  return cutoff;
}

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function tenantContext(tenantId: string): ScopedTenantContext {
  // The same context the worker builds per tenant (worker/production-config.ts
  // resolveContext): job source, tenant-wide scope.
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantId as TenantId,
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );
}

/** Owner connections are subject to FORCE RLS: install the tenant like `withTenant`. */
async function enterTenant(tx: Tx, tenantId: string) {
  await tx.execute(
    sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.outlet_ids', '*', true)`,
  );
}

const asNumber = (value: unknown) => Number(value);

function candidateWhere(now: Date, cutoff?: Date, ids?: string[]) {
  return sql`status = 'approved' AND provider_ref IS NULL AND payout_pending_polls = 0
    AND payout_attempts > 0
    AND last_payout_error IN (${sql.join(
      RESETTABLE_ERRORS.map((code) => sql`${code}`),
      sql`, `,
    )})
    AND (payout_claimed_until IS NULL OR payout_claimed_until <= ${now})
    ${cutoff ? sql`AND updated_at < ${cutoff}` : sql``}
    ${
      ids
        ? ids.length > 0
          ? sql`AND id IN (${sql.join(
              ids.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql`AND false`
        : sql``
    }`;
}

export async function run(options: {
  pool: Pool;
  apply: boolean;
  env: Record<string, string | undefined>;
  now: Date;
  log: (line: string) => void;
  /** Only rows with updated_at before this time; required for apply. */
  touchedBefore?: Date;
  /** Reviewed refund ids; required for apply, rows outside it are never touched. */
  ids?: string[];
}): Promise<PreswitchResetResult> {
  const { pool, apply, env, now, log, touchedBefore } = options;
  const ids = options.ids?.map((id) => id.toLowerCase());
  if (apply && !touchedBefore)
    throw new PreswitchResetUsageError("--apply requires --touched-before.");
  if (apply && !ids)
    throw new PreswitchResetUsageError("--apply requires --ids <file>.");
  if (touchedBefore && Number.isNaN(touchedBefore.getTime()))
    throw new PreswitchResetUsageError("--touched-before is not a valid time.");
  if (touchedBefore && touchedBefore.getTime() > now.getTime())
    throw new PreswitchResetUsageError(
      "--touched-before is in the future; use the start time of the first worker built from 5316426a or later.",
    );
  if (ids?.some((id) => !UUID.test(id)))
    throw new PreswitchResetUsageError(
      "--ids holds a value that is not a uuid.",
    );
  if (!touchedBefore)
    log(
      "WARNING: no cutoff (--touched-before); rows touched after the deploy may be real DOIT sends.",
    );
  const db = drizzle(pool, { schema });
  const tenantIds = (
    await db.execute(sql`SELECT id FROM tenants ORDER BY id`)
  ).rows.map((row) => String(row.id));

  // Read pass: candidates and switch evidence across all tenants, before any write.
  const candidates: PreswitchRefund[] = [];
  let switchEvidence = 0;
  for (const tenantId of tenantIds) {
    await db.transaction(async (tx) => {
      await enterTenant(tx, tenantId);
      const rows = await tx.execute(
        sql`SELECT tenant_id, outlet_id, id, amount_idr, decided_at, payout_attempts, last_payout_error
            FROM payment_refunds WHERE ${candidateWhere(now, touchedBefore, ids)}
            ORDER BY created_at, id`,
      );
      for (const row of rows.rows)
        candidates.push({
          tenantId: String(row.tenant_id),
          outletId: String(row.outlet_id),
          id: String(row.id),
          amountIdr: asNumber(row.amount_idr),
          decidedAt:
            row.decided_at == null
              ? null
              : new Date(row.decided_at as string | Date).toISOString(),
          payoutAttempts: asNumber(row.payout_attempts),
          lastPayoutError: String(row.last_payout_error),
        });
      // Any trace of a real DOIT call: a provider ref, a poll, a DOIT_* or
      // client-side DOIT error code, a lookup DOIT answered `not_found`
      // (PAYOUT_NOT_FOUND_MAYBE_SENT, legend-xd2q), or a refund DOIT declined.
      const evidence = await tx.execute(
        sql`SELECT count(*) AS n FROM payment_refunds
            WHERE provider_ref IS NOT NULL OR payout_pending_polls > 0
               OR last_payout_error LIKE 'DOIT\\_%' ESCAPE '\\'
               OR last_payout_error IN ('VALIDATION_ERROR', 'IDEMPOTENCY_KEY_REUSED', 'PAYOUT_NOT_FOUND_MAYBE_SENT')
               OR (status = 'failed' AND failure_reason = 'provider_declined')`,
      );
      switchEvidence += asNumber(evidence.rows[0]?.n);
    });
  }

  const matched = new Set(candidates.map((row) => row.id));
  const skipped = (ids ?? []).filter((id) => !matched.has(id));

  const switchOn = ["true", "1"].includes(env.DOIT_REFUNDS_ENABLED ?? "");
  const problems: string[] = [];
  if (switchOn)
    problems.push(
      "DOIT_REFUNDS_ENABLED is on in this environment. Reset BEFORE the switch, never after: a reset refund would be sent to DOIT.",
    );
  if (switchEvidence > 0)
    problems.push(
      `${switchEvidence} refund row(s) already carry a provider_ref, pending polls, a DOIT error code, or a provider decline, so the DOIT refund switch was on at some point. Attempts on the remaining rows may be real sends; reconcile them by hand instead.`,
    );
  if (apply && problems.length > 0)
    throw new PreswitchResetAborted(
      `Refusing to --apply, nothing was written.\n- ${problems.join("\n- ")}`,
    );
  for (const problem of problems) log(`WARNING: ${problem}`);

  log(
    `${candidates.length} approved refund(s) match (${apply ? "apply" : "dry-run"}).`,
  );
  for (const row of candidates)
    log(
      `tenant=${row.tenantId} refund=${row.id} amountIdr=${row.amountIdr} decidedAt=${row.decidedAt ?? "-"} attempts=${row.payoutAttempts} lastError=${row.lastPayoutError}`,
    );
  for (const id of skipped)
    log(`SKIPPED refund=${id}: listed in --ids but no longer matches.`);
  if (!apply) {
    if (candidates.length > 0) {
      log(
        "# Ids for finance review (save the confirmed ones to a file for --ids):",
      );
      for (const row of candidates) log(row.id);
      log("Dry-run: nothing written. Add --apply.");
    }
    return { apply, candidates, reset: 0, skipped, switchEvidence };
  }

  let reset = 0;
  const lost: string[] = [];
  const byTenant = new Map<string, PreswitchRefund[]>();
  for (const row of candidates)
    byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row]);
  for (const [tenantId, rows] of byTenant) {
    const context = tenantContext(tenantId);
    reset += await db.transaction(async (tx) => {
      await enterTenant(tx, tenantId);
      // Lock first, then re-check the whole WHERE in the UPDATE: a row may have
      // changed since the read pass.
      const lockIds = sql.join(
        rows.map((row) => sql`${row.id}::uuid`),
        sql`, `,
      );
      const locked = await tx.execute(
        sql`SELECT id, outlet_id, payout_attempts, last_payout_error
            FROM payment_refunds
            WHERE id IN (${lockIds}) AND ${candidateWhere(now, touchedBefore, ids)}
            ORDER BY id FOR UPDATE`,
      );
      const lockedIds = new Set(locked.rows.map((row) => String(row.id)));
      for (const row of rows) if (!lockedIds.has(row.id)) lost.push(row.id);
      let count = 0;
      for (const row of locked.rows) {
        const updated = await tx.execute(
          sql`UPDATE payment_refunds SET
                payout_attempts = 0,
                last_payout_error = CASE WHEN last_payout_error = 'PAYOUT_QUARANTINED' THEN 'PAYOUT_QUARANTINED' ELSE NULL END,
                payout_claimed_until = NULL,
                payout_claim_token = NULL,
                updated_at = ${now}
              WHERE id = ${String(row.id)}::uuid AND ${candidateWhere(now, touchedBefore, ids)}
              RETURNING last_payout_error`,
        );
        if (updated.rowCount !== 1) {
          lost.push(String(row.id));
          continue;
        }
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId,
            outletId: String(row.outlet_id),
            actorType: "system",
            actorId: null,
            deviceId: null,
            action: RESET_ACTION,
            objectType: "payment_refund",
            objectId: String(row.id),
            reason: RESET_REASON,
            maskedChanges: {
              before: {
                payoutAttempts: asNumber(row.payout_attempts),
                lastPayoutError: String(row.last_payout_error),
              },
              after: {
                payoutAttempts: 0,
                lastPayoutError: updated.rows[0]?.last_payout_error ?? null,
              },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: now.toISOString(),
          },
          ["payoutAttempts", "lastPayoutError"],
        );
        count += 1;
      }
      return count;
    });
  }
  for (const id of lost)
    log(`SKIPPED refund=${id}: changed since the read pass, not reset.`);
  log(`Reset ${reset} refund(s), ${reset} audit row(s) written.`);
  return {
    apply,
    candidates,
    reset,
    skipped: [...skipped, ...lost],
    switchEvidence,
  };
}

/**
 * MIGRATION_DATABASE_URL or _FILE (not both). The dev path falls back to the
 * local DATABASE_URL; the production bundle (`requireMigrationUrl`) does not.
 */
function migrationDatabaseUrl(requireMigrationUrl: boolean) {
  const direct = process.env.MIGRATION_DATABASE_URL;
  const file = process.env.MIGRATION_DATABASE_URL_FILE;
  if (direct && file)
    throw new PreswitchResetUsageError(
      "Set MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE, not both.",
    );
  if (file) {
    let value: string;
    try {
      value = readFileSync(file, "utf8").trim();
    } catch {
      throw new PreswitchResetUsageError(
        "Cannot read the file named by MIGRATION_DATABASE_URL_FILE.",
      );
    }
    return databaseUrl(value);
  }
  if (!direct && requireMigrationUrl)
    throw new PreswitchResetUsageError(
      "MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE is required.",
    );
  return direct ? databaseUrl(direct) : databaseUrl();
}

/** Parses the CLI arguments and reads the --ids file. Throws PreswitchResetUsageError. */
export function parseArgs(args: string[]) {
  let apply = false;
  let dryRun = false;
  let touchedBefore: Date | undefined;
  let idsFile: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--touched-before" && args[i + 1] && !touchedBefore)
      touchedBefore = parseCutoff(args[++i]!);
    else if (arg === "--ids" && args[i + 1] && !idsFile) idsFile = args[++i];
    else throw new PreswitchResetUsageError(`Unknown or repeated argument.`);
  }
  if (apply && dryRun)
    throw new PreswitchResetUsageError("Use --apply or --dry-run, not both.");
  let ids: string[] | undefined;
  if (idsFile) {
    let text: string;
    try {
      text = readFileSync(idsFile, "utf8");
    } catch {
      throw new PreswitchResetUsageError("Cannot read the --ids file.");
    }
    ids = parseIdsFile(text);
  }
  if (apply && !touchedBefore)
    throw new PreswitchResetUsageError("--apply requires --touched-before.");
  if (apply && !ids)
    throw new PreswitchResetUsageError("--apply requires --ids <file>.");
  return { apply, touchedBefore, ids };
}

/**
 * The CLI shared by `pnpm db:reset-preswitch-refunds` (tsx, `loadEnv: true`)
 * and `node dist/reset-preswitch-refunds.js` (production, `loadEnv: false`:
 * no .env files, MIGRATION_DATABASE_URL or _FILE required). Returns the exit
 * code: 2 usage, 1 abort or error, 0 ok. Never prints a URL.
 */
export async function cli(
  args: string[],
  options: { loadEnv: boolean },
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (!(error instanceof PreswitchResetUsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.loadEnv) await import("../load-env");
  let pool: Pool | undefined;
  try {
    // The migrator image's env file does not hold the switch. In production
    // deploy/single-vm/reset-preswitch-refunds.sh reads it from the api and
    // worker env files and containers and passes it in; without it the
    // switch check would be blind, so --apply fails closed.
    if (
      !options.loadEnv &&
      parsed.apply &&
      process.env.DOIT_REFUNDS_ENABLED === undefined
    )
      throw new PreswitchResetUsageError(
        "DOIT_REFUNDS_ENABLED is not set, so the switch check is blind. Run --apply through deploy/single-vm/reset-preswitch-refunds.sh.",
      );
    // The wrapper also sets LEGEND_RESET_WRAPPER=1. A raw `compose run`
    // --apply fails closed even if migrator.env sets the switch to false.
    if (
      !options.loadEnv &&
      parsed.apply &&
      process.env.LEGEND_RESET_WRAPPER !== "1"
    )
      throw new PreswitchResetUsageError(
        "LEGEND_RESET_WRAPPER is not 1, so this --apply did not come through the wrapper that checks the api and worker switch. Run --apply through deploy/single-vm/reset-preswitch-refunds.sh.",
      );
    pool = new Pool({
      connectionString: migrationDatabaseUrl(!options.loadEnv),
      max: 1,
    });
    await run({
      pool,
      ...parsed,
      env: process.env,
      now: new Date(),
      log: (line) => console.log(line),
    });
    return 0;
  } catch (error) {
    if (error instanceof PreswitchResetUsageError) {
      console.error(`${error.message}\n${USAGE}`);
      return 2;
    }
    console.error(
      error instanceof PreswitchResetAborted
        ? error.message
        : databaseError(error),
    );
    return 1;
  } finally {
    await pool?.end();
  }
}

// tsx entry point only. tsup inlines this module into
// dist/reset-preswitch-refunds.js, where import.meta.url is the wrapper's own
// URL, so the file name check keeps the bundle from running the CLI twice.
const entry = process.argv[1];
if (
  entry &&
  /reset-preswitch-refund-payouts\.ts$/.test(entry) &&
  import.meta.url === pathToFileURL(entry).href
)
  process.exitCode = await cli(process.argv.slice(2), { loadEnv: true });
