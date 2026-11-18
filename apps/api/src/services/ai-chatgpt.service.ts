// Tenant-owned Codex device login. Every external call happens outside the DB
// transaction; generation + operation claims fence stale starts/polls/refreshes.
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  AiError,
  startChatgptConnectionInputSchema,
  type ChatgptConnectionView,
  type ChatgptDeviceAttempt,
  type ChatgptLoginState,
  type StartChatgptConnectionInput,
} from "@starter/shared/ai";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { aiChatgptConnections } from "../db/schema/ai-chatgpt.ts";
import { withTenant } from "../db/tenant.ts";
import {
  ChatgptCodexError,
  startChatgptDevice,
  pollChatgptDevice,
  refreshChatgptToken,
  revokeChatgptToken,
  type ChatgptTokenBundle,
} from "../lib/ai/chatgpt-codex.ts";
import { HttpError } from "../lib/http-error.ts";
import { openSecret, sealSecret, sealedVersion } from "../lib/secrets.ts";
import { recordAudit, type AuditTransaction } from "./audit-writer.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";

export type IssuedChatgptCredentials = ChatgptTokenBundle & {
  credentialVersion: string;
};
type Row = typeof aiChatgptConnections.$inferSelect;
type Pending = { deviceAuthId: string; userCode: string };
type PollClaim =
  | { done: ChatgptConnectionView }
  | { row: Row; pending: Pending; operationId: string };
type RefreshClaim =
  | {
      tokens: IssuedChatgptCredentials | null;
      revokeToken?: string;
      ownerRemoved?: true;
    }
  | { row: Row; current: ChatgptTokenBundle; operationId: string };
const T = aiChatgptConnections;
const credentialVersion = (ciphertext: string) =>
  createHash("sha256").update(ciphertext).digest("hex");
const issuedCredentials = (
  tokens: ChatgptTokenBundle,
  ciphertext: string,
): IssuedChatgptCredentials => ({
  ...tokens,
  credentialVersion: credentialVersion(ciphertext),
});
const aad = (row: Pick<Row, "tenantId" | "id">, kind: "pending" | "tokens") =>
  `ai_chatgpt:${row.tenantId}:${row.id}:${kind}`;
const version = () =>
  sql`greatest(clock_timestamp(), ${T.updatedAt} + interval '1 microsecond')`;
const leaseEnds = (now: Date) =>
  new Date(now.getTime() + env.AI_TIMEOUT_MS * 2 + 10_000);

function assertScope(context: ScopedTenantContext): void {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new HttpError(403, "FORBIDDEN", "Tenant scope is required.");
}
function assertEnabled(): void {
  if (!env.AI_CHATGPT_ENABLED) throw new AiError("AI_CHATGPT_DISABLED");
}
const lockKey = (tenantId: TenantId) => `ai_chatgpt:${tenantId}`;
async function lock(tx: AuditTransaction, tenantId: TenantId): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(tenantId)}, 0))`,
  );
}
/** Non-blocking `lock()`: false when a request already holds the connection lock. */
async function tryLock(
  tx: AuditTransaction,
  tenantId: TenantId,
): Promise<boolean> {
  const { rows } = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${lockKey(tenantId)}, 0)) as locked`,
  );
  return rows[0]?.locked === true;
}
async function read(
  tx: AuditTransaction,
  tenantId: TenantId,
  locked = false,
): Promise<Row | undefined> {
  const query = tx.select().from(T).where(eq(T.tenantId, tenantId)).limit(1);
  const [row] = await (locked ? query.for("update") : query);
  return row;
}
function view(row?: Row, viewerCanManage = false): ChatgptConnectionView {
  let state: ChatgptLoginState =
    row?.status === "unavailable" ? "failed" : (row?.status ?? "disconnected");
  if (
    row &&
    (row.status === "pending" || row.status === "unavailable") &&
    row.expiresAt &&
    row.expiresAt.getTime() <= Date.now()
  )
    state = "expired";
  let deviceCode: string | null = null;
  // A governance viewer may see status without ever opening a secret envelope.
  if (
    viewerCanManage &&
    env.AI_CHATGPT_ENABLED &&
    state === "pending" &&
    row?.expiresAt &&
    row.expiresAt.getTime() > Date.now() &&
    row.pendingEncrypted
  ) {
    try {
      deviceCode = openPending(row).userCode;
    } catch {
      state = "failed";
    }
  }
  return {
    state,
    platformDisabled: !env.AI_CHATGPT_ENABLED,
    viewerCanManage,
    deviceCode,
    verificationUrl:
      deviceCode === null ? null : "https://auth.openai.com/codex/device",
    expiresAt: row?.expiresAt?.toISOString() ?? null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    riskAcceptedAt: row?.riskAcceptedAt?.toISOString() ?? null,
  };
}
function safeSnapshot(row: Row): Record<string, unknown> {
  return {
    enabled: row.enabled,
    status: row.status,
    model: row.model,
    generation: row.generation,
    riskAcceptedBy: row.riskAcceptedBy,
    riskAcceptedAt: row.riskAcceptedAt?.toISOString() ?? null,
  };
}
async function audit(
  tx: AuditTransaction,
  context: ScopedTenantContext,
  row: Row,
  action: string,
  actorId: string | null,
): Promise<void> {
  await recordAudit(
    {
      tenantId: row.tenantId,
      outletId: null,
      actorType: actorId ? "user" : "system",
      actorId,
      deviceId: null,
      action,
      objectType: "ai_chatgpt_connection",
      objectId: row.id,
      reason: null,
      before: null,
      after: safeSnapshot(row),
      sensitiveAccess: false,
    },
    { tx, context },
  );
}
const clearedSecrets = {
  enabled: false,
  pendingEncrypted: null,
  tokensEncrypted: null,
  attemptId: null,
  expiresAt: null,
  nextPollAt: null,
  operationId: null,
  operationLeaseUntil: null,
  connectedAt: null,
} as const;
async function invalidate(
  tx: AuditTransaction,
  context: ScopedTenantContext,
  row: Row,
  preserveDeviceExpiry = false,
): Promise<Row> {
  const [saved] = await tx
    .update(T)
    .set({
      ...clearedSecrets,
      ...(preserveDeviceExpiry ? { expiresAt: row.expiresAt } : {}),
      status: "unavailable",
      generation: row.generation + 1,
      updatedAt: version(),
    })
    .where(
      and(
        eq(T.tenantId, row.tenantId),
        eq(T.id, row.id),
        eq(T.generation, row.generation),
      ),
    )
    .returning();
  if (!saved) throw new ChatgptCodexError("unavailable");
  await audit(tx, context, saved, "ai_chatgpt.unavailable", null);
  return saved;
}
/** Local disconnect on an open transaction (same shape as an owner revoke).
 * Returns the stored refresh token so the caller can revoke it upstream after
 * the commit. Unreadable secrets are still cleared. */
async function disconnectInTransaction(
  tx: AuditTransaction,
  context: ScopedTenantContext,
  row: Row,
  actorId: string | null,
): Promise<{ row: Row; refreshToken: string | undefined }> {
  let refreshToken: string | undefined;
  if (row.tokensEncrypted) {
    try {
      refreshToken = openTokens(row).refreshToken;
    } catch {
      /* unreadable secrets are still cleared */
    }
  }
  const [saved] = await tx
    .update(T)
    .set({
      ...clearedSecrets,
      status: "disconnected",
      generation: row.generation + 1,
      updatedAt: version(),
    })
    .where(and(eq(T.tenantId, row.tenantId), eq(T.id, row.id)))
    .returning();
  if (!saved) throw new ChatgptCodexError("unavailable");
  await audit(tx, context, saved, "ai_chatgpt.revoked", actorId);
  return { row: saved, refreshToken };
}
function tokenBundle(value: unknown): ChatgptTokenBundle {
  // Never propagate a JSON/schema exception: Node may include a plaintext
  // fragment in its error message. No decrypted value reaches the logger.
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    const v = value as Record<string, unknown>;
    if (
      typeof v.accessToken !== "string" ||
      !v.accessToken ||
      v.accessToken.length > 50_000 ||
      typeof v.refreshToken !== "string" ||
      !v.refreshToken ||
      v.refreshToken.length > 50_000 ||
      !(
        v.accountId === null ||
        (typeof v.accountId === "string" && v.accountId.length <= 1000)
      )
    )
      throw 0;
    const expiresAt =
      v.expiresAt instanceof Date
        ? v.expiresAt
        : typeof v.expiresAt === "string"
          ? new Date(v.expiresAt)
          : null;
    if (!expiresAt || !Number.isFinite(expiresAt.getTime())) throw 0;
    return {
      accessToken: v.accessToken,
      refreshToken: v.refreshToken,
      accountId: v.accountId as string | null,
      expiresAt,
    };
  } catch {
    throw new ChatgptCodexError("unavailable");
  }
}
function openTokens(row: Row): ChatgptTokenBundle {
  try {
    return tokenBundle(
      JSON.parse(openSecret(row.tokensEncrypted ?? "", aad(row, "tokens"))),
    );
  } catch {
    throw new ChatgptCodexError("unavailable");
  }
}
function openPending(row: Row): { deviceAuthId: string; userCode: string } {
  try {
    const v = JSON.parse(
      openSecret(row.pendingEncrypted ?? "", aad(row, "pending")),
    ) as Record<string, unknown>;
    if (
      !v ||
      typeof v.deviceAuthId !== "string" ||
      !v.deviceAuthId ||
      v.deviceAuthId.length > 10_000 ||
      typeof v.userCode !== "string" ||
      !v.userCode ||
      v.userCode.length > 40
    )
      throw 0;
    return { deviceAuthId: v.deviceAuthId, userCode: v.userCode };
  } catch {
    throw new ChatgptCodexError("unavailable");
  }
}
function sealTokens(row: Row, input: ChatgptTokenBundle): string {
  const tokens = tokenBundle(input);
  return sealSecret(
    JSON.stringify({ ...tokens, expiresAt: tokens.expiresAt.toISOString() }),
    aad(row, "tokens"),
  );
}
function operationWhere(row: Row, operationId: string) {
  return and(
    eq(T.tenantId, row.tenantId),
    eq(T.id, row.id),
    eq(T.generation, row.generation),
    eq(T.operationId, operationId),
  );
}
async function release(
  context: ScopedTenantContext,
  row: Row,
  operationId: string,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    await tx
      .update(T)
      .set({
        operationId: null,
        operationLeaseUntil: null,
        updatedAt: sql`${T.updatedAt}`,
      })
      .where(operationWhere(row, operationId));
  });
}
async function bestEffortRevoke(
  refreshToken: string | undefined,
): Promise<void> {
  if (refreshToken)
    await revokeChatgptToken(refreshToken).catch(() => undefined);
}

export async function getChatgptConnectionView(
  context: ScopedTenantContext,
  viewerCanManage = false,
): Promise<ChatgptConnectionView> {
  assertScope(context);
  return withTenant(db, context, async (tx) =>
    view(await read(tx, context.tenant.tenantId), viewerCanManage),
  );
}

export async function startChatgptConnection(
  context: ScopedTenantContext,
  userId: string,
  input: StartChatgptConnectionInput,
): Promise<ChatgptDeviceAttempt> {
  assertScope(context);
  startChatgptConnectionInputSchema.parse(input);
  assertEnabled();
  const claim = await withTenant(db, context, async (tx) => {
    await lock(tx, context.tenant.tenantId);
    assertEnabled();
    const current = await read(tx, context.tenant.tenantId, true);
    const now = new Date();
    if (
      current &&
      ((current.nextStartAt && current.nextStartAt > now) ||
        (current.operationLeaseUntil && current.operationLeaseUntil > now))
    )
      throw new AiError("AI_CHATGPT_RATE_LIMITED");
    // The previous account's tokens are dropped below; revoke them upstream
    // after the commit instead of leaving them valid at OpenAI.
    let previousRefreshToken: string | undefined;
    if (current?.tokensEncrypted) {
      try {
        previousRefreshToken = openTokens(current).refreshToken;
      } catch {
        /* unreadable secrets are still cleared */
      }
    }
    const operationId = randomUUID();
    const values = {
      tenantId: context.tenant.tenantId,
      enabled: true,
      status: "pending" as const,
      model: input.model ?? current?.model ?? env.AI_CHATGPT_MODEL,
      generation: (current?.generation ?? 0) + 1,
      attemptId: randomUUID(),
      pendingEncrypted: null,
      tokensEncrypted: null,
      expiresAt: new Date(now.getTime() + 15 * 60_000),
      intervalSeconds: 5,
      nextPollAt: new Date(now.getTime() + 5000),
      nextStartAt: new Date(now.getTime() + 30_000),
      operationId,
      operationLeaseUntil: leaseEnds(now),
      riskAcceptedBy: userId,
      riskAcceptedAt: now,
      connectedAt: null,
    };
    const [saved] = current
      ? await tx
          .update(T)
          .set({ ...values, updatedAt: version() })
          .where(and(eq(T.tenantId, current.tenantId), eq(T.id, current.id)))
          .returning()
      : await tx.insert(T).values(values).returning();
    if (!saved) throw new ChatgptCodexError("unavailable");
    await audit(tx, context, saved, "ai_chatgpt.opted_in", userId);
    return { row: saved, operationId, previousRefreshToken };
  });
  await bestEffortRevoke(claim.previousRefreshToken);
  try {
    assertEnabled();
    const result = await startChatgptDevice();
    assertEnabled();
    const intervalSeconds = Math.max(
      5,
      Math.min(60, Math.ceil(result.intervalSeconds)),
    );
    const pendingEncrypted = sealSecret(
      JSON.stringify({
        deviceAuthId: result.deviceAuthId,
        userCode: result.userCode,
      }),
      aad(claim.row, "pending"),
    );
    const saved = await withTenant(db, context, async (tx) => {
      assertEnabled();
      const [row] = await tx
        .update(T)
        .set({
          pendingEncrypted,
          expiresAt: result.expiresAt,
          intervalSeconds,
          nextPollAt: new Date(Date.now() + intervalSeconds * 1000),
          operationId: null,
          operationLeaseUntil: null,
          updatedAt: version(),
        })
        .where(operationWhere(claim.row, claim.operationId))
        .returning();
      return row;
    });
    if (!saved) throw new AiError("AI_CHATGPT_NOT_CONNECTED");
    return view(saved, true);
  } catch (error) {
    await invalidateChatgptConnection(context, claim.row.generation, {
      operationId: claim.operationId,
      tokensEncrypted: claim.row.tokensEncrypted,
    });
    if (error instanceof AiError) throw error;
    throw new AiError(
      env.AI_CHATGPT_ENABLED
        ? "AI_PROVIDER_UNAVAILABLE"
        : "AI_CHATGPT_DISABLED",
    );
  }
}

export async function pollChatgptConnection(
  context: ScopedTenantContext,
  userId: string,
  attemptId?: string,
): Promise<ChatgptConnectionView> {
  assertScope(context);
  assertEnabled();
  const claim = await withTenant(
    db,
    context,
    async (tx): Promise<PollClaim> => {
      await lock(tx, context.tenant.tenantId);
      const row = await read(tx, context.tenant.tenantId, true);
      if (!row || (attemptId !== undefined && row.attemptId !== attemptId))
        throw new AiError("AI_CHATGPT_NOT_CONNECTED");
      if (row.status !== "pending") return { done: view(row, true) };
      const now = new Date();
      if (!row.expiresAt || row.expiresAt <= now)
        return { done: view(await invalidate(tx, context, row, true), true) };
      if (
        (row.nextPollAt && row.nextPollAt > now) ||
        (row.operationLeaseUntil && row.operationLeaseUntil > now)
      )
        throw new AiError("AI_CHATGPT_RATE_LIMITED");
      let pending: { deviceAuthId: string; userCode: string };
      try {
        pending = openPending(row);
      } catch {
        return { done: view(await invalidate(tx, context, row), true) };
      }
      const operationId = randomUUID();
      await tx
        .update(T)
        .set({
          operationId,
          operationLeaseUntil: leaseEnds(now),
          nextPollAt: new Date(now.getTime() + row.intervalSeconds * 1000),
          updatedAt: sql`${T.updatedAt}`,
        })
        .where(and(eq(T.tenantId, row.tenantId), eq(T.id, row.id)));
      return { row, pending, operationId };
    },
  );
  if ("done" in claim) return claim.done;
  const { row, pending, operationId } = claim;
  let result: Awaited<ReturnType<typeof pollChatgptDevice>>;
  try {
    assertEnabled();
    result = await pollChatgptDevice(pending);
  } catch (error) {
    if (error instanceof ChatgptCodexError && error.kind === "auth")
      await invalidateChatgptConnection(context, row.generation, {
        operationId,
        tokensEncrypted: row.tokensEncrypted,
      });
    else await release(context, row, operationId);
    throw new AiError(
      env.AI_CHATGPT_ENABLED
        ? "AI_PROVIDER_UNAVAILABLE"
        : "AI_CHATGPT_DISABLED",
    );
  }
  if (!env.AI_CHATGPT_ENABLED) {
    await invalidateChatgptConnection(context, row.generation, {
      operationId,
      tokensEncrypted: row.tokensEncrypted,
    });
    throw new AiError("AI_CHATGPT_DISABLED");
  }
  if (result.status === "pending") {
    await release(context, row, operationId);
    return getChatgptConnectionView(context, true);
  }
  let saved: Row | undefined;
  try {
    const tokensEncrypted = sealTokens(row, result.tokens);
    saved = await withTenant(db, context, async (tx) => {
      assertEnabled();
      const [connected] = await tx
        .update(T)
        .set({
          status: "connected",
          tokensEncrypted,
          pendingEncrypted: null,
          expiresAt: null,
          nextPollAt: null,
          operationId: null,
          operationLeaseUntil: null,
          connectedAt: new Date(),
          updatedAt: version(),
        })
        .where(
          and(
            operationWhere(row, operationId),
            eq(T.pendingEncrypted, row.pendingEncrypted!),
          ),
        )
        .returning();
      if (connected)
        await audit(tx, context, connected, "ai_chatgpt.connected", userId);
      return connected;
    });
  } catch {
    await invalidateChatgptConnection(context, row.generation, {
      operationId,
      tokensEncrypted: row.tokensEncrypted,
    });
    throw new AiError(
      env.AI_CHATGPT_ENABLED
        ? "AI_PROVIDER_UNAVAILABLE"
        : "AI_CHATGPT_DISABLED",
    );
  }
  if (!saved) {
    // Lost the race (local revoke, replacement or expiry). These tokens come
    // from this attempt's own device-code exchange, so no other operation can
    // share them: revoke them upstream instead of leaving them valid.
    await bestEffortRevoke(result.tokens.refreshToken);
    return getChatgptConnectionView(context, true);
  }
  return view(saved, true);
}

/** Local revoke commits before the best-effort upstream request. Also works
 * when the global switch is off. The tombstone forbids platform fallback. */
export async function removeChatgptConnection(
  context: ScopedTenantContext,
  userId: string,
): Promise<ChatgptConnectionView> {
  assertScope(context);
  const outcome = await withTenant(db, context, async (tx) => {
    await lock(tx, context.tenant.tenantId);
    const current = await read(tx, context.tenant.tenantId, true);
    let refreshToken: string | undefined;
    if (current?.tokensEncrypted) {
      try {
        refreshToken = openTokens(current).refreshToken;
      } catch {
        /* unreadable secrets are still cleared */
      }
    }
    const [saved] = current
      ? await tx
          .update(T)
          .set({
            ...clearedSecrets,
            status: "disconnected",
            generation: current.generation + 1,
            updatedAt: version(),
          })
          .where(and(eq(T.tenantId, current.tenantId), eq(T.id, current.id)))
          .returning()
      : await tx
          .insert(T)
          .values({
            tenantId: context.tenant.tenantId,
            status: "disconnected",
            generation: 1,
          })
          .returning();
    if (!saved) throw new ChatgptCodexError("unavailable");
    await audit(tx, context, saved, "ai_chatgpt.revoked", userId);
    return { row: saved, refreshToken };
  });
  await bestEffortRevoke(outcome.refreshToken);
  return view(outcome.row, true);
}

export async function getChatgptProviderState(
  context: ScopedTenantContext,
): Promise<{
  exists: boolean;
  active: boolean;
  model: string | null;
  generation: number | null;
}> {
  assertScope(context);
  return withTenant(db, context, async (tx) => {
    const row = await read(tx, context.tenant.tenantId);
    return {
      exists: Boolean(row),
      active: Boolean(
        env.AI_CHATGPT_ENABLED &&
        row?.enabled &&
        row.status === "connected" &&
        row.tokensEncrypted,
      ),
      model: row?.model ?? null,
      generation: row?.generation ?? null,
    };
  });
}
export async function invalidateChatgptConnection(
  context: ScopedTenantContext,
  expectedGeneration: number,
  expected:
    | {
        operationId: string;
        tokensEncrypted: string | null;
        credentialVersion?: never;
      }
    | {
        credentialVersion: string;
        operationId?: never;
        tokensEncrypted?: never;
      },
): Promise<void> {
  assertScope(context);
  await withTenant(db, context, async (tx) => {
    await lock(tx, context.tenant.tenantId);
    const row = await read(tx, context.tenant.tenantId, true);
    if (!row || row.generation !== expectedGeneration) return;
    if (expected.credentialVersion !== undefined) {
      // A refresh that already claimed this row may replace the rejected
      // credential. An older inference must not cancel that in-flight winner.
      if (
        row.operationId &&
        row.operationLeaseUntil &&
        row.operationLeaseUntil.getTime() > Date.now()
      )
        return;
      // Access/refresh strings can remain unchanged across a successful token
      // rotation. Fence the exact encrypted envelope issued to this attempt.
      if (
        !row.tokensEncrypted ||
        credentialVersion(row.tokensEncrypted) !== expected.credentialVersion
      )
        return;
    } else if (
      row.operationId !== expected.operationId ||
      row.tokensEncrypted !== expected.tokensEncrypted
    )
      return;
    await invalidate(tx, context, row);
  });
}

/** Refresh is leased across API processes and fenced against revoke/replacement.
 * Transient failures do not look like an auth failure to the gateway fallback. */
export async function getChatgptCredentials(
  context: ScopedTenantContext,
  expectedGeneration: number,
): Promise<IssuedChatgptCredentials | null> {
  assertScope(context);
  if (!env.AI_CHATGPT_ENABLED) return null;
  const claim = await withTenant(
    db,
    context,
    async (tx): Promise<RefreshClaim> => {
      await lock(tx, context.tenant.tenantId);
      const row = await read(tx, context.tenant.tenantId, true);
      if (
        !env.AI_CHATGPT_ENABLED ||
        !row ||
        !row.enabled ||
        row.status !== "connected" ||
        row.generation !== expectedGeneration ||
        !row.tokensEncrypted
      )
        return { tokens: null };
      // The approving owner's consent backs this paid account. If that user no
      // longer holds an active owner assignment here, disconnect and refuse.
      const approver = row.riskAcceptedBy;
      const approverStillOwner =
        approver !== null &&
        (
          await accessSnapshotInTransaction(tx, context, approver, new Date())
        ).allowsVia("owner", "ai.governance.manage", { type: "tenant" });
      if (!approverStillOwner) {
        const removed = await disconnectInTransaction(tx, context, row, null);
        return {
          tokens: null,
          revokeToken: removed.refreshToken,
          ownerRemoved: true,
        };
      }
      let tokens: ChatgptTokenBundle;
      try {
        tokens = openTokens(row);
      } catch {
        await invalidate(tx, context, row);
        return { tokens: null };
      }
      const now = new Date();
      if (tokens.expiresAt.getTime() > now.getTime() + 60_000)
        return { tokens: issuedCredentials(tokens, row.tokensEncrypted) };
      if (
        (row.operationLeaseUntil && row.operationLeaseUntil > now) ||
        (row.nextPollAt && row.nextPollAt > now)
      )
        throw new ChatgptCodexError("unavailable");
      const operationId = randomUUID();
      await tx
        .update(T)
        .set({
          operationId,
          operationLeaseUntil: leaseEnds(now),
          nextPollAt: new Date(now.getTime() + 5000),
          updatedAt: sql`${T.updatedAt}`,
        })
        .where(and(eq(T.tenantId, row.tenantId), eq(T.id, row.id)));
      return { row, current: tokens, operationId };
    },
  );
  if ("tokens" in claim) {
    await bestEffortRevoke(claim.revokeToken);
    // Null would read as "auth" upstream and fall back to the tenant API key;
    // a removed owner must refuse the call instead.
    if (claim.ownerRemoved) throw new ChatgptCodexError("unavailable");
    return env.AI_CHATGPT_ENABLED ? claim.tokens : null;
  }
  const { row, current, operationId } = claim;
  let refreshed: ChatgptTokenBundle;
  try {
    assertEnabled();
    refreshed = tokenBundle(await refreshChatgptToken(current));
  } catch (error) {
    if (
      !env.AI_CHATGPT_ENABLED ||
      (error instanceof ChatgptCodexError && error.kind === "auth")
    ) {
      await invalidateChatgptConnection(context, expectedGeneration, {
        operationId,
        tokensEncrypted: row.tokensEncrypted,
      });
      return null;
    }
    await release(context, row, operationId);
    throw new ChatgptCodexError("unavailable");
  }
  if (!env.AI_CHATGPT_ENABLED) {
    await invalidateChatgptConnection(context, expectedGeneration, {
      operationId,
      tokensEncrypted: row.tokensEncrypted,
    });
    return null;
  }
  let saved: Row | undefined;
  // Assigned inside the transaction callback; the cast stops TS narrowing it
  // to `undefined` at the read below.
  let ownerRemoved = undefined as
    { revokeToken: string | undefined } | undefined;
  try {
    const encrypted = sealTokens(row, refreshed);
    saved = await withTenant(db, context, async (tx) => {
      if (!env.AI_CHATGPT_ENABLED) return undefined;
      // The refresh waited on the network: re-check under the connection lock
      // that the approving owner still holds an active owner assignment, using
      // the same check as the claim. If not, the new token is never stored.
      await lock(tx, context.tenant.tenantId);
      const latest = await read(tx, context.tenant.tenantId, true);
      if (
        !latest ||
        latest.status !== "connected" ||
        latest.generation !== row.generation ||
        latest.operationId !== operationId
      )
        return undefined;
      const approver = latest.riskAcceptedBy;
      const approverStillOwner =
        approver !== null &&
        (
          await accessSnapshotInTransaction(tx, context, approver, new Date())
        ).allowsVia("owner", "ai.governance.manage", { type: "tenant" });
      if (!approverStillOwner) {
        const removed = await disconnectInTransaction(
          tx,
          context,
          latest,
          null,
        );
        ownerRemoved = { revokeToken: removed.refreshToken };
        return undefined;
      }
      const [updated] = await tx
        .update(T)
        .set({
          tokensEncrypted: encrypted,
          operationId: null,
          operationLeaseUntil: null,
          nextPollAt: null,
          updatedAt: version(),
        })
        .where(
          and(
            operationWhere(row, operationId),
            eq(T.tokensEncrypted, row.tokensEncrypted!),
          ),
        )
        .returning();
      if (updated)
        await audit(tx, context, updated, "ai_chatgpt.refreshed", null);
      return updated;
    });
  } catch {
    // The upstream token may have rotated. Keep local state fail-closed.
    await invalidateChatgptConnection(context, expectedGeneration, {
      operationId,
      tokensEncrypted: row.tokensEncrypted,
    });
    throw new ChatgptCodexError("unavailable");
  }
  if (ownerRemoved) {
    // Disconnected in the save transaction: revoke the new token and the old
    // one upstream. Throw "unavailable": null would read as "auth" and the
    // gateway would fall back to the tenant API key.
    await bestEffortRevoke(refreshed.refreshToken);
    if (ownerRemoved.revokeToken !== refreshed.refreshToken)
      await bestEffortRevoke(ownerRemoved.revokeToken);
    throw new ChatgptCodexError("unavailable");
  }
  if (!saved) {
    // A non-rotating refresh token can be shared with the winning operation,
    // so a stale result is only revoked upstream when the connection was
    // removed locally meanwhile (no winner can own it then).
    const now = await withTenant(db, context, (tx) =>
      read(tx, context.tenant.tenantId),
    );
    if (!now || now.status === "disconnected")
      await bestEffortRevoke(refreshed.refreshToken);
    return null;
  }
  const latest = await getChatgptProviderState(context);
  return latest.active &&
    latest.generation === expectedGeneration &&
    env.AI_CHATGPT_ENABLED
    ? issuedCredentials(refreshed, saved.tokensEncrypted!)
    : null;
}

type ResealCounts = { resealed: number; failed: number; busy: number };

/**
 * Key-rotation reseal of one tenant's connection, called only by the
 * `sealed-secret-reseal` job (hence `Any`), inside withTenant. It never waits
 * on a request and never changes a ciphertext an operation has read: a row with
 * a live (or recently expired, +10 minutes) operation lease, or whose
 * connection lock is held, is reported busy and left untouched. One CAS UPDATE
 * moves both columns; updated_at (AI answer cache key), generation, operation
 * and lease columns stay as they are. No audit row. An unreadable value is
 * counted failed and left as is: the live path owns invalidate/disconnect.
 * Runs even when AI_CHATGPT_ENABLED is off so the data stays readable.
 */
export async function resealChatgptConnectionAny(
  tx: AuditTransaction,
  tenantId: TenantId,
  active: number,
): Promise<Record<string, ResealCounts>> {
  const result: Record<string, ResealCounts> = {
    tokens_encrypted: { resealed: 0, failed: 0, busy: 0 },
    pending_encrypted: { resealed: 0, failed: 0, busy: 0 },
  };
  const isStale = (value: string | null): value is string => {
    if (value === null) return false;
    try {
      return sealedVersion(value) < active;
    } catch {
      // Empty envelope: cannot be moved; surfaces as failed below.
      return true;
    }
  };
  const columns = [
    { name: "tokens_encrypted", kind: "tokens", field: "tokensEncrypted" },
    { name: "pending_encrypted", kind: "pending", field: "pendingEncrypted" },
  ] as const;

  const locked = await tryLock(tx, tenantId);
  const row = await read(tx, tenantId, locked);
  if (!row) return result;
  const stale = columns.filter((c) => isStale(row[c.field]));
  if (stale.length === 0) return result;
  if (!locked) {
    for (const c of stale) result[c.name]!.busy = 1;
    return result;
  }
  // A save may land after the lease ends, so the margin keeps the row busy.
  const {
    rows: [lease],
  } = await tx.execute<{ busy: boolean }>(
    sql`select coalesce(${T.operationId} is not null and ${T.operationLeaseUntil} > now() - interval '10 minutes', false) as busy
        from ${T} where ${T.tenantId} = ${tenantId} and ${T.id} = ${row.id}`,
  );
  if (lease?.busy !== false) {
    for (const c of stale) result[c.name]!.busy = 1;
    return result;
  }

  const changed: Partial<
    Record<"tokensEncrypted" | "pendingEncrypted", string>
  > = {};
  for (const c of stale) {
    try {
      const value = row[c.field]!;
      const next = sealSecret(
        openSecret(value, aad(row, c.kind)),
        aad(row, c.kind),
      );
      changed[c.field] = next;
    } catch {
      result[c.name]!.failed = 1;
    }
  }
  if (Object.keys(changed).length === 0) return result;

  const updated = await tx
    .update(T)
    .set({ ...changed, updatedAt: sql`${T.updatedAt}` })
    .where(
      and(
        eq(T.tenantId, row.tenantId),
        eq(T.id, row.id),
        eq(T.generation, row.generation),
        sql`${T.operationId} is not distinct from ${row.operationId}`,
        sql`${T.tokensEncrypted} is not distinct from ${row.tokensEncrypted}`,
        sql`${T.pendingEncrypted} is not distinct from ${row.pendingEncrypted}`,
      ),
    )
    .returning({ id: T.id });
  // A CAS miss (row changed since the read) is retried next run, not a failure.
  if (updated.length === 1)
    for (const c of stale) if (changed[c.field]) result[c.name]!.resealed = 1;
  return result;
}

/** Cache version includes the global switch even for an absent tenant row. */
export async function chatgptConnectionVersionOf(
  tx: AuditTransaction,
  tenantId: TenantId,
): Promise<string> {
  const [row] = await tx
    .select({
      generation: T.generation,
      version: sql<string>`${T.updatedAt}::text`,
    })
    .from(T)
    .where(eq(T.tenantId, tenantId))
    .limit(1);
  return `${env.AI_CHATGPT_ENABLED ? "on" : "off"}:${row ? `${row.generation}:${row.version}` : "none"}`;
}
