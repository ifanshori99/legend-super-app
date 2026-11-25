import { RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import type { useReplayPayment, UnresolvedPayment } from "../../hooks";
import { Notice, PosPanel, StateBlock, StatusPill } from "../shared";

// A payment request of this bill has no known answer (1268 W2): the customer
// may already have paid, so every method is locked. The only way forward is to
// send the very same request again; the server records it once.
export function UnresolvedPanel({
  orderId,
  payment,
  replay,
  onReload,
}: {
  orderId: string;
  payment: UnresolvedPayment;
  /** Owned by the screen: its answer outlives this panel. */
  replay: ReturnType<typeof useReplayPayment>;
  onReload: () => void;
}) {
  const t = useT();
  const sending = payment.status === "sending";
  const mine = payment.status === "pending" && payment.mine;
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
          {(mine || (sending && replay.isPending)) && (
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
              {t("posKasirPayment.unresolved.noticeBody")}
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
          {replay.error != null && !sending && (
            <Notice
              tone="danger"
              title={t("posKasirPayment.unresolved.errorTitle")}
            >
              {replay.error.message}
            </Notice>
          )}
        </div>
      </StateBlock>
    </PosPanel>
  );
}
