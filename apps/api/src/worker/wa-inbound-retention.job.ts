// WhatsApp inbound retention (card w8dfz.2, design
// docs/design/whatsapp-inbound-verification.md section 4 "Masa simpan"). Once a
// day the worker deletes `wa_inbound_messages` past 90 days and
// `login_challenges` past 30 days: finished ones (`completed`, `expired`,
// `cancelled`) by `created_at`, and abandoned `pending` ones (never polled, so
// never marked expired) once `expires_at` is itself 30 days past. A live
// `pending` challenge (not yet expired, or expired less than 30 days ago) is
// never deleted.
//
// Both tables are service-scoped (no RLS), so the plain app connection
// (legend_app, which holds DELETE) is enough; no maintenance login is needed.
// WhatsApp audit rows are NOT purged here: audit-retention.job.ts already
// removes every `audit_2y` row at 2 years, so a second purge would duplicate it.
//
// Rows go in batches (one DELETE per batch, looping until a short batch), so a
// large backlog never holds one long lock. `wa_inbound_messages.challenge_id`
// has a plain FK to `login_challenges`: messages are deleted first, and a
// challenge that a younger message still points at is kept for the next run, so
// the run never fails on that FK. Idempotent: a second run finds nothing.

import { sql } from "drizzle-orm";
import { db } from "../db";

export const WA_INBOUND_RETENTION_QUEUE = "wa-inbound-retention-purge";
export const WA_INBOUND_RETENTION_CRON = "45 2 * * *";
export const WA_INBOUND_RETENTION_TZ = "Asia/Jakarta";
export const WA_INBOUND_RETENTION_BATCH = 1000;
export const WA_INBOUND_MESSAGE_RETENTION_DAYS = 90;
export const WA_INBOUND_CHALLENGE_RETENTION_DAYS = 30;
/** pg-boss must not expire a run that is still inside its work. */
const WA_INBOUND_RETENTION_EXPIRE_SECONDS = 25 * 60;

export type WaInboundRetentionResult = {
  messages: number;
  challenges: number;
};

async function deleteInBatches(
  batchSize: number,
  deleteBatch: () => Promise<number>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await deleteBatch();
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

export async function runWaInboundRetention(
  options: { tenantId?: string; batchSize?: number } = {},
): Promise<WaInboundRetentionResult> {
  const batchSize = options.batchSize ?? WA_INBOUND_RETENTION_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error("WhatsApp retention batch size must be a positive integer");
  const tenantId = options.tenantId ?? null;

  const messages = await deleteInBatches(batchSize, async () => {
    const result = await db.execute(sql`
      WITH deleted AS (
        DELETE FROM wa_inbound_messages
        WHERE id IN (
          SELECT m.id FROM wa_inbound_messages m
          WHERE m.created_at < now() - make_interval(days => ${WA_INBOUND_MESSAGE_RETENTION_DAYS})
            AND (${tenantId}::uuid IS NULL OR m.tenant_id = ${tenantId}::uuid)
          ORDER BY m.created_at
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING 1
      )
      SELECT count(*)::int AS deleted FROM deleted`);
    return Number(result.rows[0]?.deleted ?? 0);
  });

  const challenges = await deleteInBatches(batchSize, async () => {
    const result = await db.execute(sql`
      WITH deleted AS (
        DELETE FROM login_challenges
        WHERE id IN (
          SELECT c.id FROM login_challenges c
          WHERE (
              (c.status IN ('completed', 'expired', 'cancelled')
                AND c.created_at < now() - make_interval(days => ${WA_INBOUND_CHALLENGE_RETENTION_DAYS}))
              OR (c.status = 'pending'
                AND c.expires_at < now() - make_interval(days => ${WA_INBOUND_CHALLENGE_RETENTION_DAYS}))
            )
            AND (${tenantId}::uuid IS NULL OR c.tenant_id = ${tenantId}::uuid)
            AND NOT EXISTS (
              SELECT 1 FROM wa_inbound_messages m WHERE m.challenge_id = c.id
            )
          ORDER BY c.created_at
          LIMIT ${batchSize}
          FOR UPDATE OF c SKIP LOCKED
        )
        RETURNING 1
      )
      SELECT count(*)::int AS deleted FROM deleted`);
    return Number(result.rows[0]?.deleted ?? 0);
  });

  return { messages, challenges };
}

type WaInboundRetentionBoss = {
  createQueue(
    name: string,
    options?: { policy?: string; expireInSeconds?: number },
  ): Promise<void>;
  schedule(
    name: string,
    cron: string,
    data?: object | null,
    options?: { tz?: string },
  ): Promise<void>;
  work(
    name: string,
    handler: (jobs: { data: unknown }[]) => Promise<void>,
  ): Promise<unknown>;
};

/** Call after the boss has started. `exclusive` keeps a slow run from overlapping the next. */
export async function registerWaInboundRetentionJob(options: {
  boss: WaInboundRetentionBoss;
  log?: Pick<Console, "error" | "info">;
}): Promise<void> {
  const { boss } = options;
  const log = options.log ?? console;
  await boss.createQueue(WA_INBOUND_RETENTION_QUEUE, {
    policy: "exclusive",
    expireInSeconds: WA_INBOUND_RETENTION_EXPIRE_SECONDS,
  });
  await boss.schedule(WA_INBOUND_RETENTION_QUEUE, WA_INBOUND_RETENTION_CRON, null, {
    tz: WA_INBOUND_RETENTION_TZ,
  });
  await boss.work(WA_INBOUND_RETENTION_QUEUE, async () => {
    try {
      const result = await runWaInboundRetention();
      log.info(`WhatsApp inbound retention finished ${JSON.stringify(result)}`);
    } catch (error) {
      log.error(
        `WhatsApp inbound retention job failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      throw error;
    }
  });
}
