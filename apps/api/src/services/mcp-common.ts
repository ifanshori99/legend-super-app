// Shared pieces of the MCP server services (WS-12 part M, bead legend-xkbt):
// secret hashing, the tenant contexts used before and after bearer auth, the
// event writer, and row mappers. PRD v1.7 §3 Fitur 39 (MCP-01..05).
import { createHash } from "node:crypto";
import {
  aiEvents,
  type AiEventName,
  type McpClient,
  type McpScope,
  type McpTokenSummary,
} from "@starter/shared/ai";
import { createUlid, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventActor } from "@starter/shared/events";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  aiSettings,
  type mcpClients,
  type mcpTokens,
} from "../db/schema/ai.ts";
import { withTenant } from "../db/tenant.ts";
import { isAiPlatformLocked } from "./ai-platform-lock.ts";
import { appendOutbox } from "./core-outbox.ts";

const EVENT_DESTINATION = "cloud-sync";

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Tenant-wide scoped context for a tenant id that a credential resolved. */
export function tenantScopeById(
  tenantId: string,
  source: "mcp_token" | "domain" | "session" = "mcp_token",
) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "tenant" },
  );
}

export type McpTenantSettings = {
  /** Tenant AI master switch (`ai_settings.ai_enabled`). */
  readonly aiEnabled: boolean;
  readonly mcpEnabled: boolean;
  readonly dynamicClientRegistrationEnabled: boolean;
  readonly mcpRateLimitPerMinute: number;
  /** Platform turned `ai_assistant` off for this tenant: AI and MCP closed. */
  readonly platformLocked: boolean;
};

/** No settings row means MCP off (fail closed) and the default 60/min. */
export async function loadMcpSettings(
  tenantIdRaw: string,
): Promise<McpTenantSettings> {
  const tenantId = tenantIdSchema.parse(tenantIdRaw);
  const { row, platformLocked } = await withTenant(
    db,
    tenantScopeById(tenantId),
    async (tx) => {
      const [found] = await tx
        .select({
          aiEnabled: aiSettings.aiEnabled,
          mcpEnabled: aiSettings.mcpEnabled,
          dynamic: aiSettings.dynamicClientRegistrationEnabled,
          rate: aiSettings.mcpRateLimitPerMinute,
        })
        .from(aiSettings)
        .where(eq(aiSettings.tenantId, tenantId))
        .limit(1);
      return {
        row: found,
        platformLocked: await isAiPlatformLocked(tx, tenantId),
      };
    },
  );
  // Locked: force every switch off so bearer, OAuth and registration all close.
  return {
    aiEnabled: platformLocked ? false : (row?.aiEnabled ?? true),
    mcpEnabled: platformLocked ? false : (row?.mcpEnabled ?? false),
    dynamicClientRegistrationEnabled: platformLocked
      ? false
      : (row?.dynamic ?? false),
    mcpRateLimitPerMinute: row?.rate ?? 60,
    platformLocked,
  };
}

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** Append one MCP event on the caller's transaction. Payloads never hold tokens. */
export async function emitMcpEvent(
  tx: Tx,
  context: ReturnType<typeof tenantScopeById>,
  name: Extract<
    AiEventName,
    | "mcp_client.registered"
    | "mcp_client.approved"
    | "mcp_client.revoked"
    | "mcp_token.issued"
    | "mcp_token.revoked"
  >,
  input: {
    aggregateId: string;
    actor: EventActor;
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  const definition = aiEvents[name];
  // One aggregate (a client, a token) carries several events: next sequence.
  const next = await tx.execute<{ next: number }>(sql`
    SELECT COALESCE(MAX(sequence), 0)::int + 1 AS next
      FROM domain_event_outbox
     WHERE tenant_id = ${context.tenant.tenantId}
       AND aggregate_type = ${definition.entry.aggregateType}
       AND aggregate_id = ${input.aggregateId}`);
  const sequence = next.rows[0]?.next ?? 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: null,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor: input.actor,
    deviceId: null,
    idempotencyKey: `${definition.name}:${input.aggregateId}:${sequence}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

export function toMcpClient(row: typeof mcpClients.$inferSelect): McpClient {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    clientId: row.clientId,
    redirectUris: row.redirectUris,
    allowedScopes: row.allowedScopes as McpScope[],
    status: row.status as McpClient["status"],
    registeredVia: row.registeredVia as McpClient["registeredVia"],
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  } as McpClient;
}

export function toMcpTokenSummary(
  row: typeof mcpTokens.$inferSelect,
  clientName?: string,
): McpTokenSummary {
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.mcpClientId,
    userId: row.userId,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes as McpScope[],
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(clientName ? { clientName } : {}),
  } as McpTokenSummary;
}
