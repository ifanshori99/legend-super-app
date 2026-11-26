import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChefHat, RotateCw } from "lucide-react";
import type { PosOrderDetail } from "@starter/shared/pos";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import { canFire, heldItemIds, primaryActionOf } from "../fire";
import { useFireHeld, useOrderActionRights, usePendingFire } from "../hooks";

type Order = Pick<PosOrderDetail, "id" | "number" | "status" | "items">;

export type OrderActionsState = ReturnType<typeof useOrderActions>;

/**
 * The fire flow of one order (brief 1268 W5, mockup screens detail,
 * konfirmasi, terkirim and belum-pasti): held lines go to the kitchen after a
 * confirmation; an unknown answer locks the screen on "Periksa lagi", which
 * repeats the stored request (same key, same ids, same status).
 */
export function useOrderActions(order: Order) {
  const pending = usePendingFire(order.id);
  const [confirming, setConfirming] = useState(false);
  const [sentCount, setSentCount] = useState<number | null>(null);
  const fire = useFireHeld(order.id, pending.refresh);
  const held = heldItemIds(order.items);
  const unclear = pending.itemIds !== null;
  const rights = useOrderActionRights();
  // Fire only with the route's permission (pos.sale.create or order.create).
  const fireable = rights.fire && canFire(order.status, held.length);

  function send(itemIds: readonly string[]) {
    setSentCount(null);
    fire.mutate(
      { itemIds, status: order.status },
      {
        onSuccess: () => {
          setConfirming(false);
          setSentCount(itemIds.length);
        },
        onError: () => setConfirming(false),
      },
    );
  }

  return {
    held,
    rights,
    unclear,
    fireable,
    confirming,
    sentCount,
    sending: fire.isPending,
    // A final refusal (the key is closed) shows the server's reason.
    refusal: !unclear && fire.isError ? fire.error : null,
    openConfirm: () => setConfirming(true),
    closeConfirm: () => setConfirming(false),
    confirm: () => send(held),
    replay: () => pending.itemIds && send(pending.itemIds),
  };
}

/** The notice above the order: sent, unclear, or refused. */
export function FireNotice({ state }: { state: OrderActionsState }) {
  const t = useT();
  if (state.unclear)
    return (
      <Notice
        tone="warning"
        role="alert"
        title={t("posOrderDetail.fire.unclearTitle")}
      >
        <p>{t("posOrderDetail.fire.unclearHint")}</p>
      </Notice>
    );
  if (state.refusal)
    return (
      <Notice tone="danger" title={t("posOrderDetail.fire.errorTitle")}>
        <p>{state.refusal.message}</p>
      </Notice>
    );
  if (state.sentCount !== null)
    return (
      <Notice
        tone="info"
        role="status"
        title={t("posOrderDetail.fire.sentTitle", { count: state.sentCount })}
      />
    );
  return null;
}

function PayLink({
  orderId,
  remainingIdr,
  primary,
  className,
}: {
  orderId: string;
  remainingIdr: number;
  primary: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <Button
      asChild
      size="lg"
      variant={primary ? "default" : "outline"}
      className={className}
    >
      <Link to="/pos/bayar/$orderId" params={{ orderId }}>
        {remainingIdr === 0
          ? t("posOrderDetail.pay.finish")
          : t("posOrderDetail.pay.action")}
      </Link>
    </Button>
  );
}

/**
 * The screen's one primary action, chosen by `primaryActionOf` (../fire.ts).
 */
export function PrimaryAction({
  state,
  order,
  remainingIdr,
  className,
}: {
  state: OrderActionsState;
  order: Order;
  remainingIdr: number;
  className?: string;
}) {
  const t = useT();
  const kind = primaryActionOf({
    unclear: state.unclear,
    fireable: state.fireable,
    status: order.status,
    rights: state.rights,
  });
  if (kind === "retry")
    return (
      <Button
        size="lg"
        className={className}
        loading={state.sending}
        onClick={state.replay}
      >
        <RotateCw aria-hidden="true" />
        {t("posOrderDetail.fire.retry")}
      </Button>
    );
  if (kind === "fire")
    return (
      <Button size="lg" className={className} onClick={state.openConfirm}>
        <ChefHat aria-hidden="true" />
        {t("posOrderDetail.fire.action")}
      </Button>
    );
  // A draft is not on the shift yet: it is sent from the cashier, never paid
  // from here (CTO 26 Nov, review W5 no. 3).
  if (kind === "cashier")
    return (
      <Button asChild size="lg" className={className}>
        <Link to="/pos/kasir">{t("posOrderDetail.pay.continueAtCashier")}</Link>
      </Button>
    );
  if (kind === "pay")
    return (
      <PayLink
        orderId={order.id}
        remainingIdr={remainingIdr}
        primary
        className={className}
      />
    );
  return null;
}

/** Payment as the quieter action while items still wait for the kitchen. */
export function SecondaryPay({
  state,
  order,
  remainingIdr,
}: {
  state: OrderActionsState;
  order: Order;
  remainingIdr: number;
}) {
  if (state.unclear || !state.fireable || !state.rights.pay) return null;
  return (
    <PayLink
      orderId={order.id}
      remainingIdr={remainingIdr}
      primary={false}
      className="w-full"
    />
  );
}

export function FireConfirmDialog({
  state,
  order,
}: {
  state: OrderActionsState;
  order: Order;
}) {
  const t = useT();
  const held = new Set(state.held);
  const lines = order.items.filter((item) => held.has(item.id));
  const count = lines.length;
  return (
    <Dialog
      open={state.confirming}
      onOpenChange={(open) => !open && !state.sending && state.closeConfirm()}
    >
      <DialogContent data-density="kontras">
        <DialogHeader>
          <DialogTitle>
            {t("posOrderDetail.fire.confirmTitle", { count })}
          </DialogTitle>
          <DialogDescription>
            {t("posOrderDetail.fire.confirmHint", { number: order.number })}
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-border border-y border-border">
          {lines.map((line) => (
            <li
              key={line.id}
              className="flex items-center justify-between gap-3 py-3"
            >
              <span className="font-semibold break-words">{line.name}</span>
              <span className="shrink-0 tabular-nums">{line.quantity} ×</span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button
            variant="outline"
            size="lg"
            disabled={state.sending}
            onClick={state.closeConfirm}
          >
            {t("posOrderDetail.fire.back")}
          </Button>
          <Button size="lg" loading={state.sending} onClick={state.confirm}>
            <ChefHat aria-hidden="true" />
            {t("posOrderDetail.fire.confirm", { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The detail counts less paid than the list: show the list's figure. */
export function OldLinkNotice({ remainingIdr }: { remainingIdr: number }) {
  const t = useT();
  return (
    <Notice tone="warning" title={t("posOrderDetail.oldLink.title")}>
      <p>
        {t("posOrderDetail.oldLink.hint", {
          amount: formatRupiah(remainingIdr),
        })}
      </p>
    </Notice>
  );
}
