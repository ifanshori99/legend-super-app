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
//   X-Device-Token (401 when the registry no longer accepts it), and whether the
//   session is used on an active shared device (restricts push removal).
import { isAssignmentActive } from "@starter/shared/access";
import type { TenantContext } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { createPushSubscriptionProtector } from "../lib/push-subscription.ts";
import {
  currentDeviceIdOf,
  deviceTokenIssuedAtOf,
} from "../routes/device-id.ts";
import { getAuth } from "../middleware/auth.ts";
import type {
  NotificationOperation,
  NotificationRoutePorts,
} from "../routes/notification.routes.ts";
import { anySharedDeviceActive } from "./shared-device.service.ts";
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
      const { session } = getAuth(req);
      const deviceId = await currentDeviceIdOf(req);
      // Restrict by default (legend 1024): a session that ever carried a mark
      // stays a shared-device session even when the mark lapsed, and so does one
      // whose verified device on this very request is an active shared device
      // (the auth guard may have stamped the mark after the session loaded).
      const sharedDevice =
        (session.sharedDeviceIds?.length ?? 0) > 0 ||
        (deviceId !== null && (await anySharedDeviceActive([deviceId])));
      return {
        sessionId: session.id,
        deviceId,
        deviceTokenIssuedAt: deviceTokenIssuedAtOf(req),
        sharedDevice,
      };
    },
    service: createNotificationService(
      db,
      authorizePush,
      createPushSubscriptionProtector(),
    ),
  };
}
