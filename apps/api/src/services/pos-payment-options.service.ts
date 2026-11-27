// POS payment options (1268 B2): which methods the cashier may use now and the
// outlet's active EDC terminals. Presentation only: every tender is checked
// again when it is added (pos-order-payment.ts). A failed read is "no".
//
// - 1269 C3a: VA and e-wallet are on only on the cloud, where the method's
//   routing selects Duitku and Duitku lists the method (DUITKU_ENABLED_METHODS)
//   with at least one channel; the channels are listed for the cashier's pick.
//   Online card stays locked (no chargeback procedure or journal yet).
// - ECR (1269 E7) is on only where this process runs the outlet's EDC agent
//   (edge, or B2 the cloud agent with a live bridge lease on the terminal)
//   and an active terminal's bank has an adapter; otherwise EDC is keyed by
//   hand with a supervisor approval (EDC-04). Production has no adapter until
//   legend-vpx, so ECR stays locked there.
// - Nothing secret leaves: no merchant id, address, full terminal id, gateway
//   name or credential.
// - 1272 K4 (design duitku-fee-passthrough §3, §7): with `orderId` each VA /
//   e-wallet channel carries the guest service fee on top of the order's
//   remaining bill and the total the guest pays, priced by the gateway's own
//   schedule (the gross-up the create call recomputes; it never reads this
//   quote). A channel without a usable rate is left out, never shown at fee
//   0; a method left without channels is off. Every other enabled method
//   carries fee 0 and the remaining bill. Without an order: no fee fields.

import { and, asc, eq } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { PAYMENT_GATEWAY_PROVIDERS } from "@starter/shared/platform";
import {
  POS_PAYMENT_OPTION_METHODS,
  posPaymentOptionsSchema,
  type PosPaymentChannel,
  type PosPaymentOptions,
  type PosPaymentUnavailableReason,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { paymentEdcTerminals } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { prepareEdcAgent, resolveEdcAgent } from "../edge/edc/resolver.ts";
import { logger } from "../lib/logger.ts";
import { NO_GUEST_FEE } from "./payment-gateway.ts";
import { priceForGuest } from "./payment-guest-fee.ts";
import { selectGatewayForNewIntent } from "./payment-gateway-select.ts";
import {
  resolveRoutingRule,
  type ResolvedRouting,
} from "./payment-routing.service.ts";
import {
  edgeHasGatewayCredentials,
  isEdgeProcess,
} from "./pos-order-payment.ts";
import {
  loadOutlet,
  readPosOrder,
  remainingIdr,
  tendersOf,
} from "./pos-order-support.ts";

type Reason = PosPaymentUnavailableReason | null;

async function qrisReason(
  context: ScopedTenantContext,
  outletId: OutletId,
  routing: ResolvedRouting,
): Promise<Reason> {
  if (!routing.enabled) return "routing_disabled";
  try {
    // D-09: same gate as the QRIS tender on an edge node.
    if (
      isEdgeProcess() &&
      !(await edgeHasGatewayCredentials(context, outletId))
    )
      return "needs_cloud";
    const selected = await selectGatewayForNewIntent(
      context,
      outletId,
      routing,
    );
    if (
      selected.provider === null ||
      !PAYMENT_GATEWAY_PROVIDERS.some((code) => code === selected.provider)
    )
      return "gateway_down";
    // A gateway without `methods()` offers QRIS (qr-order-payment.ts).
    const listed = await selected.port.methods?.(context, outletId);
    return listed === undefined ||
      listed.some((entry) => entry.method === "qris" && entry.enabled)
      ? null
      : "routing_disabled";
  } catch (error) {
    logger.warn({ err: error, outletId }, "POS QRIS availability read failed");
    return "gateway_down";
  }
}

/** 1269 C3a: why a cashier VA / e-wallet is off, else its channels. */
async function onlineCodeOption(
  context: ScopedTenantContext,
  outletId: OutletId,
  method: "va" | "ewallet",
  routing: ResolvedRouting,
  baseIdr: number | null,
): Promise<{ reason: Reason; channels: PosPaymentChannel[] }> {
  const off = (reason: PosPaymentUnavailableReason) => ({
    reason,
    channels: [],
  });
  // Cloud only (founder no. 31): an edge process never issues these codes.
  if (isEdgeProcess()) return off("needs_cloud");
  if (!routing.enabled) return off("routing_disabled");
  try {
    const selected = await selectGatewayForNewIntent(
      context,
      outletId,
      routing,
    );
    if (selected.provider === null) return off("gateway_down");
    if (selected.provider !== "duitku") return off("not_supported");
    const listed = await selected.port.methods?.(context, outletId);
    const entry = listed?.find((row) => row.method === method && row.enabled);
    if (!entry || entry.channels.length === 0) return off("routing_disabled");
    if (baseIdr === null)
      return { reason: null, channels: [...entry.channels] };
    // 1272 K4: priced for the order; a channel without a rate is left out.
    const schedule = selected.port.guestFeeSchedule
      ? await selected.port.guestFeeSchedule(context, outletId)
      : NO_GUEST_FEE;
    const priced: PosPaymentChannel[] = [];
    for (const channel of entry.channels) {
      const price = priceForGuest(schedule, method, channel.code, baseIdr);
      if (price) priced.push({ ...channel, ...price });
    }
    return priced.length === 0
      ? off("routing_disabled")
      : { reason: null, channels: priced };
  } catch (error) {
    logger.warn(
      { err: error, outletId, method },
      "POS online code availability read failed",
    );
    return off("gateway_down");
  }
}

export async function getPosPaymentOptions(
  context: ScopedTenantContext,
  outletId: OutletId,
  caller: { deviceId: string | null },
  orderId?: string,
): Promise<PosPaymentOptions> {
  const { routing, vaRouting, ewalletRouting, terminals, baseIdr } =
    await withTenant(db, context, async (tx) => {
      await loadOutlet(tx, context, outletId);
      // 1272 K4: the bill a tender would take now (an online code takes the
      // whole remaining balance); 404 for an order of another outlet.
      let base: number | null = null;
      if (orderId !== undefined) {
        const { order } = await readPosOrder(tx, context, outletId, orderId);
        base = remainingIdr(order, await tendersOf(tx, context, order.id));
      }
      return {
        baseIdr: base,
        routing: await resolveRoutingRule(tx, context, outletId, "qris"),
        vaRouting: await resolveRoutingRule(tx, context, outletId, "va"),
        ewalletRouting: await resolveRoutingRule(
          tx,
          context,
          outletId,
          "ewallet",
        ),
        terminals: await tx
          .select()
          .from(paymentEdcTerminals)
          .where(
            and(
              eq(paymentEdcTerminals.tenantId, context.tenant.tenantId),
              eq(paymentEdcTerminals.outletId, outletId),
              eq(paymentEdcTerminals.status, "active"),
            ),
          )
          .orderBy(
            asc(paymentEdcTerminals.bankCode),
            asc(paymentEdcTerminals.id),
          ),
      };
    });
  const edc = (method: "card" | "qris"): Reason =>
    terminals.some((row) => row.supportedMethods.includes(method))
      ? null
      : "no_terminal";
  const va = await onlineCodeOption(
    context,
    outletId,
    "va",
    vaRouting,
    baseIdr,
  );
  const ewallet = await onlineCodeOption(
    context,
    outletId,
    "ewallet",
    ewalletRouting,
    baseIdr,
  );
  const channels: Partial<
    Record<(typeof POS_PAYMENT_OPTION_METHODS)[number], PosPaymentChannel[]>
  > = { va: va.channels, ewallet: ewallet.channels };
  const reasons: Record<(typeof POS_PAYMENT_OPTION_METHODS)[number], Reason> = {
    // Cash books on the open shift of this device (pos-cash-guard.ts).
    cash: caller.deviceId === null ? "device_required" : null,
    qris: await qrisReason(context, outletId, routing),
    va: va.reason,
    ewallet: ewallet.reason,
    card: "not_supported",
    edc_card: edc("card"),
    edc_qris: edc("qris"),
  };
  await prepareEdcAgent(context.tenant.tenantId, outletId, terminals);
  const resolved = resolveEdcAgent(context.tenant.tenantId, outletId);
  const ecrEnabled =
    resolved !== null && terminals.some((row) => resolved.terminalReady(row));
  return posPaymentOptionsSchema.parse({
    outletId,
    methods: POS_PAYMENT_OPTION_METHODS.map((method) => ({
      method,
      enabled: reasons[method] === null,
      unavailableReason: reasons[method],
      // Only an enabled VA / e-wallet lists channels (absent otherwise).
      ...(channels[method]?.length ? { channels: channels[method] } : {}),
      // 1272 K4: no fee on cash, QRIS (design §5) or EDC; the channels of a
      // VA / e-wallet carry their own.
      ...(baseIdr !== null &&
      reasons[method] === null &&
      method !== "va" &&
      method !== "ewallet"
        ? { guestFeeIdr: 0, totalIdr: baseIdr }
        : {}),
    })),
    edc: {
      ecrEnabled,
      terminals: terminals.map((row) => ({
        id: row.id,
        bankCode: row.bankCode,
        model: row.model,
        // A short id would show whole.
        terminalIdLast4:
          row.terminalId.length > 4 ? row.terminalId.slice(-4) : "****",
        supportedMethods: row.supportedMethods,
      })),
    },
  });
}
