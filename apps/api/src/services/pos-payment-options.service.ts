// POS payment options (1268 B2): which methods the cashier may use now and the
// outlet's active EDC terminals. Presentation only: every tender is checked
// again when it is added (pos-order-payment.ts). A failed read is "no".
//
// - 1269 C3a: VA and e-wallet are on only on the cloud, where the method's
//   routing selects Duitku and Duitku lists the method (DUITKU_ENABLED_METHODS)
//   with at least one channel; the channels are listed for the cashier's pick.
//   Online card stays locked (no chargeback procedure or journal yet).
// - ECR (1269 E7) is on only where this process runs the outlet's EDC agent
//   and an active terminal's bank has an adapter; otherwise EDC is keyed by
//   hand with a supervisor approval (EDC-04). Production has no adapter until
//   legend-vpx, so ECR stays locked there.
// - Nothing secret leaves: no merchant id, address, full terminal id, gateway
//   name or credential.

import { and, asc, eq } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import type { PaymentChannel } from "@starter/shared/payment";
import { PAYMENT_GATEWAY_PROVIDERS } from "@starter/shared/platform";
import {
  POS_PAYMENT_OPTION_METHODS,
  posPaymentOptionsSchema,
  type PosPaymentOptions,
  type PosPaymentUnavailableReason,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { paymentEdcTerminals } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeEdcAgent } from "../edge/edc/runtime.ts";
import { logger } from "../lib/logger.ts";
import { selectGatewayForNewIntent } from "./payment-gateway-select.ts";
import {
  resolveRoutingRule,
  type ResolvedRouting,
} from "./payment-routing.service.ts";
import {
  edgeHasGatewayCredentials,
  isEdgeProcess,
} from "./pos-order-payment.ts";
import { loadOutlet } from "./pos-order-support.ts";

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
): Promise<{ reason: Reason; channels: PaymentChannel[] }> {
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
    return { reason: null, channels: [...entry.channels] };
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
): Promise<PosPaymentOptions> {
  const { routing, vaRouting, ewalletRouting, terminals } = await withTenant(
    db,
    context,
    async (tx) => {
    await loadOutlet(tx, context, outletId);
    return {
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
    },
  );
  const edc = (method: "card" | "qris"): Reason =>
    terminals.some((row) => row.supportedMethods.includes(method))
      ? null
      : "no_terminal";
  const va = await onlineCodeOption(context, outletId, "va", vaRouting);
  const ewallet = await onlineCodeOption(
    context,
    outletId,
    "ewallet",
    ewalletRouting,
  );
  const channels: Partial<
    Record<(typeof POS_PAYMENT_OPTION_METHODS)[number], PaymentChannel[]>
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
  const agent = getEdgeEdcAgent();
  const ecrEnabled =
    agent !== null &&
    terminals.some((row) =>
      agent.canSell(context.tenant.tenantId, outletId, row.bankCode),
    );
  return posPaymentOptionsSchema.parse({
    outletId,
    methods: POS_PAYMENT_OPTION_METHODS.map((method) => ({
      method,
      enabled: reasons[method] === null,
      unavailableReason: reasons[method],
      // Only an enabled VA / e-wallet lists channels (absent otherwise).
      ...(channels[method]?.length ? { channels: channels[method] } : {}),
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
