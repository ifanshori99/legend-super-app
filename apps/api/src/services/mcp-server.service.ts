// MCP server core (WS-12 part M, bead legend-xkbt; MCP-01..04): bearer auth
// that re-reads the token row on every request (revocation is immediate, no
// cache), a per-token rate limit, and the MCP `Server` that exposes the AI tool
// catalog. Tool listing and calls go through the invoke layer (AIG-01), which
// does scope, permission, row-cap and audit work. One exit point: every handler
// returns through sealMcpResponse (PII) and throws through guarded/toMcpError
// (redacted message, no `data`), so nothing leaves the server unmasked.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { and, eq, sql } from "drizzle-orm";
import { AiError } from "@starter/shared/ai";
import { tenantIdSchema } from "@starter/shared/core";
import { cafeLegendMetricDefinitions } from "@starter/shared/metrics";
import { db } from "../db/index.ts";
import { mcpClients, mcpTokens } from "../db/schema/ai.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import {
  redactJson,
  redactPii,
  redactToolResultContent,
} from "../lib/ai/pii.ts";
import { env } from "../config/env.ts";
import { createFixedWindowCounter } from "../lib/fixed-window-counter.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import {
  createLocalWindowStore,
  createRedisWindowStore,
  SHARED_STORE_TIMEOUT_MS,
  type SharedWindowResult,
  type SharedWindowStore,
} from "../lib/shared-window-store.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
  type AccessSnapshot,
} from "./permission-resolver.ts";
import {
  invokeAiTool,
  listCallableTools,
  toToolSpecs,
} from "./ai-tool-invoke.service.ts";
import type { AiToolContext } from "./ai-tools/types.ts";
import { isBanActive } from "./ai-action-executors/access.ts";
import { loadMcpSettings, sha256Hex, tenantScopeById } from "./mcp-common.ts";

const LAST_USED_REFRESH_MS = 60_000;

export type McpPrincipal = {
  readonly tokenId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly access: AccessSnapshot;
  readonly rateLimitPerMinute: number;
};

/** Thrown for a missing or unknown bearer: the route adds the OAuth challenge. */
export class McpUnauthorizedError extends HttpError {
  constructor(message = "Sign in with an MCP access token.") {
    super(401, "UNAUTHORIZED", message);
  }
}

/**
 * Resolve a bearer token to the caller. Every call reads the token, client and
 * tenant settings under RLS, so a revoked token, revoked client, expired token,
 * disabled MCP, or removed role stops working on the next request (MCP-02).
 */
export async function authenticateMcpToken(
  header: string | undefined,
): Promise<McpPrincipal> {
  const match = /^bearer\s+(\S+)$/i.exec(header ?? "");
  const raw = match?.[1];
  if (!raw || !/^mcp_[A-Za-z0-9]{20,200}$/.test(raw))
    throw new McpUnauthorizedError();
  const hash = sha256Hex(raw);
  const resolved = await db.execute<{ id: string; tenant_id: string }>(
    sql`SELECT id, tenant_id FROM app.mcp_resolve_token(${hash})`,
  );
  const hit = resolved.rows[0];
  if (!hit) throw new McpUnauthorizedError();
  const tenantId = tenantIdSchema.parse(hit.tenant_id);
  const context = tenantScopeById(tenantId);

  const row = await withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select({
        token: mcpTokens,
        clientStatus: mcpClients.status,
        userId: user.id,
        userBanned: user.banned,
        userBanExpires: user.banExpires,
      })
      .from(mcpTokens)
      .innerJoin(
        mcpClients,
        and(
          eq(mcpClients.tenantId, mcpTokens.tenantId),
          eq(mcpClients.id, mcpTokens.mcpClientId),
        ),
      )
      // Left join: a deleted user must read as revoked, not as "no token".
      .leftJoin(user, eq(user.id, mcpTokens.userId))
      .where(and(eq(mcpTokens.tenantId, tenantId), eq(mcpTokens.id, hit.id)))
      .limit(1);
    if (
      found &&
      (!found.token.lastUsedAt ||
        Date.now() - found.token.lastUsedAt.getTime() > LAST_USED_REFRESH_MS)
    )
      await tx
        .update(mcpTokens)
        .set({ lastUsedAt: sql`now()` })
        .where(and(eq(mcpTokens.tenantId, tenantId), eq(mcpTokens.id, hit.id)));
    return found;
  });
  if (!row) throw new McpUnauthorizedError();
  const { token } = row;
  if (row.clientStatus !== "approved")
    throw new AiError("MCP_CLIENT_NOT_APPROVED");
  if (token.revokedAt) throw new AiError("MCP_TOKEN_REVOKED");
  // A deleted or banned user keeps no MCP access.
  if (!row.userId || isBanActive(row.userBanned, row.userBanExpires))
    throw new AiError("MCP_TOKEN_REVOKED");
  if (token.expiresAt.getTime() <= Date.now())
    throw new AiError("MCP_TOKEN_EXPIRED");

  const settings = await loadMcpSettings(tenantId);
  if (settings.platformLocked) throw new AiError("AI_PLATFORM_DISABLED");
  if (!settings.aiEnabled) throw new AiError("AI_FEATURE_DISABLED");
  if (!settings.mcpEnabled)
    throw new AiError(
      "AI_FEATURE_DISABLED",
      "MCP sedang dimatikan oleh admin.",
    );

  // Fresh access every request: a removed role drops the data at once.
  const data = await loadTenantAccess(context, token.userId);
  const access = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: token.userId,
    ...data,
    mfaVerified: false,
    now: new Date(),
  });
  if (!access.permissions.includes("ai.ask"))
    throw new AiError("AI_TOOL_FORBIDDEN");
  return {
    tokenId: token.id,
    clientId: token.mcpClientId,
    scopes: token.scopes,
    access,
    rateLimitPerMinute: settings.mcpRateLimitPerMinute,
  };
}

// ---- Per-token rate limit (fixed window; Redis-shared, fail closed) ---------

const WINDOW_MS = 60_000;
const LOCAL_CAPACITY = 5_000;
const MCP_BUCKET = "mcp";

const localStore = () =>
  createLocalWindowStore((limit, windowMs) =>
    createFixedWindowCounter({ limit, windowMs, capacity: LOCAL_CAPACITY }),
  );
let local = localStore();
let redisStore: SharedWindowStore | undefined;

/**
 * The store the budget counts in. With REDIS_URL every API instance shares one
 * window; without it (dev, test, single VM) the window stays in process.
 */
function resolveMcpStore(): { store: SharedWindowStore; shared: boolean } {
  if (!env.REDIS_URL) return { store: local, shared: false };
  redisStore ??= createRedisWindowStore(env.REDIS_URL);
  return { store: redisStore, shared: true };
}

/**
 * Throws `MCP_RATE_LIMITED` when the token passed its per-minute budget. With a
 * shared (Redis) store the limit fails CLOSED: a Redis error or a stall past
 * `SHARED_STORE_TIMEOUT_MS` refuses the call instead of counting locally, so an
 * outage never loosens the budget. `options.store` is a test seam.
 */
export async function enforceMcpRateLimit(
  tokenId: string,
  limitPerMinute: number,
  options: { store?: SharedWindowStore } = {},
): Promise<void> {
  const resolved = options.store
    ? { store: options.store, shared: true }
    : resolveMcpStore();
  let timer: NodeJS.Timeout | undefined;
  let result: SharedWindowResult;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("mcp rate limit store timed out")),
        SHARED_STORE_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    result = await Promise.race([
      resolved.store.take(MCP_BUCKET, tokenId, limitPerMinute, WINDOW_MS),
      timeout,
    ]);
  } catch (error) {
    if (!resolved.shared) throw error;
    logger.warn({ err: error }, "mcp rate limit store failed; refusing call");
    throw new AiError("MCP_RATE_LIMITED");
  } finally {
    clearTimeout(timer);
  }
  if (!result.allowed) throw new AiError("MCP_RATE_LIMITED");
}

export function resetMcpRateLimits(): void {
  local = localStore();
}

// ---- MCP server ------------------------------------------------------------

const CATALOG_URI = "legend://tools/catalog";
const GLOSSARY_URI = "legend://metrics/definitions";

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function sealItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item))
    return redactJson(item);
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => [
      key,
      key === "text" && typeof value === "string"
        ? redactToolResultContent(value)
        : redactJson(value),
    ]),
  );
}

/**
 * Single exit for every MCP response (AIG-02): personal data never leaves the
 * server. `content[].text` and `contents[].text` hold JSON text, so they go
 * through redactToolResultContent; `structuredContent` and every other field go
 * through redactJson. Both walk the same rules, so structuredContent stays equal
 * to the redacted JSON in the text. Booleans such as `isError` are untouched.
 */
export function sealMcpResponse<T>(response: T): T {
  if (!response || typeof response !== "object" || Array.isArray(response))
    return redactJson(response) as T;
  return Object.fromEntries(
    Object.entries(response).map(([key, value]) => [
      key,
      (key === "content" || key === "contents") && Array.isArray(value)
        ? value.map(sealItem)
        : redactJson(value),
    ]),
  ) as T;
}

/**
 * Errors leave through one door too. A handler may throw anything (a database
 * error carries row values, a tool error may echo user text), so every error
 * becomes an `McpError` with a redacted message and no `data`. The SDK adds the
 * "MCP error <code>:" prefix itself, so an incoming McpError loses its own.
 */
function toMcpError(error: unknown): McpError {
  if (error instanceof McpError)
    return new McpError(
      error.code,
      redactPii(error.message.replace(/^MCP error -?\d+: /, "")),
    );
  // HttpError messages are static text written by this code base.
  if (error instanceof HttpError)
    return new McpError(ErrorCode.InternalError, redactPii(error.message));
  logger.error({ err: error }, "MCP handler failed");
  return new McpError(ErrorCode.InternalError, "Internal error");
}

/** Wrap a handler so a thrown error is rewritten by `toMcpError`. */
function guarded<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      throw toMcpError(error);
    }
  };
}

/** A fresh stateless `Server` bound to one authenticated principal. */
export function createMcpServer(principal: McpPrincipal): Server {
  const ctx = (): AiToolContext => ({
    access: principal.access,
    channel: "mcp",
    mcpClientId: principal.clientId,
    mcpTokenId: principal.tokenId,
    now: new Date(),
  });
  const scopes = principal.scopes;

  const server = new Server(
    { name: "legend-super-app", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    guarded(async () => {
      const tools = await listCallableTools(ctx(), { scopes });
      const specs = new Map(toToolSpecs(tools).map((s) => [s.name, s]));
      return sealMcpResponse({
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.titleId,
          description: specs.get(tool.name)?.description ?? tool.description,
          inputSchema: {
            type: "object" as const,
            ...(specs.get(tool.name)?.inputSchema ?? {}),
          },
          annotations: {
            readOnlyHint: tool.mcpAnnotations.readOnlyHint,
            destructiveHint: tool.mcpAnnotations.destructiveHint,
            idempotentHint: tool.mcpAnnotations.idempotentHint,
            openWorldHint: tool.mcpAnnotations.openWorldHint,
          },
        })),
      });
    }),
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    guarded(async (request) => {
      const result = await invokeAiTool(
        ctx(),
        request.params.name,
        request.params.arguments ?? {},
        { scopes },
      );
      if (!result.ok)
        return sealMcpResponse({
          isError: true,
          content: [
            {
              type: "text" as const,
              text: jsonText({
                errorCode: result.errorCode,
                message: result.message,
              }),
            },
          ],
        });
      const out = result.output;
      return sealMcpResponse({
        content: [{ type: "text" as const, text: jsonText(out) }],
        ...(out && typeof out === "object" && !Array.isArray(out)
          ? { structuredContent: out as Record<string, unknown> }
          : {}),
      });
    }),
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    guarded(async () =>
      sealMcpResponse({
        resources: [
          {
            uri: CATALOG_URI,
            name: "Katalog alat",
            description: "Alat yang boleh dipakai token ini.",
            mimeType: "application/json",
          },
          {
            uri: GLOSSARY_URI,
            name: "Definisi metrik",
            description: "Kamus metrik baku (kode, nama, satuan, rumus).",
            mimeType: "application/json",
          },
        ],
      }),
    ),
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    guarded(async (request) => {
      const uri = request.params.uri;
      if (uri === CATALOG_URI) {
        const tools = await listCallableTools(ctx(), { scopes });
        return sealMcpResponse({
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: jsonText(
                tools.map((t) => ({
                  name: t.name,
                  code: t.code,
                  kind: t.kind,
                  title: t.titleId,
                  description: t.description,
                  scope: t.scope,
                })),
              ),
            },
          ],
        });
      }
      if (uri === GLOSSARY_URI)
        return sealMcpResponse({
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: jsonText(
                cafeLegendMetricDefinitions.map((m) => ({
                  code: m.code,
                  name: m.name,
                  description: m.description,
                  unit: m.unit,
                })),
              ),
            },
          ],
        });
      throw new HttpError(404, "NOT_FOUND", "Resource tidak ditemukan.");
    }),
  );

  return server;
}
