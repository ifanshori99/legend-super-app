// One-shot edge job: re-sends pin sets that predate `payload.material`
// (bead legend-zclb, tier K).
//
// An edge `staff_pin.set` written before the event carried hash material (and
// a cloud row parked at v1) is `not_applicable` on the cloud, so a pin set on
// the edge never reached the cloud and could be lost when the standby takes
// over. For every local pin of this node's outlet whose latest `staff_pin.set`
// outbox event has no material, this appends a new `staff_pin.set` that
// carries the row's hash material.
//
// `material.setAt` is the old event's `occurredAt`: the real moment the pin
// was set. The row's `pin_generation_at` is not used, because a backfill left
// it at the migration time, which would outrank a newer pin set on the cloud.
// The cloud adopts a set only when it is strictly newer than its own
// generation, and an identical material is a no-op there (applyStaffPinSet),
// so re-sending a pin the cloud already holds never resets its lock or
// attempt counter.
//
// `setAt` is capped at the edge clock now. Residual risk (review K): an old
// set stamped while the edge clock ran hours ahead, followed by a cloud reset
// before this job runs, still outranks that reset, because those old events
// never passed the cloud's skew check. The edge cannot tell the real set time
// apart from a skewed one. The other way round, an edge clock behind when the
// job runs lowers `setAt` and can make the cloud refuse a set that really is
// newer than its own pin; the standby then still lacks that pin.
//
// Idempotent: afterwards the latest set event of the aggregate carries
// material, so a rerun emits nothing. Primary and standby may both run it;
// the duplicate is `not_applicable` on the cloud (tie). The edge outbox is
// never pruned by application code (only `edge_outbound_queue` is, by
// pruneAckedEdgeQueue), so the old event stays readable here.
//
// Never log the hash or salt: a failed write is rethrown without the driver
// message (`withoutSecretErrorDetail`), and callers log the error class only.
import {
  STAFF_PIN_HASH_ALGORITHM,
  staffPinSetEvent,
} from "@starter/shared/access/override";
import { outletIdSchema, type TenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { staffPins } from "../db/schema/device-pin.ts";
import { withTenant } from "../db/tenant.ts";
import { STAFF_PIN_PEPPER_VERSION } from "../services/device-pin-pepper.ts";
import {
  appendDevicePinEvent,
  DEVICE_PIN_EVENT_DESTINATION,
  outletContext,
} from "../services/device-pin-support.ts";
import { withoutSecretErrorDetail } from "./envelope-secrets.ts";

export type StaffPinResendResult = { readonly resent: number };

/**
 * Appends one material-carrying `staff_pin.set` per local pin of the outlet
 * whose latest set event has none. One transaction under an advisory lock, so
 * two runs on the same outlet never both read "no material" and double-send,
 * and under the pins' row locks (legend-gauz3): `appendDevicePinEvent` requires
 * the caller to hold the aggregate's row lock, and a concurrent reset must not
 * slip between the read and the append.
 */
export async function resendMateriallessStaffPinSets(
  tenant: TenantContext,
  outletId: string,
  options: { readonly now?: Date } = {},
): Promise<StaffPinResendResult> {
  const now = options.now ?? new Date();
  const context = outletContext(tenant, outletId);
  const tenantId = tenant.tenantId;
  return withoutSecretErrorDetail("Staff pin resend failed", () =>
    withTenant(db, context, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`staff-pin-resend:${tenantId}:${outletId}`}, 0))`,
      );
      const rows = await tx
        .select()
        .from(staffPins)
        .where(
          and(
            eq(staffPins.tenantId, tenantId),
            eq(staffPins.outletId, outletIdSchema.parse(outletId)),
            // Another pepper generation would never verify on the cloud.
            eq(staffPins.pepperVersion, STAFF_PIN_PEPPER_VERSION),
          ),
        )
        .orderBy(asc(staffPins.id))
        // legend-gauz3: the row lock is taken before the material and the
        // latest set event are read, and held until the append. A reset
        // (setStaffPin, which locks one row) then either commits first and
        // is read here, or waits until this event is appended; the old
        // material can never get a sequence above a newer set. Rows are
        // locked in id order and a reset locks only one, so no deadlock.
        .for("update");
      let resent = 0;
      for (const row of rows) {
        const [latest] = await tx
          .select({ event: domainEventOutbox.event })
          .from(domainEventOutbox)
          .where(
            and(
              eq(domainEventOutbox.tenantId, tenantId),
              eq(domainEventOutbox.destination, DEVICE_PIN_EVENT_DESTINATION),
              eq(domainEventOutbox.aggregateType, "staff_pin"),
              eq(domainEventOutbox.aggregateId, row.id),
              sql`${domainEventOutbox.event}->>'name' = ${staffPinSetEvent.name}`,
            ),
          )
          .orderBy(sql`${domainEventOutbox.sequence} desc`)
          .limit(1);
        // No local set event: the row came from the cloud, which has it.
        if (!latest) continue;
        const parsed = staffPinSetEvent.payloadSchema.safeParse(
          latest.event.payload,
        );
        // An unreadable payload is not ours to repair; one bad row must not
        // stop the others.
        if (!parsed.success || parsed.data.material) continue;
        const old = latest.event as EventEnvelope;
        await appendDevicePinEvent(tx, context, staffPinSetEvent, {
          aggregateId: row.id,
          outletId,
          actor: { type: "user", id: parsed.data.setBy },
          deviceId: null,
          now,
          payload: {
            staffPinId: parsed.data.staffPinId,
            userId: parsed.data.userId,
            setBy: parsed.data.setBy,
            self: parsed.data.self,
            material: {
              algorithm: STAFF_PIN_HASH_ALGORITHM,
              salt: row.pinSalt,
              pinHash: row.pinHash,
              params: {
                N: row.kdfN,
                r: row.kdfR,
                p: row.kdfP,
                keyLength: 32 as const,
              },
              pepperVersion: row.pepperVersion,
              // Capped at the edge clock now (review K): an old event
              // stamped by a clock that ran far ahead never passed the
              // cloud's skew check, so it must not carry a key from the
              // future. A skew that was already in the past stays a
              // residual risk (see the job header).
              setAt: new Date(
                Math.min(Date.parse(old.occurredAt), now.getTime()),
              ).toISOString(),
            },
          },
        });
        resent += 1;
      }
      return { resent };
    }),
  );
}
