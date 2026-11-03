// Operator outbox replay route (bead legend-m119; PRD v1.7 §3 outbox, §5
// Worker). Mounted by the app at /api/ops. The tenant comes from the resolved
// session/domain (TEN-02), the actor from the verified session, and the
// permission + outlet scope from stored role assignments (TEN-03).

import { Router, type Request, type RequestHandler } from "express";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import { ulidSchema, z, type ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  loadRequestAccess,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  OUTBOX_REPLAY_PERMISSION,
  replayOutboxAsOperator,
} from "../services/ops-outbox.service.ts";

export const replayBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(1000),
});
const paramsSchema = z.strictObject({ outboxId: ulidSchema });

export type OpsOutboxPorts = {
  /** Runs before the handler: auth, origin, tenant, permission gate. */
  guards: RequestHandler[];
  /** Scoped context and per-event decision for the verified caller. */
  resolve(req: Request): {
    context: ScopedTenantContext;
    userId: string;
    canReplay(event: EventEnvelope): boolean | Promise<boolean>;
  };
  replay: typeof replayOutboxAsOperator;
};

const permission = OUTBOX_REPLAY_PERMISSION as PermissionCode;
const gate = requireMenuPermission(permission);
const denied = () =>
  new HttpError(403, "FORBIDDEN", "Your account cannot replay events.");

const defaultPorts: OpsOutboxPorts = {
  guards: [
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
    // requireMenuPermission mints the caller's reachable scope; its message is
    // menu-specific, so refuse with this route's own wording.
    async (req, res, next) => {
      try {
        await gate(req, res, next);
      } catch (error) {
        if (error instanceof AccessError) throw denied();
        throw error;
      }
    },
  ],
  resolve(req) {
    const context = getScopedTenantContext(req);
    return {
      context,
      userId: getAuth(req).user.id,
      // Re-check against the event's own outlet (or tenant for tenant-wide
      // events): the scope-level gate alone is not enough.
      canReplay: async (event) =>
        (await loadRequestAccess(req)).contextFor(
          permission,
          event.outletId
            ? { type: "outlet", id: event.outletId }
            : { type: "tenant" },
        ) !== null,
    };
  },
  replay: replayOutboxAsOperator,
};

export function createOpsOutboxRouter(ports: OpsOutboxPorts = defaultPorts) {
  const router = Router();
  router.post(
    "/outbox/:outboxId/replay",
    ...ports.guards,
    jsonBody,
    async (req, res) => {
      const { outboxId } = paramsSchema.parse(req.params);
      const { reason } = replayBodySchema.parse(req.body);
      const { context, userId, canReplay } = ports.resolve(req);
      const result = await ports.replay(db, context, {
        outboxId,
        actorUserId: userId,
        reason,
        canReplay,
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data: result });
    },
  );
  return router;
}

export const opsOutboxRouter = createOpsOutboxRouter();
