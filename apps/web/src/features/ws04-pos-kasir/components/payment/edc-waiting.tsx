import { Check } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useCancelAttempt } from "../../hooks";
import type { PaymentAttempt, PaymentBill } from "../../types";
import { Notice, PosPanel } from "../shared";
import { EdcLayout, useEdcErrorText } from "./edc-side";

type EdcAttempt = PaymentAttempt & { edc: NonNullable<PaymentAttempt["edc"]> };

function Step({
  index,
  done = false,
  title,
  children,
}: {
  index: number;
  done?: boolean;
  title: string;
  children: string;
}) {
  return (
    <li className="flex items-start gap-3 border-b-(length:--border-w) border-border py-3 first:border-t-(length:--border-w)">
      <span
        className={
          done
            ? "grid size-8 shrink-0 place-items-center rounded-full border-2 border-success text-success"
            : "tabular grid size-8 shrink-0 place-items-center rounded-full border-2 border-border font-semibold"
        }
      >
        {done ? <Check className="size-5" aria-hidden="true" /> : index}
      </span>
      <div className="grid gap-0.5">
        <p className="text-(length:--density-text) font-semibold">{title}</p>
        <p className="tabular text-base text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

// The request is with the machine: amount and terminal are locked, nothing else
// can start, and the result arrives by itself (the session polls).
export function EdcWaiting({
  orderId,
  bill,
  attempt,
}: {
  orderId: string;
  bill: PaymentBill;
  attempt: EdcAttempt;
}) {
  const t = useT();
  const errorText = useEdcErrorText();
  const cancel = useCancelAttempt();
  return (
    <EdcLayout
      title={t("posKasirEdc.heading.waiting")}
      bill={bill}
      headPill={{ tone: "warning", label: t("posKasirEdc.pill.waiting") }}
      sideLabel={t("posKasirEdc.side.sent")}
      sideAmountIdr={attempt.edc.lockedAmountIdr}
      sidePill={{ tone: "neutral", label: t("posKasirEdc.side.locked") }}
      sideTerminal={{
        title: attempt.edc.terminalLabel,
        detail: `${t(`posKasirEdc.side.mode.${attempt.edc.mode}`)} · ${t("posKasirEdc.side.connected")}`,
      }}
      sideNote={t("posKasirEdc.side.lockedNote")}
    >
      <PosPanel
        title={t("posKasirEdc.waiting.title")}
        footer={
          <Button
            type="button"
            variant="outline"
            loading={cancel.isPending}
            onClick={() =>
              cancel.mutate({ orderId, attemptId: attempt.id, method: "edc" })
            }
          >
            {t("posKasirEdc.waiting.cancel")}
          </Button>
        }
      >
        <div className="grid gap-4">
          <p className="text-(length:--density-text) text-muted-foreground">
            {t("posKasirEdc.waiting.subtitle")}
          </p>
          <div aria-live="polite">
            <ol>
              <Step index={1} done title={t("posKasirEdc.waiting.stepSent")}>
                {t("posKasirEdc.waiting.stepSentBody", {
                  amount: formatRupiah(attempt.edc.lockedAmountIdr),
                  ref: attempt.posRef ?? "-",
                })}
              </Step>
              <Step index={2} title={t("posKasirEdc.waiting.stepFollow")}>
                {t(
                  attempt.edc.mode === "qris"
                    ? "posKasirEdc.waiting.stepFollowQris"
                    : "posKasirEdc.waiting.stepFollowCard",
                )}
              </Step>
              <Step index={3} title={t("posKasirEdc.waiting.stepWait")}>
                {t("posKasirEdc.waiting.stepWaitBody")}
              </Step>
            </ol>
          </div>
          <Notice tone="info" title={t("posKasirEdc.waiting.noSecondTitle")}>
            {t("posKasirEdc.waiting.noSecondBody")}
          </Notice>
          {cancel.error && (
            <Notice tone="danger" title={t("posKasirEdc.waiting.cancelError")}>
              {errorText(cancel.error)}
            </Notice>
          )}
          <p className="text-base text-muted-foreground">
            {t("posKasirEdc.waiting.cancelNote")}
          </p>
        </div>
      </PosPanel>
    </EdcLayout>
  );
}
