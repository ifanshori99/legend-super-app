// EDC bridge tablets (B2 legend-wasr7.21): list, issue a token, revoke,
// assign terminals. `payment.edc.manage` at the device's outlet, checked on
// the row's own outlet. The token is shown once; only its SHA-256 is stored
// and nothing here logs it. Every write leaves an audit row.
import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import {
  CoreError,
  assertOutletInScope,
  createUlid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  edcBridgeDeviceSchema,
  type AssignEdcBridgeTerminalsInput,
  type CreateEdcBridgeDeviceInput,
  type EdcBridgeDeviceView,
  type IssuedEdcBridgeDevice,
} from "@starter/shared/edc/bridge-devices";
import { db } from "../db/index.ts";
import {
  edcBridgeDevices,
  paymentEdcTerminals,
  type EdcBridgeDeviceRow,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getCloudEdcRuntime,
  hashEdcBridgeToken,
} from "../edge/edc/cloud-runtime.ts";
import { recordAudit } from "./core-audit.ts";
import { assertPaymentPermission } from "./payment-support.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const notFound = () =>
  new CoreError("NOT_FOUND", "Perangkat jembatan EDC tidak ditemukan.");

async function authorize(
  tx: Tx,
  ctx: ScopedTenantContext,
  actor: string,
  outletId: string,
) {
  assertOutletInScope(ctx.outletScope, outletId);
  await assertPaymentPermission(
    tx,
    ctx,
    actor,
    "payment.edc.manage",
    { type: "outlet", id: outletId },
    new Date(),
  );
}

async function audit(
  tx: Tx,
  ctx: ScopedTenantContext,
  actor: string,
  outletId: string,
  action: string,
  deviceId: string,
  after: Record<string, string | number | boolean | null | string[]>,
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
      action,
      objectType: "edc_bridge_device",
      objectId: deviceId,
      reason: null,
      maskedChanges: { before: null, after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    Object.keys(after),
  );
}

async function terminalIdsOf(
  tx: Tx,
  ctx: ScopedTenantContext,
  deviceIds: readonly string[],
) {
  if (deviceIds.length === 0) return new Map<string, string[]>();
  const rows = await tx
    .select({
      id: paymentEdcTerminals.id,
      deviceId: paymentEdcTerminals.bridgeDeviceId,
    })
    .from(paymentEdcTerminals)
    .where(
      and(
        eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
        inArray(paymentEdcTerminals.bridgeDeviceId, [...deviceIds]),
      ),
    )
    .orderBy(asc(paymentEdcTerminals.id));
  const byDevice = new Map<string, string[]>();
  for (const row of rows)
    if (row.deviceId)
      byDevice.set(row.deviceId, [
        ...(byDevice.get(row.deviceId) ?? []),
        row.id,
      ]);
  return byDevice;
}

function view(
  row: EdcBridgeDeviceRow,
  terminalIds: string[],
): EdcBridgeDeviceView {
  return edcBridgeDeviceSchema.parse({
    id: row.id,
    outletId: row.outletId,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    terminalIds,
  });
}

async function loadDevice(
  tx: Tx,
  ctx: ScopedTenantContext,
  actor: string,
  deviceId: string,
) {
  const [row] = await tx
    .select()
    .from(edcBridgeDevices)
    .where(
      and(
        eq(edcBridgeDevices.tenantId, ctx.tenant.tenantId),
        eq(edcBridgeDevices.id, deviceId),
      ),
    )
    .limit(1);
  if (!row) throw notFound();
  await authorize(tx, ctx, actor, row.outletId);
  return row;
}

export async function listEdcBridgeDevices(
  ctx: ScopedTenantContext,
  actor: string,
  outletId: OutletId,
): Promise<EdcBridgeDeviceView[]> {
  return withTenant(db, ctx, async (tx) => {
    await authorize(tx, ctx, actor, outletId);
    const rows = await tx
      .select()
      .from(edcBridgeDevices)
      .where(
        and(
          eq(edcBridgeDevices.tenantId, ctx.tenant.tenantId),
          eq(edcBridgeDevices.outletId, outletId),
        ),
      )
      .orderBy(asc(edcBridgeDevices.createdAt), asc(edcBridgeDevices.id));
    const terminals = await terminalIdsOf(
      tx,
      ctx,
      rows.map((row) => row.id),
    );
    return rows.map((row) => view(row, terminals.get(row.id) ?? []));
  });
}

export async function createEdcBridgeDevice(
  ctx: ScopedTenantContext,
  actor: string,
  input: CreateEdcBridgeDeviceInput,
): Promise<IssuedEdcBridgeDevice> {
  return withTenant(db, ctx, async (tx) => {
    await authorize(tx, ctx, actor, input.outletId);
    const id = createUlid();
    const token = `edcb_${id}_${randomBytes(32).toString("base64url")}`;
    const [row] = await tx
      .insert(edcBridgeDevices)
      .values({
        id,
        tenantId: ctx.tenant.tenantId,
        outletId: input.outletId,
        label: input.label,
        tokenHash: hashEdcBridgeToken(token),
        createdBy: actor,
      })
      .returning();
    if (!row) throw new Error("EDC bridge device insert returned no row");
    await audit(tx, ctx, actor, row.outletId, "edc_bridge_device.created", id, {
      label: row.label,
    });
    return { device: view(row, []), token };
  });
}

export async function revokeEdcBridgeDevice(
  ctx: ScopedTenantContext,
  actor: string,
  deviceId: string,
): Promise<EdcBridgeDeviceView> {
  const result = await withTenant(db, ctx, async (tx) => {
    const row = await loadDevice(tx, ctx, actor, deviceId);
    if (row.revokedAt !== null)
      return view(
        row,
        (await terminalIdsOf(tx, ctx, [row.id])).get(row.id) ?? [],
      );
    const [revoked] = await tx
      .update(edcBridgeDevices)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(edcBridgeDevices.tenantId, ctx.tenant.tenantId),
          eq(edcBridgeDevices.id, row.id),
          isNull(edcBridgeDevices.revokedAt),
        ),
      )
      .returning();
    if (!revoked) throw notFound();
    await audit(
      tx,
      ctx,
      actor,
      row.outletId,
      "edc_bridge_device.revoked",
      row.id,
      {
        revoked: true,
      },
    );
    return view(
      revoked,
      (await terminalIdsOf(tx, ctx, [row.id])).get(row.id) ?? [],
    );
  });
  // After commit: the live socket is told and closed. Another process sees
  // the revocation at its next lease renewal (<= 30 s).
  getCloudEdcRuntime()?.revoked(ctx.tenant.tenantId, result.id);
  return result;
}

export async function assignEdcBridgeTerminals(
  ctx: ScopedTenantContext,
  actor: string,
  deviceId: string,
  input: AssignEdcBridgeTerminalsInput,
): Promise<EdcBridgeDeviceView> {
  return withTenant(db, ctx, async (tx) => {
    const row = await loadDevice(tx, ctx, actor, deviceId);
    if (row.revokedAt !== null)
      throw new CoreError("CONFLICT", "Perangkat jembatan EDC sudah dicabut.");
    const ids = input.terminals.map((terminal) => terminal.terminalId);
    if (new Set(ids).size !== ids.length)
      throw new CoreError("VALIDATION_ERROR", "Terminal tercantum dua kali.");
    // Only active bridge terminals of the device's own outlet.
    const found =
      ids.length === 0
        ? []
        : await tx
            .select({
              id: paymentEdcTerminals.id,
              connection: paymentEdcTerminals.connection,
              connectionKind: paymentEdcTerminals.connectionKind,
            })
            .from(paymentEdcTerminals)
            .where(
              and(
                eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
                eq(paymentEdcTerminals.outletId, row.outletId),
                inArray(paymentEdcTerminals.id, ids),
              ),
            )
            .for("update");
    if (found.length !== ids.length)
      throw new CoreError(
        "NOT_FOUND",
        "Terminal EDC tidak ditemukan di outlet ini.",
      );
    for (const terminal of input.terminals) {
      const stored = found.find((entry) => entry.id === terminal.terminalId)!;
      const linkOk =
        stored.connection === "lan"
          ? terminal.linkPort !== null && terminal.linkBaudRate === null
          : stored.connection === "usb"
            ? terminal.linkBaudRate !== null && terminal.linkPort === null
            : false;
      if (stored.connectionKind !== "bridge" || !linkOk)
        throw new CoreError(
          "VALIDATION_ERROR",
          "Terminal ini tidak dapat dipakai lewat jembatan dengan pengaturan itu.",
        );
    }
    await tx
      .update(paymentEdcTerminals)
      .set({ bridgeDeviceId: null, updatedAt: new Date() })
      .where(
        and(
          eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
          eq(paymentEdcTerminals.bridgeDeviceId, row.id),
          ...(ids.length > 0 ? [notInArray(paymentEdcTerminals.id, ids)] : []),
        ),
      );
    for (const terminal of input.terminals)
      await tx
        .update(paymentEdcTerminals)
        .set({
          bridgeDeviceId: row.id,
          linkPort: terminal.linkPort,
          linkBaudRate: terminal.linkBaudRate,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
            eq(paymentEdcTerminals.id, terminal.terminalId),
          ),
        );
    await audit(
      tx,
      ctx,
      actor,
      row.outletId,
      "edc_bridge_device.terminals_assigned",
      row.id,
      { terminalIds: ids },
    );
    return view(row, [...ids].sort());
  });
}
