import {
  CoreError,
  assertOutletInScope,
  createUlid,
  decodeCursor,
  encodeCursor,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { PermissionCode } from "@starter/shared/access";
import { EdcError } from "@starter/shared/edc";
import {
  getPaymentRouting as routingContract,
  listEdcTerminals as terminalsContract,
  getEdcCashierDefaults as defaultsContract,
  paymentRouteSchema,
  edcTerminalViewSchema,
  edcCashierDefaultSchema,
  type UpdatePaymentRouteInput,
  type CreateEdcTerminalInput,
  type UpdateEdcTerminalInput,
  type UpdateEdcCashierDefaultInput,
} from "@starter/shared/payment/admin";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  outlets,
  paymentRoutingRules,
  roleAssignments,
  user,
} from "../db/schema";
import {
  paymentEdcTerminals,
  paymentCashierDefaults,
} from "../db/schema/payment-admin.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import { withTenant } from "../db/tenant";
import { recordAudit } from "./core-audit";
import { registeredGatewayProviders } from "./payment-gateway";
import {
  assertRoutableProvider,
  providerRoutability,
} from "./payment-routing.service";
import { listPlatformGateways } from "./platform-payment-gateway.service";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { appendPaymentEvent, assertPaymentPermission } from "./payment-support";
import type { Tx } from "./permission-resolver";
import type { z } from "zod";

async function authorize(
  tx: Tx,
  ctx: ScopedTenantContext,
  actor: string,
  outletId: string | null,
  permission: PermissionCode = "payment.edc.manage",
) {
  if (outletId) assertOutletInScope(ctx.outletScope, outletId);
  await assertPaymentPermission(
    tx,
    ctx,
    actor,
    permission,
    outletId ? { type: "outlet", id: outletId } : { type: "tenant" },
    new Date(),
  );
}
async function outletName(tx: Tx, ctx: ScopedTenantContext, outletId: string) {
  assertOutletInScope(ctx.outletScope, outletId);
  const [row] = await tx
    .select()
    .from(outlets)
    .where(
      and(eq(outlets.tenantId, ctx.tenant.tenantId), eq(outlets.id, outletId)),
    );
  if (!row) throw new CoreError("NOT_FOUND", "Outlet not found.");
  return row.name;
}
type ConfigEvent =
  | "payment_route.updated"
  | "edc_terminal.created"
  | "edc_terminal.updated"
  | "cashier_payment_default.updated";
type Changes = Record<string, string | number | boolean | null | string[]>;
/** Every configuration write leaves an audit row and an outbox event in the
 * same transaction (PRD §3.13 PAY-05; WS-00 outbox). Values are config only. */
async function record(
  tx: Tx,
  ctx: ScopedTenantContext,
  actor: string,
  outletId: string | null,
  event: ConfigEvent,
  objectId: string,
  before: Changes | null,
  after: Changes,
) {
  const now = new Date();
  await recordAudit(
    tx,
    ctx,
    {
      id: createUlid(now.getTime()),
      tenantId: ctx.tenant.tenantId,
      outletId,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: event,
      objectType: event.split(".")[0]!,
      objectId,
      reason: null,
      maskedChanges: { before, after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    Object.keys(after),
  );
  await appendPaymentEvent(tx, ctx, {
    name: event,
    aggregateId: objectId,
    outletId,
    actor: { type: "user", id: actor },
    payload: { id: objectId, ...after },
    now,
  });
}
const routeChanges = (r: typeof paymentRoutingRules.$inferSelect) => ({
  method: r.method,
  provider: r.provider,
  fallbackProvider: r.fallbackProvider,
  enabled: r.enabled,
});
const terminalChanges = (r: typeof paymentEdcTerminals.$inferSelect) => ({
  bankCode: r.bankCode,
  terminalId: r.terminalId,
  merchantId: r.merchantId,
  supportedMethods: r.supportedMethods,
  status: r.status,
});
const defaultChanges = (r: typeof paymentCashierDefaults.$inferSelect) => ({
  cashierId: r.cashierId,
  terminalId: r.terminalId,
  defaultMethod: r.defaultMethod,
});
const routeView = (r: typeof paymentRoutingRules.$inferSelect) =>
  paymentRouteSchema.parse({
    id: r.id,
    tenantId: r.tenantId,
    outletId: r.outletId,
    method: r.method,
    provider: r.provider,
    fallbackProvider: r.fallbackProvider,
    enabled: r.enabled,
    updatedAt: r.updatedAt.toISOString(),
  });
const terminalView = (
  r: typeof paymentEdcTerminals.$inferSelect,
  name: string,
) =>
  edcTerminalViewSchema.parse({
    id: r.id,
    tenantId: r.tenantId,
    outletId: r.outletId,
    bankCode: r.bankCode,
    terminalId: r.terminalId,
    merchantId: r.merchantId,
    model: r.model,
    connection: r.connection,
    ipAddress: r.ipAddress,
    supportedMethods: r.supportedMethods,
    assignedDeviceId: r.assignedDeviceId,
    status: r.status,
    outletName: name,
  });
const defaultView = (
  r: typeof paymentCashierDefaults.$inferSelect,
  name: string,
) =>
  edcCashierDefaultSchema.parse({
    id: r.id,
    tenantId: r.tenantId,
    outletId: r.outletId,
    cashierId: r.cashierId,
    cashierName: name,
    terminalId: r.terminalId,
    defaultMethod: r.defaultMethod,
    updatedAt: r.updatedAt.toISOString(),
  });

export async function getPaymentRouting(
  ctx: ScopedTenantContext,
  actor: string,
  query: z.input<typeof routingContract.query>,
) {
  const q = routingContract.query.parse(query);
  return withTenant(db, ctx, async (tx) => {
    // Routing chooses which gateway receives the money (sub-302 D14).
    await authorize(tx, ctx, actor, q.outletId ?? null, "org.settings.manage");
    const scope = q.outletId ?? null;
    const allOutlets = await tx
      .select()
      .from(outlets)
      .where(eq(outlets.tenantId, ctx.tenant.tenantId));
    const visible = allOutlets.filter(
      (o) =>
        ctx.outletScope.kind === "tenant" ||
        ctx.outletScope.outletIds.some((id) => id === o.id),
    );
    if (scope && !visible.some((o) => o.id === scope))
      throw new CoreError("NOT_FOUND", "Outlet not found.");
    const rows = await tx
      .select()
      .from(paymentRoutingRules)
      .where(
        and(
          eq(paymentRoutingRules.tenantId, ctx.tenant.tenantId),
          scope
            ? or(
                eq(paymentRoutingRules.outletId, scope),
                isNull(paymentRoutingRules.outletId),
              )
            : isNull(paymentRoutingRules.outletId),
        ),
      );
    // Registered adapter, switched on by Super Admin and allowed by the
    // tenant's package; `enabled` says an active integration serves this scope.
    const providers = [];
    for (const platform of await listPlatformGateways()) {
      if (!registeredGatewayProviders().includes(platform.provider)) continue;
      if (!platform.enabled) continue;
      const found = await providerRoutability(
        tx,
        ctx,
        platform.provider,
        scope,
      );
      if (!found.tenantAllowed) continue;
      providers.push({
        code: platform.provider,
        name: platform.displayName,
        kind: "gateway" as const,
        enabled: found.integrated,
      });
    }
    return {
      scope: scope ? ("outlet" as const) : ("tenant" as const),
      outletId: scope,
      outletName: visible.find((o) => o.id === scope)?.name ?? null,
      outlets: visible.map((o) => ({ id: o.id, name: o.name })),
      providers,
      routes: rows
        .filter((r) => r.outletId === null)
        .map((r) =>
          scope
            ? (rows.find(
                (override) =>
                  override.outletId === scope && override.method === r.method,
              ) ?? r)
            : r,
        )
        .filter((r) =>
          [
            "qris",
            "card",
            "ewallet",
            "va",
            "bank_transfer",
            "paylater",
          ].includes(r.method),
        )
        .map(routeView),
    };
  });
}
export async function updatePaymentRoute(
  ctx: ScopedTenantContext,
  actor: string,
  params: {
    method: UpdatePaymentRouteInput extends never
      ? never
      : "qris" | "card" | "ewallet" | "va" | "bank_transfer" | "paylater";
  },
  body: UpdatePaymentRouteInput,
  key: string,
) {
  return withTenant(db, ctx, async (tx) => {
    await authorize(tx, ctx, actor, body.outletId, "org.settings.manage");
    if (body.outletId) await outletName(tx, ctx, body.outletId);
    if (body.enabled)
      await assertRoutableProvider(
        tx,
        ctx,
        body.provider,
        body.outletId,
        body.fallbackProvider,
      );
    return idempotentPaymentAdminWrite(
      tx,
      ctx,
      actor,
      key,
      "routing.update",
      { params, body },
      async () => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenant.tenantId}:routing:${body.outletId}:${params.method}`}, 0))`,
        );
        const [old] = await tx
          .select()
          .from(paymentRoutingRules)
          .where(
            and(
              eq(paymentRoutingRules.tenantId, ctx.tenant.tenantId),
              eq(paymentRoutingRules.method, params.method),
              body.outletId
                ? eq(paymentRoutingRules.outletId, body.outletId)
                : isNull(paymentRoutingRules.outletId),
            ),
          );
        const values = {
          provider: body.provider,
          fallbackProvider: body.fallbackProvider,
          enabled: body.enabled,
          updatedBy: actor,
          updatedAt: new Date(),
        };
        const [row] = old
          ? await tx
              .update(paymentRoutingRules)
              .set(values)
              .where(eq(paymentRoutingRules.id, old.id))
              .returning()
          : await tx
              .insert(paymentRoutingRules)
              .values({
                tenantId: ctx.tenant.tenantId,
                outletId: body.outletId,
                method: params.method,
                ...values,
              })
              .returning();
        if (!row) throw new Error("Routing write failed");
        await record(
          tx,
          ctx,
          actor,
          body.outletId,
          "payment_route.updated",
          row.id,
          old ? routeChanges(old) : null,
          routeChanges(row),
        );
        return routeView(row);
      },
    );
  });
}
export async function listEdcTerminals(
  ctx: ScopedTenantContext,
  actor: string,
  query: z.input<typeof terminalsContract.query>,
) {
  const q = terminalsContract.query.parse(query);
  return withTenant(db, ctx, async (tx) => {
    await authorize(tx, ctx, actor, q.outletId ?? null);
    const [cursor] = q.cursor ? decodeCursor(q.cursor) : [undefined];
    if (cursor !== undefined && typeof cursor !== "string")
      throw new CoreError("VALIDATION_ERROR", "Invalid cursor.");
    const rows = await tx
      .select({ terminal: paymentEdcTerminals, name: outlets.name })
      .from(paymentEdcTerminals)
      .innerJoin(
        outlets,
        and(
          eq(outlets.tenantId, paymentEdcTerminals.tenantId),
          eq(outlets.id, paymentEdcTerminals.outletId),
        ),
      )
      .where(
        and(
          eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
          q.outletId ? eq(paymentEdcTerminals.outletId, q.outletId) : sql`TRUE`,
          cursor ? gt(paymentEdcTerminals.id, cursor) : sql`TRUE`,
        ),
      )
      .orderBy(asc(paymentEdcTerminals.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      data: page.map((r) => terminalView(r.terminal, r.name)),
      meta: {
        limit: q.limit,
        nextCursor:
          rows.length > q.limit && last
            ? encodeCursor([last.terminal.id])
            : null,
      },
    };
  });
}
export async function createEdcTerminal(
  ctx: ScopedTenantContext,
  actor: string,
  body: CreateEdcTerminalInput,
  key: string,
) {
  return withTenant(db, ctx, async (tx) => {
    await authorize(tx, ctx, actor, body.outletId);
    const name = await outletName(tx, ctx, body.outletId);
    return idempotentPaymentAdminWrite(
      tx,
      ctx,
      actor,
      key,
      "terminal.create",
      body,
      async () => {
        const [row] = await tx
          .insert(paymentEdcTerminals)
          .values({ ...body, tenantId: ctx.tenant.tenantId })
          .returning();
        if (!row) throw new Error("Terminal write failed");
        await record(
          tx,
          ctx,
          actor,
          body.outletId,
          "edc_terminal.created",
          row.id,
          null,
          terminalChanges(row),
        );
        return terminalView(row, name);
      },
    );
  });
}
export async function updateEdcTerminal(
  ctx: ScopedTenantContext,
  actor: string,
  params: { terminalId: string },
  body: UpdateEdcTerminalInput,
  key: string,
) {
  return withTenant(db, ctx, async (tx) => {
    const [old] = await tx
      .select()
      .from(paymentEdcTerminals)
      .where(
        and(
          eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
          eq(paymentEdcTerminals.id, params.terminalId),
        ),
      )
      .for("update");
    if (!old) throw new CoreError("NOT_FOUND", "Terminal not found.");
    await authorize(tx, ctx, actor, old.outletId);
    const name = await outletName(tx, ctx, old.outletId);
    return idempotentPaymentAdminWrite(
      tx,
      ctx,
      actor,
      key,
      "terminal.update",
      { params, body },
      async () => {
        // An inquiry asks whatever device the row describes now. With an
        // unfinished sale on this terminal the identity must not move, or the
        // new device's `not_found` could free a second charge (EDC-03). The
        // row is locked above and a new sale's insert needs a key-share lock
        // on it, so no sale can slip in between this check and the write.
        const identityChanged =
          (body.bankCode !== undefined && body.bankCode !== old.bankCode) ||
          (body.terminalId !== undefined &&
            body.terminalId !== old.terminalId) ||
          (body.merchantId !== undefined &&
            body.merchantId !== old.merchantId) ||
          (body.connection !== undefined &&
            body.connection !== old.connection) ||
          (body.ipAddress !== undefined && body.ipAddress !== old.ipAddress);
        if (identityChanged) {
          const [open] = await tx
            .select({ id: edcTransactions.id })
            .from(edcTransactions)
            .where(
              and(
                eq(edcTransactions.tenantId, ctx.tenant.tenantId),
                eq(edcTransactions.terminalId, old.id),
                inArray(edcTransactions.status, ["pending", "unknown"]),
              ),
            )
            .limit(1);
          if (open) throw new EdcError("EDC_TERMINAL_BUSY");
        }
        const [row] = await tx
          .update(paymentEdcTerminals)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(paymentEdcTerminals.id, old.id))
          .returning();
        if (!row) throw new Error("Terminal write failed");
        await record(
          tx,
          ctx,
          actor,
          old.outletId,
          "edc_terminal.updated",
          row.id,
          terminalChanges(old),
          terminalChanges(row),
        );
        return terminalView(row, name);
      },
    );
  });
}
export async function getEdcCashierDefaults(
  ctx: ScopedTenantContext,
  actor: string,
  query: z.input<typeof defaultsContract.query>,
) {
  const q = defaultsContract.query.parse(query);
  return withTenant(db, ctx, async (tx) => {
    await authorize(tx, ctx, actor, q.outletId);
    const name = await outletName(tx, ctx, q.outletId);
    const terminals = await tx
      .select()
      .from(paymentEdcTerminals)
      .where(
        and(
          eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
          eq(paymentEdcTerminals.outletId, q.outletId),
        ),
      );
    const cashiers = await tx
      .select({ row: paymentCashierDefaults, name: user.name })
      .from(paymentCashierDefaults)
      .innerJoin(user, eq(user.id, paymentCashierDefaults.cashierId))
      .where(
        and(
          eq(paymentCashierDefaults.tenantId, ctx.tenant.tenantId),
          eq(paymentCashierDefaults.outletId, q.outletId),
        ),
      );
    return {
      outletId: q.outletId,
      outletName: name,
      terminals: terminals.map((t) => terminalView(t, name)),
      cashiers: cashiers.map((c) => defaultView(c.row, c.name)),
    };
  });
}
export async function updateEdcCashierDefault(
  ctx: ScopedTenantContext,
  actor: string,
  params: { cashierId: string },
  body: UpdateEdcCashierDefaultInput,
  key: string,
) {
  return withTenant(db, ctx, async (tx) => {
    await authorize(tx, ctx, actor, body.outletId);
    await outletName(tx, ctx, body.outletId);
    const [cashier] = await tx
      .select({ name: user.name })
      .from(user)
      .innerJoin(roleAssignments, eq(roleAssignments.userId, user.id))
      .where(
        and(
          eq(user.id, params.cashierId),
          eq(roleAssignments.tenantId, ctx.tenant.tenantId),
          sql`(${roleAssignments.scopeType} = 'tenant' OR (${roleAssignments.scopeType} = 'outlet' AND ${roleAssignments.scopeId} = ${body.outletId}))`,
        ),
      );
    if (!cashier) throw new CoreError("NOT_FOUND", "Cashier not found.");
    if (body.defaultMethod !== "qris_doit") {
      if (!body.terminalId)
        throw new CoreError("VALIDATION_ERROR", "Terminal required.");
      const [terminal] = await tx
        .select()
        .from(paymentEdcTerminals)
        .where(
          and(
            eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
            eq(paymentEdcTerminals.outletId, body.outletId),
            eq(paymentEdcTerminals.id, body.terminalId),
          ),
        )
        .for("update");
      if (
        !terminal ||
        terminal.status !== "active" ||
        !terminal.supportedMethods.includes(
          body.defaultMethod === "edc_card" ? "card" : "qris",
        )
      )
        throw new CoreError(
          "VALIDATION_ERROR",
          "Terminal unavailable for method.",
        );
    } else if (body.terminalId)
      throw new CoreError("VALIDATION_ERROR", "DOIT does not use a terminal.");
    return idempotentPaymentAdminWrite(
      tx,
      ctx,
      actor,
      key,
      "cashier.update",
      { params, body },
      async () => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenant.tenantId}:cashier:${body.outletId}:${params.cashierId}`},0))`,
        );
        const [old] = await tx
          .select()
          .from(paymentCashierDefaults)
          .where(
            and(
              eq(paymentCashierDefaults.tenantId, ctx.tenant.tenantId),
              eq(paymentCashierDefaults.outletId, body.outletId),
              eq(paymentCashierDefaults.cashierId, params.cashierId),
            ),
          );
        const [row] = old
          ? await tx
              .update(paymentCashierDefaults)
              .set({
                terminalId: body.terminalId,
                defaultMethod: body.defaultMethod,
                updatedAt: new Date(),
              })
              .where(eq(paymentCashierDefaults.id, old.id))
              .returning()
          : await tx
              .insert(paymentCashierDefaults)
              .values({
                tenantId: ctx.tenant.tenantId,
                outletId: body.outletId,
                cashierId: params.cashierId,
                terminalId: body.terminalId,
                defaultMethod: body.defaultMethod,
              })
              .returning();
        if (!row) throw new Error("Cashier default write failed");
        await record(
          tx,
          ctx,
          actor,
          body.outletId,
          "cashier_payment_default.updated",
          row.id,
          old ? defaultChanges(old) : null,
          defaultChanges(row),
        );
        return defaultView(row, cashier.name);
      },
    );
  });
}
