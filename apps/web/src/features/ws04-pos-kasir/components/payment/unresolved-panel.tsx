import { useState } from "react";
import { RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/errors";
import type {
  useReplayPayment,
  useResolvePayment,
  UnresolvedPayment,
} from "../../hooks";
import { Notice, PosPanel, StateBlock, StatusPill } from "../shared";
import {
  EDC_APPROVAL_REQUIRED,
  EDC_SLIP_REF_USED,
} from "../../payment-intent-store";
import { ResolveDialog } from "./resolve-dialog";

const dialogKind = (payment: UnresolvedPayment) =>
  payment.status === "corrupt"
    ? ("corrupt" as const)
    : payment.status === "pending" && payment.kind === "edc_standalone"
      ? ("edc" as const)
      : ("other" as const);

const slipOf = (payment: UnresolvedPayment) =>
  payment.status === "pending" ? payment.slip : null;

export const cardMayBeCharged = (
  payment: UnresolvedPayment | null,
): payment is UnresolvedPayment =>
  payment !== null && dialogKind(payment) !== "other";

// A paid bill with an EDC slip it was not paid with (or a request that cannot be
// read and may be one): the card may be charged on top, until a supervisor says
// it was not or gives the number of the void on the machine.
export function PaidCardWarning({
  orderId,
  payment,
  resolve,
}: {
  orderId: string;
  payment: UnresolvedPayment;
  resolve: ReturnType<typeof useResolvePayment>;
}) {
  const t = useT();
  const [resolving, setResolving] = useState(false);
  return (
    <>
      <Notice
        tone="danger"
        title={t("posKasirPayment.unresolved.paidCardTitle")}
      >
        <div className="grid justify-items-start gap-3">
          <span>{t("posKasirPayment.unresolved.paidCardBody")}</span>
          <Button
            type="button"
            variant="outline"
            onClick={() => setResolving(true)}
          >
            {t("posKasirPayment.unresolved.resolve")}
          </Button>
        </div>
      </Notice>
      <ResolveDialog
        orderId={orderId}
        resolve={resolve}
        kind={dialogKind(payment)}
        slip={slipOf(payment)}
        paid
        open={resolving}
        onOpenChange={setResolving}
      />
    </>
  );
}

// A payment request of this bill has no known answer (1268 W2): the customer
// may already have paid, so every method is locked. The ways forward: send the
// very same request again (the server records it once), or a supervisor settles
// it with a PIN (the sender left, or the request cannot be read).
export function UnresolvedPanel({
  orderId,
  payment,
  replay,
  resolve,
  onReload,
}: {
  orderId: string;
  payment: UnresolvedPayment;
  /** Owned by the screen: their answers outlive this panel. */
  replay: ReturnType<typeof useReplayPayment>;
  resolve: ReturnType<typeof useResolvePayment>;
  onReload: () => void;
}) {
  const t = useT();
  const sending = payment.status === "sending";
  const [resolving, setResolving] = useState(false);
  const mine = payment.status === "pending" && payment.mine;
  const edc = dialogKind(payment) === "edc";
  // The approval of that slip is spent or too old: the same request is refused
  // every time, so only the supervisor's ways out are left.
  const spent =
    edc &&
    replay.error instanceof ApiError &&
    replay.error.code === EDC_APPROVAL_REQUIRED;
  // 1273: the slip number already paid a bill. The same request is refused
  // every time; only a supervisor can let it through.
  const slipUsed =
    edc &&
    ((payment.status === "pending" && payment.slipUsed) ||
      (replay.error instanceof ApiError &&
        replay.error.code === EDC_SLIP_REF_USED));
  return (
    <PosPanel
      title={t("posKasirPayment.unresolved.panelTitle")}
      aside={
        <StatusPill tone="warning">
          {t("posKasirPayment.unresolved.pill")}
        </StatusPill>
      }
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={sending}
            onClick={onReload}
          >
            <RotateCw aria-hidden="true" />
            {t("posKasirPayment.unresolved.reload")}
          </Button>
          {!sending && (
            <Button
              type="button"
              variant="outline"
              disabled={replay.isPending}
              onClick={() => setResolving(true)}
            >
              {t(
                slipUsed
                  ? "posKasirPayment.unresolved.askSupervisor"
                  : "posKasirPayment.unresolved.resolve",
              )}
            </Button>
          )}
          {((mine && !spent && !slipUsed) || (sending && replay.isPending)) && (
            <Button
              type="button"
              loading={replay.isPending}
              onClick={() => replay.mutate({ orderId })}
            >
              {replay.isPending
                ? t("posKasirPayment.unresolved.resending")
                : t("posKasirPayment.unresolved.resend")}
            </Button>
          )}
        </>
      }
    >
      <StateBlock
        title={t(
          sending
            ? "posKasirPayment.unresolved.sendingTitle"
            : "posKasirPayment.unresolved.title",
        )}
        description={t(
          sending
            ? "posKasirPayment.unresolved.sendingBody"
            : "posKasirPayment.unresolved.body",
        )}
        aria-live="polite"
        className="py-4"
      >
        <div className="grid w-full max-w-3xl gap-3 text-left">
          {payment.status === "corrupt" && (
            <Notice
              tone="danger"
              title={t("posKasirPayment.unresolved.corruptTitle")}
            >
              {t("posKasirPayment.unresolved.corruptBody")}
            </Notice>
          )}
          {payment.status === "pending" && (
            <Notice
              tone="warning"
              title={t("posKasirPayment.unresolved.noticeTitle")}
            >
              {t(
                edc
                  ? "posKasirPayment.unresolved.edcBody"
                  : "posKasirPayment.unresolved.noticeBody",
              )}
            </Notice>
          )}
          {slipUsed && (
            <Notice
              tone="danger"
              title={t("posKasirPayment.unresolved.slipUsedTitle")}
            >
              {t("posKasirPayment.unresolved.slipUsedBody")}
            </Notice>
          )}
          {payment.status === "pending" && !mine && (
            <Notice
              tone="info"
              title={t("posKasirPayment.unresolved.otherTitle")}
            >
              {t("posKasirPayment.unresolved.otherBody")}
            </Notice>
          )}
          {replay.error != null && !sending && !slipUsed && (
            <Notice
              tone="danger"
              title={t("posKasirPayment.unresolved.errorTitle")}
            >
              {replay.error.message}
            </Notice>
          )}
        </div>
      </StateBlock>
      {!sending && (
        <ResolveDialog
          orderId={orderId}
          resolve={resolve}
          kind={dialogKind(payment)}
          slip={slipOf(payment)}
          open={resolving}
          onOpenChange={setResolving}
        />
      )}
    </PosPanel>
  );
}
