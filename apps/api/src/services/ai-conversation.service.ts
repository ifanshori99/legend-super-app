// Tanya AI conversations and messages (PRD v1.7 §3 Fitur 38; bead legend-xq8y).
// Owner-only: every query filters by `owner_user_id` = the caller, on top of the
// tenant RLS that `withTenant` installs. Unsaved history expires after 7 days.
// Reading a conversation re-checks tool permission at render time: an answer
// built from a tool the caller can no longer call is hidden, never shown stale.
// The delete removes the rows (messages cascade) and appends
// `ai_conversation.deleted` in the same transaction.

import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  userIdSchema,
  type CursorPage,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  AiError,
  aiConversationSchema,
  aiEvents,
  aiMessageSchema,
  getAiTool,
  type AiConversation,
  type AiFeatureCode,
  type AiMessage,
  type AiMessageSource,
  type AiToolCode,
} from "@starter/shared/ai";
import { db } from "../db/index.ts";
import { aiConversations, aiMessages } from "../db/schema/ai.ts";
import { withTenant } from "../db/tenant.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";
import { appendOutbox } from "./core-outbox.ts";
import { listCallableTools } from "./ai-tool-invoke.service.ts";
import { AI_HIDDEN_ANSWER_MESSAGE } from "./ai-prompts.ts";

/** Unsaved conversations and their messages are kept this long. */
export const AI_CONVERSATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_DESTINATION = "cloud-sync";

type ConversationRow = typeof aiConversations.$inferSelect;
type MessageRow = typeof aiMessages.$inferSelect;

export function toConversation(row: ConversationRow): AiConversation {
  return aiConversationSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    userId: row.ownerUserId,
    feature: row.feature,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  });
}

export function toMessage(row: MessageRow): AiMessage {
  return aiMessageSchema.parse({
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    toolCode: row.toolCode,
    sources: row.sources,
    aiAssisted: row.aiAssisted,
    createdAt: row.createdAt.toISOString(),
  });
}

const ownerOf = (access: AccessSnapshot) => userIdSchema.parse(access.userId);

const notFound = () => new AiError("AI_CONVERSATION_NOT_FOUND");

/** Codes of the tools the caller can call right now (permission + kill switch). */
export async function callableToolCodes(
  access: AccessSnapshot,
  now: Date = new Date(),
): Promise<Set<AiToolCode>> {
  const tools = await listCallableTools({
    access,
    channel: "tanya_ai",
    mcpClientId: null,
    now,
  });
  return new Set(tools.map((tool) => tool.code));
}

/**
 * Render rule: a tool-role row is kept only while its tool is callable; an
 * assistant answer that followed any now-forbidden tool row of the same turn
 * keeps its place but shows a notice and no sources. Pure, so it is unit-tested.
 */
export function renderMessagesForCaller(
  rows: readonly MessageRow[],
  callable: ReadonlySet<AiToolCode>,
): AiMessage[] {
  const out: AiMessage[] = [];
  let turnForbidden = false;
  for (const row of rows) {
    if (row.role === "user") {
      turnForbidden = false;
      out.push(toMessage(row));
    } else if (row.role === "tool") {
      const allowed =
        row.toolCode !== null && callable.has(row.toolCode as AiToolCode);
      if (!allowed) turnForbidden = true;
      else out.push(toMessage(row));
    } else {
      const message = toMessage(row);
      out.push(
        turnForbidden
          ? { ...message, content: AI_HIDDEN_ANSWER_MESSAGE, sources: [] }
          : message,
      );
    }
  }
  return out;
}

const notExpired = (now: Date) =>
  or(isNull(aiConversations.expiresAt), gt(aiConversations.expiresAt, now))!;

export async function createConversation(
  access: AccessSnapshot,
  context: ScopedTenantContext,
  input: { feature: AiFeatureCode; title?: string | undefined },
  now: Date = new Date(),
): Promise<AiConversation> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .insert(aiConversations)
      .values({
        tenantId: context.tenant.tenantId,
        ownerUserId: ownerOf(access),
        feature: input.feature,
        title: input.title ?? "Percakapan baru",
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + AI_CONVERSATION_RETENTION_MS),
      })
      .returning();
    return toConversation(row!);
  });
}

export async function listConversations(
  access: AccessSnapshot,
  context: ScopedTenantContext,
  query: {
    cursor?: string | undefined;
    limit: number;
    feature?: AiFeatureCode | undefined;
  },
  now: Date = new Date(),
): Promise<CursorPage<AiConversation>> {
  return withTenant(db, context, async (tx) => {
    const filters = [
      eq(aiConversations.tenantId, context.tenant.tenantId),
      eq(aiConversations.ownerUserId, ownerOf(access)),
      notExpired(now),
    ];
    if (query.feature) filters.push(eq(aiConversations.feature, query.feature));
    if (query.cursor) {
      const [updatedAt, id] = decodeCursor(query.cursor);
      const at = typeof updatedAt === "string" ? new Date(updatedAt) : null;
      if (!at || Number.isNaN(at.getTime()) || typeof id !== "string")
        throw notFound();
      filters.push(
        or(
          lt(aiConversations.updatedAt, at),
          and(eq(aiConversations.updatedAt, at), lt(aiConversations.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(aiConversations)
      .where(and(...filters))
      .orderBy(desc(aiConversations.updatedAt), desc(aiConversations.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toConversation),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.updatedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

async function loadOwned(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  context: ScopedTenantContext,
  access: AccessSnapshot,
  conversationId: string,
  now: Date,
) {
  const [conversation] = await tx
    .select()
    .from(aiConversations)
    .where(
      and(
        eq(aiConversations.tenantId, context.tenant.tenantId),
        eq(aiConversations.id, conversationId),
        eq(aiConversations.ownerUserId, ownerOf(access)),
        notExpired(now),
      ),
    );
  if (!conversation) throw notFound();
  const messages = await tx
    .select()
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.tenantId, context.tenant.tenantId),
        eq(aiMessages.conversationId, conversation.id),
      ),
    )
    .orderBy(aiMessages.createdAt, aiMessages.id)
    .limit(500);
  return { conversation, messages };
}

/** Detail for the owner; tool permission is re-checked on every render. */
export async function getConversationDetail(
  access: AccessSnapshot,
  context: ScopedTenantContext,
  conversationId: string,
  now: Date = new Date(),
): Promise<{ conversation: AiConversation; messages: AiMessage[] }> {
  const callable = await callableToolCodes(access, now);
  // TL-09 payslip amounts are bound to the login session that typed the PIN
  // (legend-3e1ut). A stored answer would show them to every other session of
  // the same user (and `defaultLoadHistory` would feed them back to the model),
  // so a replayed TL-09 answer is always hidden.
  callable.delete("TL-09");
  return withTenant(db, context, async (tx) => {
    const { conversation, messages } = await loadOwned(
      tx,
      context,
      access,
      conversationId,
      now,
    );
    return {
      conversation: toConversation(conversation),
      messages: renderMessagesForCaller(messages, callable),
    };
  });
}

export type PersistedTurn = {
  conversation: AiConversation;
  userMessage: AiMessage;
  assistantMessage: AiMessage;
};

/**
 * One answered question: creates the conversation when `conversationId` is
 * null, then stores the user message, one tool-role row per tool the answer
 * used (code + sources, no data) and the assistant message, in one transaction.
 * Timestamps are explicit and increasing so the order survives a single `now()`.
 */
export async function persistTurn(
  access: AccessSnapshot,
  context: ScopedTenantContext,
  input: {
    conversationId: string | null;
    feature: AiFeatureCode;
    title: string;
    question: string;
    answer: string;
    answerSources: readonly AiMessageSource[];
    tools: readonly {
      toolCode: AiToolCode;
      text: string;
      sources: readonly AiMessageSource[];
    }[];
  },
  now: Date = new Date(),
): Promise<PersistedTurn> {
  return withTenant(db, context, async (tx) => {
    let conversationRow: ConversationRow;
    const expiresAt = new Date(now.getTime() + AI_CONVERSATION_RETENTION_MS);
    if (input.conversationId) {
      const owned = await loadOwned(
        tx,
        context,
        access,
        input.conversationId,
        now,
      );
      const [updated] = await tx
        .update(aiConversations)
        .set({ updatedAt: now, expiresAt })
        .where(eq(aiConversations.id, owned.conversation.id))
        .returning();
      conversationRow = updated!;
    } else {
      const [created] = await tx
        .insert(aiConversations)
        .values({
          tenantId: context.tenant.tenantId,
          ownerUserId: ownerOf(access),
          feature: input.feature,
          title: input.title,
          createdAt: now,
          updatedAt: now,
          expiresAt,
        })
        .returning();
      conversationRow = created!;
    }
    const base = {
      tenantId: context.tenant.tenantId,
      conversationId: conversationRow.id,
    };
    let tick = 0;
    const at = () => {
      const stamp = new Date(now.getTime() + tick++);
      return {
        createdAt: stamp,
        expiresAt: new Date(stamp.getTime() + AI_CONVERSATION_RETENTION_MS),
      };
    };
    const [userRow] = await tx
      .insert(aiMessages)
      .values({
        ...base,
        role: "user",
        content: input.question,
        sources: [],
        aiAssisted: false,
        ...at(),
      })
      .returning();
    for (const tool of input.tools)
      await tx.insert(aiMessages).values({
        ...base,
        role: "tool",
        content: tool.text,
        toolCode: tool.toolCode,
        sources: [...tool.sources],
        aiAssisted: false,
        ...at(),
      });
    const [assistantRow] = await tx
      .insert(aiMessages)
      .values({
        ...base,
        role: "assistant",
        content: input.answer,
        sources: [...input.answerSources],
        aiAssisted: true,
        ...at(),
      })
      .returning();
    return {
      conversation: toConversation(conversationRow),
      userMessage: toMessage(userRow!),
      assistantMessage: toMessage(assistantRow!),
    };
  });
}

/**
 * Owner deletes the conversation: rows removed (messages cascade) and
 * `ai_conversation.deleted` appended in the same transaction. The event is
 * tenant-wide; a caller reaching only some outlets carries one of their own
 * outlets so the outbox scope check passes (the payload has no outlet data).
 */
export async function deleteConversation(
  access: AccessSnapshot,
  context: ScopedTenantContext,
  conversationId: string,
  now: Date = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const deleted = await tx
      .delete(aiConversations)
      .where(
        and(
          eq(aiConversations.tenantId, context.tenant.tenantId),
          eq(aiConversations.id, conversationId),
          eq(aiConversations.ownerUserId, ownerOf(access)),
        ),
      )
      .returning({ id: aiConversations.id });
    if (deleted.length === 0) throw notFound();
    const event = aiEvents["ai_conversation.deleted"];
    const outletId =
      context.outletScope.kind === "tenant"
        ? null
        : (context.outletScope.outletIds[0] ?? null);
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      destination: EVENT_DESTINATION,
      direction: null,
      peerId: null,
      event: event.envelopeSchema.parse({
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId,
        name: event.name,
        version: event.version,
        aggregateType: event.entry.aggregateType,
        aggregateId: conversationId,
        sequence: 1,
        occurredAt: now.toISOString(),
        actor: { type: "user", id: ownerOf(access) },
        deviceId: null,
        idempotencyKey: `${event.name}:${conversationId}:1`,
        payloadSchemaRef: event.payloadSchemaRef,
        payload: {
          conversationId,
          userId: ownerOf(access),
          deletedAt: now.toISOString(),
        },
      }),
    });
  });
}

/**
 * Tools whose rows depend on WHO asks, not only on the permission set (own
 * shifts, own payslip, own profit share, own action requests). Their answers
 * are never shared through the response cache.
 */
const PER_USER_TOOLS: ReadonlySet<AiToolCode> = new Set([
  "TL-08",
  "TL-09",
  "TL-12",
  "TL-19",
]);

/** True when the tool's data is the same for every caller with the same permissions. */
export function isSharedTool(code: AiToolCode): boolean {
  const tool = getAiTool(code);
  if (!tool || PER_USER_TOOLS.has(code)) return false;
  return !tool.requiredPermissions.some(
    (permission) =>
      permission.startsWith("self.") || permission.includes(".own."),
  );
}
