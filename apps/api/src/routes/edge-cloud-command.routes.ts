// Edge -> cloud commands (card F1, brief 1269). Cloud only, mounted at
// /api/edge-sync/commands. Thin route; every rule is in
// services/edge-cloud-command.service.ts.
//
//   POST /                  body = the frozen command, read as raw bytes
//   POST /:commandId/status body = { kind, bodySha256 }; an unknown id is
//                           tombstoned and answers `absent`
//
// Edge node only: `Authorization: Bearer <edge credential>`, no session, no
// cookie. Tenant, outlet and node come from the verified credential; a tenant
// resolved from the domain must be the same one. `X-Edge-Instance` names the
// calling edge database and must be the one the cloud link follows. Rate
// limited before the credential check (as edge-selfie-receive.routes.ts), and
// the credential is checked before the body is read.
import { createHash } from "node:crypto";
import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { CoreError, isoDateTimeSchema, uuidSchema } from "@starter/shared/core";
import {
  EDGE_COMMAND_CLOCK_HEADER,
  EDGE_COMMAND_INSTANCE_HEADER,
  EDGE_COMMAND_MAX_BYTES,
  edgeCommandParamsSchema,
  edgeCommandStatusRequestSchema,
} from "@starter/shared/edge";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema";
import { parseEdgeCredential } from "../edge/credential.ts";
import { HttpError } from "../lib/http-error.ts";
import { jsonBody } from "../middleware/body.ts";
import {
  createFixedWindowCounter,
  PUBLIC_RATE_LIMIT_CAPACITY,
  PUBLIC_RATE_LIMIT_MESSAGE,
  PUBLIC_RATE_LIMIT_WINDOW_MS,
} from "../middleware/public-rate-limit.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import {
  executeEdgeCommand,
  settleEdgeCommandStatus,
  type EdgeCommandHandlers,
} from "../services/edge-cloud-command.service.ts";
import {
  edgeCredentialFromAuthorization,
  verifyEdgeCredential,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

/** Requests per client IP per window; several outlets may share one IP. */
export const EDGE_COMMAND_PER_IP = 600;
/** Requests per presented edge credential per window. */
export const EDGE_COMMAND_PER_NODE = 240;

export type EdgeCloudCommandRouterOptions = {
  database: NodePgDatabase<typeof schema>;
  /** Default: the kinds this cloud serves. */
  handlers?: EdgeCommandHandlers;
};

function edgeCommandRateLimit(): RequestHandler {
  const counter = (limit: number) =>
    createFixedWindowCounter({
      limit,
      windowMs: PUBLIC_RATE_LIMIT_WINDOW_MS,
      capacity: PUBLIC_RATE_LIMIT_CAPACITY,
    });
  const perIp = counter(EDGE_COMMAND_PER_IP);
  const perNode = counter(EDGE_COMMAND_PER_NODE);
  return (req, res, next) => {
    const now = Date.now();
    const ipRetry = perIp.take(
      `ip:${req.ip || req.socket.remoteAddress || "unknown"}`,
      now,
    );
    const bearer = edgeCredentialFromAuthorization(req.get("Authorization"));
    const nodeRetry =
      typeof bearer === "string" && parseEdgeCredential(bearer)
        ? perNode.take(
            `credential:${createHash("sha256").update(bearer).digest("base64url")}`,
            now,
          )
        : null;
    const retryAfter = ipRetry ?? nodeRetry;
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("Cache-Control", "no-store");
      throw new HttpError(429, "RATE_LIMITED", PUBLIC_RATE_LIMIT_MESSAGE);
    }
    next();
  };
}

type EdgeCaller = { node: VerifiedEdgeNode; edgeInstanceId: string };
const callers = new WeakMap<Request, EdgeCaller>();

async function authenticateEdgeNode(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const node = await verifyEdgeCredential(
    edgeCredentialFromAuthorization(req.get("Authorization")),
  );
  if (node === null)
    throw new CoreError("UNAUTHORIZED", "Kredensial edge node tidak valid.");
  const resolved = findTenantContext(req);
  if (
    resolved !== undefined &&
    resolved.tenantId.toLowerCase() !== node.tenantId.toLowerCase()
  )
    throw new HttpError(
      403,
      "TENANT_MISMATCH",
      "Tenant does not match this domain.",
    );
  const instance = uuidSchema.safeParse(req.get(EDGE_COMMAND_INSTANCE_HEADER));
  if (!instance.success)
    throw new HttpError(
      403,
      "EDGE_INSTANCE_MISMATCH",
      "Database edge ini bukan yang terhubung ke cloud.",
    );
  callers.set(req, { node, edgeInstanceId: instance.data });
  res.setHeader("Cache-Control", "private, no-store");
  next();
}

function callerOf(req: Request): EdgeCaller {
  const caller = callers.get(req);
  if (!caller)
    throw new CoreError("UNAUTHORIZED", "Kredensial edge node tidak valid.");
  return caller;
}

export function createEdgeCloudCommandRouter(
  options: EdgeCloudCommandRouterOptions,
): Router {
  const router = Router();
  router.use(edgeCommandRateLimit());
  router.post(
    "/",
    authenticateEdgeNode,
    // The raw bytes are part of the command key, so nothing parses them first.
    express.raw({ type: () => true, limit: EDGE_COMMAND_MAX_BYTES }),
    async (req, res) => {
      const { node, edgeInstanceId } = callerOf(req);
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const clock = isoDateTimeSchema.safeParse(
        req.get(EDGE_COMMAND_CLOCK_HEADER),
      );
      res.json({
        data: await executeEdgeCommand(
          options.database,
          node,
          {
            edgeInstanceId,
            bytes,
            ...(clock.success ? { edgeTime: new Date(clock.data) } : {}),
          },
          options.handlers,
        ),
      });
    },
  );
  router.post(
    "/:commandId/status",
    authenticateEdgeNode,
    jsonBody,
    async (req, res) => {
      const { node, edgeInstanceId } = callerOf(req);
      const { commandId } = edgeCommandParamsSchema.parse(req.params);
      const request = edgeCommandStatusRequestSchema.parse(req.body);
      res.json({
        data: await settleEdgeCommandStatus(options.database, node, {
          edgeInstanceId,
          commandId,
          request,
        }),
      });
    },
  );
  return router;
}

export const edgeCloudCommandRouter = createEdgeCloudCommandRouter({
  database: db,
});
