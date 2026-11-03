// Operator outbox replay (bead legend-m119; PRD v1.7 §3 outbox, §5 Worker).
// Wraps core-outbox `replayOutbox`: maps its typed refusals to HttpError and
// writes the audit row in the same tenant transaction as the replay, so a
// failed audit rolls the replay back (fail closed).

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import type * as schema from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./audit-writer.ts";
import { OutboxReplayError, replayOutbox } from "./core-outbox.ts";

type Database = NodePgDatabase<typeof schema>;

/**
 * Permission code the replay route checks. It must exist in the shared
 * permission catalog (packages/shared/src/access/permissions.ts); until it is
 * registered every check fails closed (no role can hold an unknown code).
 */
export const OUTBOX_REPLAY_PERMISSION = "ops.outbox.replay";

export type OperatorReplayInput = {
  /** ULID of the outbox row (the API path parameter). */
  outboxId: string;
  /** Verified session user; never taken from the request body. */
  actorUserId: string;
  reason: string;
  /** Permission + outlet-scope decision for the event's own outlet. */
  canReplay: (event: EventEnvelope) => boolean | Promise<boolean>;
};

const refusal: Record<
  OutboxReplayError["kind"],
  { status: number; code: string; message: string }
> = {
  invalid: {
    status: 400,
    code: "VALIDATION_ERROR",
    message: "Replay requires a reason of 1 to 1000 characters.",
  },
  not_found: {
    status: 404,
    code: "NOT_FOUND",
    message: "Outbox event not found.",
  },
  denied: {
    status: 403,
    code: "FORBIDDEN",
    message: "Your account cannot replay this event.",
  },
  not_dead: {
    status: 409,
    code: "CONFLICT",
    message: "Only dead-lettered events can be replayed.",
  },
};

export async function replayOutboxAsOperator(
  database: Database,
  context: ScopedTenantContext,
  input: OperatorReplayInput,
): Promise<{ outboxId: string; generation: number }> {
  try {
    const generation = await replayOutbox(database, context, {
      outboxId: input.outboxId,
      actor: { type: "user", id: input.actorUserId },
      reason: input.reason,
      authorize: async (event) => Boolean(await input.canReplay(event)),
      onReplayed: async (tx, { event, generation: next }) => {
        await recordAudit(
          {
            tenantId: context.tenant.tenantId,
            outletId: event.outletId,
            actorType: "user",
            actorId: input.actorUserId,
            deviceId: null,
            action: "outbox.replayed",
            objectType: "outbox_event",
            objectId: input.outboxId,
            reason: input.reason.trim(),
            before: { dispatchState: "dead" },
            after: { dispatchState: "ready", generation: next },
            sensitiveAccess: false,
          },
          { tx, context },
        );
      },
    });
    return { outboxId: input.outboxId, generation };
  } catch (error) {
    if (error instanceof OutboxReplayError) {
      const mapped = refusal[error.kind];
      throw new HttpError(mapped.status, mapped.code, mapped.message);
    }
    throw error;
  }
}
