// Platform resend of a staff status step (bead legend-r7vxn; founder Q56: an
// order keeps going at the outlet when GoFood/GrabFood is down or refuses, the
// system resends by itself, and an unsynced order is flagged for staff).
//
// The step itself is pushed after commit by the delivery consumer
// (delivery-sync-consumer.ts, legend-bk99). Its outcome lives on the order row:
// - accepted: `platform_sync_state` `ok`, nothing stored.
// - unknown (the call threw: timeout, network): `retrying`, with the action and
//   target status stored; `retryDeliveryPlatformIntents` (worker sweep) resends
//   it with backoff until the platform accepts, answers clearly, or
//   PLATFORM_SYNC_MAX_ATTEMPTS calls were made.
// - refused (a clear answer): `needs_action`. A refusal is never resent.
//
// Resend is idempotent: the adapter reference is `<order id>:<status>`, the
// same as the consumer's, so a platform that already took the step answers the
// repeat as accepted instead of applying it twice. Concurrent workers cannot
// both resend one row: the claim takes it FOR UPDATE SKIP LOCKED and leases it
// (next_at moves PLATFORM_SYNC_LEASE_MS ahead, attempts + 1) in one short
// transaction; the platform call runs outside any transaction, and its result
// is written only when the row still holds the claimed intent and attempt
// (a newer staff step or a later claim wins).
import { and, eq, inArray, lt, lte, ne, sql } from "drizzle-orm";
import {
  createUlid,
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliveryChannelOrders } from "../db/schema/delivery.ts";
import { recordAudit } from "./core-audit.ts";
import { deliveryChannelAdapterFor } from "./delivery-ports.ts";
import type { Tx } from "./permission-resolver.ts";

/** Platform calls made for one step (the consumer's own call is the first). */
export const PLATFORM_SYNC_MAX_ATTEMPTS = 6;

/**
 * A claimed row is not claimable again for this long (crashed worker). It must
 * outlast one sweep run: the calls of a batch run together, so a run takes
 * about one adapter timeout (DELIVERY_ADAPTER_TIMEOUT_MS), far below the lease.
 */
export const PLATFORM_SYNC_LEASE_MS = 5 * 60_000;

/** Rows one sweep run resends (all at once); the rest wait for the next tick. */
export const PLATFORM_SYNC_BATCH = 10;

const BACKOFF_CAP_MINUTES = 30;

/** Wait after `attempts` calls: 2^attempts minutes, capped at 30. */
export function platformSyncBackoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(attempts, 1), BACKOFF_CAP_MINUTES) * 60_000;
}

type PlatformIntent = {
  readonly action: "accept_order" | "update_order" | "cancel_order";
  readonly status: (typeof deliveryChannelOrders.$inferSelect)["status"];
};

/** The platform took the step: nothing is pending any more. */
export async function markPlatformSynced(
  tx: Tx,
  tenantId: TenantId,
  deliveryChannelOrderId: string,
): Promise<void> {
  await tx
    .update(deliveryChannelOrders)
    .set({
      platformSyncState: "ok",
      platformSyncAction: null,
      platformSyncStatus: null,
      platformSyncAttempts: 0,
      platformSyncNextAt: null,
    })
    .where(
      and(
        eq(deliveryChannelOrders.tenantId, tenantId),
        eq(deliveryChannelOrders.id, deliveryChannelOrderId),
        ne(deliveryChannelOrders.platformSyncState, "ok"),
      ),
    );
}

/**
 * The consumer's own call was not taken. `unknown` is queued for resend (it
 * counts as attempt 1); `refused` is a final answer that needs staff.
 */
export async function markPlatformUnsynced(
  tx: Tx,
  input: {
    readonly tenantId: TenantId;
    readonly deliveryChannelOrderId: string;
    readonly outcome: "refused" | "unknown";
    readonly intent: PlatformIntent;
    readonly now: Date;
  },
): Promise<void> {
  const retrying = input.outcome === "unknown";
  await tx
    .update(deliveryChannelOrders)
    .set({
      platformSyncState: retrying ? "retrying" : "needs_action",
      platformSyncAction: input.intent.action,
      platformSyncStatus: input.intent.status,
      platformSyncAttempts: 1,
      platformSyncNextAt: retrying
        ? new Date(input.now.getTime() + platformSyncBackoffMs(1))
        : null,
    })
    .where(
      and(
        eq(deliveryChannelOrders.tenantId, input.tenantId),
        eq(deliveryChannelOrders.id, input.deliveryChannelOrderId),
      ),
    );
}

type Claim = {
  readonly id: string;
  readonly outletId: string;
  readonly platform: (typeof deliveryChannelOrders.$inferSelect)["platform"];
  readonly externalOrderId: string;
  readonly closeReason: string | null;
  readonly action: NonNullable<PlatformIntent["action"]>;
  readonly status: PlatformIntent["status"];
  /** Attempt number of this call (already counted by the claim). */
  readonly attempt: number;
};

async function auditExhausted(
  tx: Tx,
  context: ScopedTenantContext,
  claim: Pick<Claim, "id" | "outletId" | "platform" | "action" | "status">,
  attempts: number,
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: claim.outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: "delivery_order.platform_desync",
      objectType: "delivery_channel_order",
      objectId: claim.id,
      reason: `Pengiriman ulang ${claim.action} ke platform berhenti setelah ${attempts} percobaan; perlu tindakan staf.`,
      maskedChanges: {
        before: { platform: claim.platform, status: claim.status },
        after: {
          platform: claim.platform,
          status: claim.status,
          outcome: "exhausted",
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    ["platform", "status", "outcome"],
  );
}

/**
 * Claims the due `retrying` rows (and gives up on the exhausted ones) in one
 * short transaction; the platform is not called here.
 */
async function claimDue(
  context: ScopedTenantContext,
  now: Date,
  limit: number,
): Promise<Claim[]> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const dueRetrying = and(
      eq(deliveryChannelOrders.tenantId, tenantId),
      eq(deliveryChannelOrders.platformSyncState, "retrying"),
      lte(deliveryChannelOrders.platformSyncNextAt, now),
    );
    // The order moved on without this worker (the platform cancelled it, a
    // webhook advanced it): the stored step no longer applies. Resending it
    // would only be refused and flag the order for nothing.
    await tx
      .update(deliveryChannelOrders)
      .set({
        platformSyncState: "ok",
        platformSyncAction: null,
        platformSyncStatus: null,
        platformSyncAttempts: 0,
        platformSyncNextAt: null,
      })
      .where(
        and(
          dueRetrying,
          sql`${deliveryChannelOrders.platformSyncStatus} IS DISTINCT FROM ${deliveryChannelOrders.status}`,
        ),
      );
    // A worker that died on the last attempt left the row at the cap.
    const gaveUp = await tx
      .update(deliveryChannelOrders)
      .set({ platformSyncState: "needs_action", platformSyncNextAt: null })
      .where(
        and(
          dueRetrying,
          sql`${deliveryChannelOrders.platformSyncAttempts} >= ${PLATFORM_SYNC_MAX_ATTEMPTS}`,
        ),
      )
      .returning({
        id: deliveryChannelOrders.id,
        outletId: deliveryChannelOrders.outletId,
        platform: deliveryChannelOrders.platform,
        action: deliveryChannelOrders.platformSyncAction,
        status: deliveryChannelOrders.platformSyncStatus,
        attempts: deliveryChannelOrders.platformSyncAttempts,
      });
    for (const row of gaveUp)
      if (row.action && row.status)
        await auditExhausted(
          tx,
          context,
          { ...row, action: row.action, status: row.status },
          row.attempts,
          now,
        );
    const due = await tx
      .select({ id: deliveryChannelOrders.id })
      .from(deliveryChannelOrders)
      .where(
        and(
          dueRetrying,
          lt(
            deliveryChannelOrders.platformSyncAttempts,
            PLATFORM_SYNC_MAX_ATTEMPTS,
          ),
        ),
      )
      .orderBy(deliveryChannelOrders.platformSyncNextAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const claimed = await tx
      .update(deliveryChannelOrders)
      .set({
        platformSyncAttempts: sql`${deliveryChannelOrders.platformSyncAttempts} + 1`,
        platformSyncNextAt: new Date(now.getTime() + PLATFORM_SYNC_LEASE_MS),
      })
      .where(
        and(
          eq(deliveryChannelOrders.tenantId, tenantId),
          inArray(
            deliveryChannelOrders.id,
            due.map((row) => row.id),
          ),
        ),
      )
      .returning({
        id: deliveryChannelOrders.id,
        outletId: deliveryChannelOrders.outletId,
        platform: deliveryChannelOrders.platform,
        externalOrderId: deliveryChannelOrders.externalOrderId,
        closeReason: deliveryChannelOrders.closeReason,
        action: deliveryChannelOrders.platformSyncAction,
        status: deliveryChannelOrders.platformSyncStatus,
        attempt: deliveryChannelOrders.platformSyncAttempts,
      });
    return claimed.flatMap((row) =>
      row.action && row.status
        ? [{ ...row, action: row.action, status: row.status }]
        : [],
    );
  });
}

/** Calls the platform for one claim; never throws. */
async function callPlatform(
  context: ScopedTenantContext,
  claim: Claim,
): Promise<"accepted" | "refused" | "unknown"> {
  try {
    const result = await deliveryChannelAdapterFor(claim.platform).execute(
      context,
      {
        tenantId: context.tenant.tenantId,
        outletId: claim.outletId as OutletId,
        reference: `${claim.id}:${claim.status}`,
        channel: claim.platform,
        action: claim.action,
        payload: {
          externalOrderId: claim.externalOrderId,
          status: claim.status,
          reason: claim.closeReason,
        },
      },
    );
    return result.accepted ? "accepted" : "refused";
  } catch {
    return "unknown";
  }
}

/** Writes the outcome only while the row still holds the claimed intent. */
async function settleClaim(
  context: ScopedTenantContext,
  claim: Claim,
  outcome: "accepted" | "refused" | "unknown",
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({
        state: deliveryChannelOrders.platformSyncState,
        action: deliveryChannelOrders.platformSyncAction,
        status: deliveryChannelOrders.platformSyncStatus,
        attempts: deliveryChannelOrders.platformSyncAttempts,
      })
      .from(deliveryChannelOrders)
      .where(
        and(
          eq(deliveryChannelOrders.tenantId, tenantId),
          eq(deliveryChannelOrders.id, claim.id),
        ),
      )
      .limit(1)
      .for("update");
    // A newer staff step, a later claim, or another worker's result won.
    if (
      !row ||
      row.state !== "retrying" ||
      row.action !== claim.action ||
      row.status !== claim.status ||
      row.attempts !== claim.attempt
    )
      return;
    if (outcome === "accepted")
      return markPlatformSynced(tx, tenantId, claim.id);
    const exhausted =
      outcome === "unknown" && claim.attempt >= PLATFORM_SYNC_MAX_ATTEMPTS;
    const final = outcome === "refused" || exhausted;
    await tx
      .update(deliveryChannelOrders)
      .set({
        platformSyncState: final ? "needs_action" : "retrying",
        platformSyncNextAt: final
          ? null
          : new Date(now.getTime() + platformSyncBackoffMs(claim.attempt)),
      })
      .where(
        and(
          eq(deliveryChannelOrders.tenantId, tenantId),
          eq(deliveryChannelOrders.id, claim.id),
        ),
      );
    if (exhausted) await auditExhausted(tx, context, claim, claim.attempt, now);
  });
}

/**
 * Worker sweep (cloud only, run by the relay sweep in worker-main.ts): resends
 * the due `retrying` intents (at most `limit`). Returns the number of platform
 * calls made. One row's failure never stops the others.
 */
export async function retryDeliveryPlatformIntents(
  context: ScopedTenantContext,
  now = new Date(),
  limit = PLATFORM_SYNC_BATCH,
): Promise<number> {
  const startedAt = Date.now();
  const claims = await claimDue(context, now, limit);
  // Together, so a platform that is down costs one timeout, not one per row
  // (the relay loop waits for this sweep). The backoff counts from the real
  // end of the call, not from the start of the run.
  await Promise.all(
    claims.map(async (claim) => {
      const outcome = await callPlatform(context, claim);
      try {
        await settleClaim(
          context,
          claim,
          outcome,
          new Date(now.getTime() + (Date.now() - startedAt)),
        );
      } catch {
        // The lease expires and the row is claimed again.
      }
    }),
  );
  return claims.length;
}
