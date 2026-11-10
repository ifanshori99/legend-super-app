// Edge side of the cloud -> edge Wi-Fi quota forwarding (bead legend-xk7az;
// PRD v1.7 §3 F25, FAC-12/FAC-13). The cloud queues `wifi_quota.updated`
// (edge/wifi-quota-forwarding.ts); this applier pushes the new tier and
// remaining time to the controller through the edge Wi-Fi agent
// (`wifiEnforcement().applySession`, the same call the quota service makes
// when it runs on the edge).
//
// Ordering and replays: the aggregate is classified `master_data` (full state,
// absolute quota), so the link applies only a sequence newer than the last one
// it holds. A replay or an older event is skipped before it reaches this
// function: it can never lower a quota that a newer event raised.
//
// Failure modes:
//   - No live grant for the session: the device is not connected here (or the
//     grant ended). Nothing to push; the guest's own start call applies the
//     current quota when the device connects. The event is still consumed.
//   - Controller or agent not ready (503, timeouts) or a grant still in flight
//     (409 WIFI_GRANT_IN_FLIGHT): not a domain refusal, so the receive
//     transaction rolls back, nothing is acknowledged and the cloud keeps the
//     event queued. The link retries. See `classifyAgentError`.
//   - A final refusal (controller refused, device bound elsewhere, session
//     ending) is recorded by the link as an `applier_refused` conflict and
//     does not stall the queue.
//   - Edge offline: the cloud queue holds the events; the cursor resumes in
//     order when the link is back.
import { and, eq, inArray, sql } from "drizzle-orm";
import { CoreError, type OutletId } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { HttpError } from "../lib/http-error.ts";
import {
  wifiQuotaUpdatedEvent,
  wifiRemainingMinutes,
} from "@starter/shared/facility";
import { wifiDeviceGrants } from "../db/schema/index.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import type { EdgeApplyMeta } from "./ports.ts";
import { wifiEnforcement } from "./wifi/port.ts";

const DAY_SECONDS = 86_400;

/** Pushes one forwarded quota change to the controller. */
export async function applyWifiQuotaUpdated(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const tenantId = meta.context.tenant.tenantId;
  if (meta.direction !== "cloud_to_edge")
    throw new CoreError(
      "FORBIDDEN",
      "wifi_quota.updated only travels cloud to edge",
    );
  if (event.tenantId !== tenantId)
    throw new CoreError("FORBIDDEN", "Event tenant does not match the context");
  if (!event.outletId)
    throw new CoreError("VALIDATION_ERROR", "Event has no outlet");
  const payload = wifiQuotaUpdatedEvent.payloadSchema.parse(event.payload);
  const { sessionId, fullSpeedKbps, baseSpeedKbps, sessionEndsAt } = payload;
  if (
    sessionId === null ||
    fullSpeedKbps === undefined ||
    baseSpeedKbps === undefined ||
    sessionEndsAt === undefined
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Event lacks the session or the speeds the edge needs",
    );
  if (event.aggregateId !== sessionId)
    throw new CoreError("VALIDATION_ERROR", "Event does not match its session");
  const outletId = event.outletId as OutletId;

  const [grant] = await tx
    .select({ controllerDeviceId: wifiDeviceGrants.controllerDeviceId })
    .from(wifiDeviceGrants)
    .where(
      and(
        eq(wifiDeviceGrants.tenantId, tenantId),
        eq(wifiDeviceGrants.outletId, outletId),
        eq(wifiDeviceGrants.wifiSessionId, sessionId),
        inArray(wifiDeviceGrants.status, ["active", "pending", "unknown"]),
      ),
    )
    .orderBy(sql`${wifiDeviceGrants.createdAt} DESC`)
    .limit(1);
  if (!grant?.controllerDeviceId) return;

  const remaining = wifiRemainingMinutes({
    quotaMinutes: payload.quotaMinutes,
    usedMinutes: payload.usedMinutes,
  });
  try {
    await wifiEnforcement().applySession(meta.context, {
      outletId,
      wifiSessionId: sessionId,
      controllerDeviceId: grant.controllerDeviceId,
      speedTier: payload.speedTier,
      fullSpeedKbps,
      baseSpeedKbps,
      remainingSeconds: Math.min(DAY_SECONDS, remaining * 60),
      sessionEndsAt,
    });
  } catch (error) {
    throw classifyAgentError(error);
  }
}

/** Not a domain refusal (no 4xx status): the link rolls back and retries. */
export class WifiQuotaRetryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WifiQuotaRetryError";
  }
}

/**
 * Which agent answers are final and which are "try again" (the link treats a
 * 4xx as a refusal it records and consumes, anything else as a retry):
 *   - 409 WIFI_GRANT_IN_FLIGHT: an earlier grant of the device is still being
 *     confirmed. Transient, so retried; consuming it would lose the quota.
 *   - 502 WIFI_AUTHORIZE_REFUSED: the controller definitively refused. Retrying
 *     would block the whole outlet link forever, so it becomes a recorded
 *     conflict.
 *   - everything else (503 agent not ready, timeouts, database errors) is left
 *     as is: retried. Another 4xx (device bound elsewhere, session ending) is a
 *     final refusal.
 */
function classifyAgentError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  if (error.code === "WIFI_GRANT_IN_FLIGHT")
    return new WifiQuotaRetryError(error.code, error.message);
  if (error.code === "WIFI_AUTHORIZE_REFUSED")
    return new CoreError("CONFLICT", "The Wi-Fi controller refused the change");
  return error;
}

/**
 * Registers `wifi_quota.updated` on the cloud_to_edge dispatcher and
 * classifies its aggregate as full-state master data (receiver side, edge
 * boot; applier-registry.ts). Idempotent.
 */
export function registerWifiQuotaEdgeApplier(): void {
  registerEdgeEventHandler(
    "cloud_to_edge",
    wifiQuotaUpdatedEvent.name,
    applyWifiQuotaUpdated,
  );
  registerEdgeAggregateKind(
    wifiQuotaUpdatedEvent.entry.aggregateType,
    "master_data",
  );
}
