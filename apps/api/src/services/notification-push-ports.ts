// Production ports of the notification router for web push registration
// (bead legend-ofq4f). Only the push operations are enabled; every other
// notification operation keeps its default-deny answer until its own resolver
// is wired.
//
// - resolveScope: the caller must hold an active role assignment in this
//   tenant (staff member). The context is tenant-wide because a push
//   subscription belongs to the user, not to an outlet; the outlet an alarm
//   push is bound to is checked by the service against the caller's own
//   permission (`facility.emergency.respond`) or the registered device.
// - resolveCaller: the login session and the device named by a valid
//   X-Device-Token (401 when the registry no longer accepts it).
import { isAssignmentActive } from "@starter/shared/access";
import type { TenantContext } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { createPushSubscriptionProtector } from "../lib/push-subscription.ts";
import { currentDeviceIdOf } from "../routes/device-id.ts";
import { getAuth } from "../middleware/auth.ts";
import type {
  NotificationOperation,
  NotificationRoutePorts,
} from "../routes/notification.routes.ts";
import { createNotificationService } from "./notification-center.ts";
import { loadTenantAccess } from "./permission-resolver.ts";

const PUSH_OPERATIONS: ReadonlySet<NotificationOperation> = new Set([
  "registerPush",
  "getPushKey",
  "removePush",
]);

async function authorizePush(
  _context: unknown,
  _userId: string,
  operation: NotificationOperation,
): Promise<boolean> {
  return PUSH_OPERATIONS.has(operation);
}

export function createNotificationPushPorts(): NotificationRoutePorts {
  return {
    async resolveScope(tenant: TenantContext, userId: string) {
      const context = establishScopedTenantContext(tenant, { kind: "tenant" });
      const access = await loadTenantAccess(context, userId);
      const now = new Date();
      return access.assignments.some((assignment) =>
        isAssignmentActive(assignment, now),
      )
        ? context
        : null;
    },
    authorize: authorizePush,
    async resolveCaller(req) {
      return {
        sessionId: getAuth(req).session.id,
        deviceId: await currentDeviceIdOf(req),
      };
    },
    service: createNotificationService(
      db,
      authorizePush,
      createPushSubscriptionProtector(),
    ),
  };
}
