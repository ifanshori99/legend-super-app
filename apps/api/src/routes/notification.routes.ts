import { Router, type Request, type RequestHandler } from "express";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  getNotificationPolicy,
  getNotificationPreferences,
  getPushPublicKey,
  getUnreadNotificationCount,
  listNotificationTemplates,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  registerPushSubscription,
  removePushSubscription,
  updateNotificationPolicy,
  updateNotificationPreferences,
} from "@starter/shared/notification";
import { HttpError } from "../lib/http-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { getTenantContext } from "../middleware/tenant.ts";

export type NotificationOperation =
  | "list"
  | "unreadCount"
  | "markRead"
  | "markAllRead"
  | "getPreferences"
  | "updatePreferences"
  | "registerPush"
  | "getPushKey"
  | "removePush"
  | "getPolicy"
  | "updatePolicy"
  | "listTemplates";
/** Server-verified request facts a push registration binds to; never client data. */
export type NotificationCaller = {
  /** The login session making the request (Better Auth session id). */
  sessionId: string;
  /** The device named by a valid X-Device-Token, else null. */
  deviceId: string | null;
};
export type NotificationInput = {
  params?: unknown;
  query?: unknown;
  body?: unknown;
  caller?: NotificationCaller;
};
export interface NotificationServicePort {
  execute(
    context: ScopedTenantContext,
    userId: string,
    operation: NotificationOperation,
    input: NotificationInput,
  ): Promise<unknown>;
}
export interface NotificationRoutePorts {
  /** Resolve assignments on the server, never from request data. */
  resolveScope(
    tenant: TenantContext,
    userId: string,
  ): Promise<ScopedTenantContext | null>;
  authorize(
    context: ScopedTenantContext,
    userId: string,
    operation: NotificationOperation,
  ): Promise<boolean>;
  /**
   * Session and device of a push registration. Throws 401 for a device token
   * the registry no longer accepts. Without it a registration is refused.
   */
  resolveCaller?(req: Request): Promise<NotificationCaller>;
  service: NotificationServicePort;
}

// Each route names its operation explicitly: authorization must never depend
// on the order of a shared endpoint list.
const routes = [
  [listNotifications, "list"],
  [getUnreadNotificationCount, "unreadCount"],
  [markNotificationRead, "markRead"],
  [markAllNotificationsRead, "markAllRead"],
  [getNotificationPreferences, "getPreferences"],
  [updateNotificationPreferences, "updatePreferences"],
  [registerPushSubscription, "registerPush"],
  [getPushPublicKey, "getPushKey"],
  [removePushSubscription, "removePush"],
  [getNotificationPolicy, "getPolicy"],
  [updateNotificationPolicy, "updatePolicy"],
  [listNotificationTemplates, "listTemplates"],
] as const satisfies readonly (readonly [unknown, NotificationOperation])[];
const denied = () =>
  new HttpError(403, "FORBIDDEN", "Your account cannot perform this action.");

/** Defaults deny until production tenant membership and scoped RBAC resolvers are wired. */
export function createNotificationRouter(ports?: NotificationRoutePorts) {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin);
  for (const [endpoint, operation] of routes) {
    const handler: RequestHandler = async (req, res) => {
      if (!ports) throw denied();
      let tenant: TenantContext;
      try {
        tenant = getTenantContext(req);
      } catch {
        throw denied();
      }
      const userId = getAuth(req).user.id;
      const context = await ports.resolveScope(tenant, userId);
      if (!context) throw denied();
      assertTrustedScopedContext(context);
      if (
        context.tenant.tenantId !== tenant.tenantId ||
        !(await ports.authorize(context, userId, operation))
      )
        throw denied();
      const input: NotificationInput = {};
      if (operation === "registerPush") {
        if (!ports.resolveCaller) throw denied();
        input.caller = await ports.resolveCaller(req);
      }
      if (endpoint.params) input.params = endpoint.params.parse(req.params);
      if (endpoint.query) input.query = endpoint.query.parse(req.query);
      if (endpoint.body) input.body = endpoint.body.parse(req.body);
      const output = await ports.service.execute(
        context,
        userId,
        operation,
        input,
      );
      if (!endpoint.response) {
        res.status(204).end();
        return;
      }
      res.json(output);
    };
    const path = endpoint.path.slice("/api/notifications".length) || "/";
    const handlers = endpoint.body ? [jsonBody, handler] : [handler];
    switch (endpoint.method) {
      case "GET":
        router.get(path, ...handlers);
        break;
      case "POST":
        router.post(path, ...handlers);
        break;
      case "PUT":
        router.put(path, ...handlers);
        break;
      case "DELETE":
        router.delete(path, ...handlers);
        break;
    }
  }
  return router;
}
