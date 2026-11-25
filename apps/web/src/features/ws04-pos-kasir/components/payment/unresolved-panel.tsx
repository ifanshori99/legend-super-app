import { RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useReplayPayment, type UnresolvedPayment } from "../../hooks";
import { Notice, PosPanel, StateBlock, StatusPill } from "../shared";

// A payment request of this bill has no known answer (1268 W2): the customer
// may already have paid, so every method is locked. The only way forward is to
// send the very same request again; the server records it once.
export function UnresolvedPanel({
  orderId,
  payment,
  onReload,
}: {
  orderId: string;
  payment: UnresolvedPayment;
  onReload: () => void;
}) {
  const t = useT();
  const replay = useReplayPayment();
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
          <Button type="button" variant="outline" onClick={onReload}>
            <RotateCw aria-hidden="true" />
            {t("posKasirPayment.unresolved.reload")}
          </Button>
          {mine && (
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
        title={t("posKasirPayment.unresolved.title")}
        description={t("posKasirPayment.unresolved.body")}
        aria-live="polite"
        className="py-4"
      >
        <div className="grid w-full max-w-3xl gap-3 text-left">
          {payment.status === "corrupt" ? (
            <Notice
              tone="danger"
              title={t("posKasirPayment.unresolved.corruptTitle")}
            >
              {t("posKasirPayment.unresolved.corruptBody")}
            </Notice>
          ) : (
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
          {replay.error != null && (
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
