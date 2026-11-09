// MCP client and token administration (WS-12 part M, bead legend-xkbt;
// MCP-02, MCP-05). Routes gate `mcp.client.manage` for client work and the
// tenant-wide token list; a user always sees and revokes their own tokens.
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  AiError,
  type McpClient,
  type McpScope,
  type McpTokenSummary,
  type RegisterMcpClient,
} from "@starter/shared/ai";
import {
  decodeCursor,
  encodeCursor,
  userIdSchema,
  type CursorPage,
  type TenantId,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { mcpClients, mcpTokens } from "../db/schema/ai.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  emitMcpEvent,
  tenantScopeById,
  toMcpClient,
  toMcpTokenSummary,
} from "./mcp-common.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";

const MANAGE = "mcp.client.manage" as const;

const canManage = (access: AccessSnapshot) =>
  access.allows(MANAGE, { type: "tenant" });

function decodeTimeCursor(cursor: string): { at: Date; id: string } {
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Periksa cursor.");
  }
  const [at, id] = keys;
  const date = typeof at === "string" ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime()) || typeof id !== "string")
    throw new HttpError(422, "VALIDATION_ERROR", "Periksa cursor.");
  return { at: date, id };
}

export async function listMcpClients(
  access: AccessSnapshot,
  query: { cursor?: string; limit: number; status?: McpClient["status"] },
): Promise<CursorPage<McpClient>> {
  const tenantId = access.tenant.tenantId;
  return withTenant(db, tenantScopeById(tenantId, "session"), async (tx) => {
    const filters: SQL[] = [eq(mcpClients.tenantId, tenantId)];
    if (query.status) filters.push(eq(mcpClients.status, query.status));
    if (query.cursor) {
      const c = decodeTimeCursor(query.cursor);
      filters.push(
        or(
          lt(mcpClients.createdAt, c.at),
          and(eq(mcpClients.createdAt, c.at), lt(mcpClients.id, c.id)),
        ) as SQL,
      );
    }
    const rows = await tx
      .select()
      .from(mcpClients)
      .where(and(...filters))
      .orderBy(desc(mcpClients.createdAt), desc(mcpClients.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toMcpClient),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** Admin registration: always `pending` until an admin approves (MCP-05). */
export async function registerMcpClient(
  access: AccessSnapshot,
  body: RegisterMcpClient,
): Promise<McpClient> {
  const tenantId = access.tenant.tenantId;
  const context = tenantScopeById(tenantId, "session");
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    const [existing] = await tx
      .select({ id: mcpClients.id })
      .from(mcpClients)
      .where(
        and(
          eq(mcpClients.tenantId, tenantId),
          eq(mcpClients.clientId, body.clientId),
        ),
      )
      .limit(1);
    if (existing)
      throw new HttpError(409, "MCP_CLIENT_EXISTS", "Client ID sudah dipakai.");
    const [row] = await tx
      .insert(mcpClients)
      .values({
        tenantId,
        name: body.name,
        clientId: body.clientId,
        redirectUris: body.redirectUris,
        allowedScopes: body.allowedScopes,
        status: "pending",
        registeredVia: "admin",
      })
      .returning();
    if (!row) throw new Error("mcp client insert returned no row");
    await emitMcpEvent(tx, context, "mcp_client.registered", {
      aggregateId: row.id,
      actor: { type: "user", id: access.userId },
      now,
      payload: {
        mcpClientId: row.id,
        registeredVia: "admin",
        registeredAt: row.createdAt.toISOString(),
      },
    });
    return toMcpClient(row);
  });
}

async function loadClient(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: TenantId,
  id: string,
) {
  const [row] = await tx
    .select()
    .from(mcpClients)
    .where(and(eq(mcpClients.tenantId, tenantId), eq(mcpClients.id, id)))
    .for("update")
    .limit(1);
  if (!row)
    throw new HttpError(
      404,
      "MCP_CLIENT_NOT_FOUND",
      "Klien MCP tidak ditemukan.",
    );
  return row;
}

export async function approveMcpClient(
  access: AccessSnapshot,
  id: string,
  body: { allowedScopes?: McpScope[] },
): Promise<McpClient> {
  const tenantId = access.tenant.tenantId;
  const context = tenantScopeById(tenantId, "session");
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    const row = await loadClient(tx, tenantId, id);
    if (row.status === "revoked")
      throw new HttpError(
        409,
        "MCP_CLIENT_REVOKED",
        "Klien yang sudah dicabut tidak bisa disetujui lagi.",
      );
    if (row.status === "approved") return toMcpClient(row);
    const scopes = body.allowedScopes ?? row.allowedScopes;
    if (scopes.some((s) => !row.allowedScopes.includes(s)))
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Scope yang disetujui harus bagian dari scope yang diminta.",
      );
    const [updated] = await tx
      .update(mcpClients)
      .set({
        status: "approved",
        allowedScopes: scopes,
        approvedBy: userIdSchema.parse(access.userId),
        approvedAt: sql`now()`,
      })
      .where(and(eq(mcpClients.tenantId, tenantId), eq(mcpClients.id, id)))
      .returning();
    if (!updated) throw new Error("mcp client update returned no row");
    await emitMcpEvent(tx, context, "mcp_client.approved", {
      aggregateId: id,
      actor: { type: "user", id: access.userId },
      now,
      payload: {
        mcpClientId: id,
        approvedBy: userIdSchema.parse(access.userId),
        approvedAt: updated.approvedAt!.toISOString(),
      },
    });
    return toMcpClient(updated);
  });
}

/** Revoking a client also revokes every live token of that client. */
export async function revokeMcpClient(
  access: AccessSnapshot,
  id: string,
  body: { reason: string },
): Promise<McpClient> {
  const tenantId = access.tenant.tenantId;
  const context = tenantScopeById(tenantId, "session");
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    const row = await loadClient(tx, tenantId, id);
    if (row.status === "revoked") return toMcpClient(row);
    const [updated] = await tx
      .update(mcpClients)
      .set({
        status: "revoked",
        revokedBy: userIdSchema.parse(access.userId),
        revokedAt: sql`now()`,
        revokeReason: body.reason,
      })
      .where(and(eq(mcpClients.tenantId, tenantId), eq(mcpClients.id, id)))
      .returning();
    if (!updated) throw new Error("mcp client update returned no row");
    const killed = await tx
      .update(mcpTokens)
      .set({ revokedAt: sql`now()`, revokeReason: "Klien MCP dicabut" })
      .where(
        and(
          eq(mcpTokens.tenantId, tenantId),
          eq(mcpTokens.mcpClientId, id),
          isNull(mcpTokens.revokedAt),
        ),
      )
      .returning();
    await emitMcpEvent(tx, context, "mcp_client.revoked", {
      aggregateId: id,
      actor: { type: "user", id: access.userId },
      now,
      payload: {
        mcpClientId: id,
        revokedBy: access.userId,
        revokedAt: updated.revokedAt!.toISOString(),
      },
    });
    for (const token of killed)
      await emitMcpEvent(tx, context, "mcp_token.revoked", {
        aggregateId: token.id,
        actor: { type: "user", id: access.userId },
        now,
        payload: {
          mcpTokenId: token.id,
          mcpClientId: id,
          userId: token.userId,
          revokedBy: access.userId,
          revokedAt: token.revokedAt!.toISOString(),
        },
      });
    return toMcpClient(updated);
  });
}

export async function listMcpTokens(
  access: AccessSnapshot,
  query: {
    cursor?: string;
    limit: number;
    scope?: "mine" | "tenant";
    clientId?: string;
    includeInactive?: boolean;
  },
): Promise<CursorPage<McpTokenSummary>> {
  const tenantId = access.tenant.tenantId;
  const wantsTenant = query.scope === "tenant";
  if (wantsTenant && !canManage(access))
    throw new AiError(
      "AI_TOOL_FORBIDDEN",
      "Daftar token seluruh organisasi memerlukan izin mengelola klien MCP.",
    );
  return withTenant(db, tenantScopeById(tenantId, "session"), async (tx) => {
    const filters: SQL[] = [eq(mcpTokens.tenantId, tenantId)];
    if (!wantsTenant)
      filters.push(eq(mcpTokens.userId, userIdSchema.parse(access.userId)));
    if (query.clientId) filters.push(eq(mcpTokens.mcpClientId, query.clientId));
    if (query.includeInactive === false)
      filters.push(
        isNull(mcpTokens.revokedAt),
        sql`${mcpTokens.expiresAt} > now()`,
      );
    if (query.cursor) {
      const c = decodeTimeCursor(query.cursor);
      filters.push(
        or(
          lt(mcpTokens.createdAt, c.at),
          and(eq(mcpTokens.createdAt, c.at), lt(mcpTokens.id, c.id)),
        ) as SQL,
      );
    }
    const rows = await tx
      .select()
      .from(mcpTokens)
      .where(and(...filters))
      .orderBy(desc(mcpTokens.createdAt), desc(mcpTokens.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const clientIds = [...new Set(page.map((r) => r.mcpClientId))];
    const names = new Map<string, string>();
    if (clientIds.length)
      for (const c of await tx
        .select({ id: mcpClients.id, name: mcpClients.name })
        .from(mcpClients)
        .where(
          and(
            eq(mcpClients.tenantId, tenantId),
            inArray(mcpClients.id, clientIds),
          ),
        ))
        names.set(c.id, c.name);
    const last = page.at(-1);
    return {
      data: page.map((r) => toMcpTokenSummary(r, names.get(r.mcpClientId))),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** Owner or `mcp.client.manage`; anyone else sees a 404. Idempotent. */
export async function revokeMcpToken(
  access: AccessSnapshot,
  id: string,
  body: { reason?: string },
): Promise<McpTokenSummary> {
  const tenantId = access.tenant.tenantId;
  const context = tenantScopeById(tenantId, "session");
  const now = new Date();
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(mcpTokens)
      .where(and(eq(mcpTokens.tenantId, tenantId), eq(mcpTokens.id, id)))
      .for("update")
      .limit(1);
    if (!row || (row.userId !== access.userId && !canManage(access)))
      throw new HttpError(
        404,
        "MCP_TOKEN_NOT_FOUND",
        "Token MCP tidak ditemukan.",
      );
    if (row.revokedAt) return toMcpTokenSummary(row);
    const [updated] = await tx
      .update(mcpTokens)
      .set({ revokedAt: sql`now()`, revokeReason: body.reason ?? null })
      .where(and(eq(mcpTokens.tenantId, tenantId), eq(mcpTokens.id, id)))
      .returning();
    if (!updated) throw new Error("mcp token update returned no row");
    await emitMcpEvent(tx, context, "mcp_token.revoked", {
      aggregateId: id,
      actor: { type: "user", id: access.userId },
      now,
      payload: {
        mcpTokenId: id,
        mcpClientId: row.mcpClientId,
        userId: row.userId,
        revokedBy: access.userId,
        revokedAt: updated.revokedAt!.toISOString(),
      },
    });
    return toMcpTokenSummary(updated);
  });
}
