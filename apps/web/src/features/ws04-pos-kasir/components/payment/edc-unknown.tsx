import { TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useCheckPaymentStatus } from "../../hooks";
import type { PaymentAttempt, PaymentBill } from "../../types";
import { Notice, PosPanel } from "../shared";
import { EdcLayout, useEdcErrorText } from "./edc-side";

type EdcAttempt = PaymentAttempt & { edc: NonNullable<PaymentAttempt["edc"]> };

function Step({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: string;
}) {
  return (
    <li className="flex items-start gap-3 border-b-(length:--border-w) border-border py-3">
      <span className="tabular grid size-8 shrink-0 place-items-center rounded-full border-2 border-border font-semibold">
        {index}
      </span>
      <div className="grid gap-0.5">
        <p className="text-(length:--density-text) font-semibold">{title}</p>
        <p className="text-base text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

// The machine did not answer. The customer may already be charged, so the only
// way forward is "Cek status": retry, another method and standalone stay out of
// reach until the result is certain.
export function EdcUnknown({
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
  const check = useCheckPaymentStatus();
  const stillUnknown = check.isSuccess && !check.isPending;
  return (
    <EdcLayout
      title={t("posKasirEdc.heading.unknown")}
      bill={bill}
      headPill={{
        tone: "warning",
        icon: TriangleAlert,
        label: t("posKasirEdc.pill.unknown"),
      }}
      sideLabel={t("posKasirEdc.side.transaction")}
      sideAmountIdr={attempt.edc.lockedAmountIdr}
      sidePill={{ tone: "neutral", label: t("posKasirEdc.side.locked") }}
      sideTerminal={{
        title: attempt.edc.terminalLabel,
        detail: `${t(`posKasirEdc.side.mode.${attempt.edc.mode}`)} · ${t("posKasirEdc.side.lost")}`,
      }}
      sideNote={t("posKasirEdc.side.unknownNote")}
    >
      <PosPanel
        title={t("posKasirEdc.unknown.title")}
        footer={
          <>
            <Button type="button" variant="secondary" disabled>
              {t("posKasirEdc.unknown.retryLocked")}
            </Button>
            <Button
              type="button"
              loading={check.isPending}
              onClick={() => check.mutate({ orderId, attemptId: attempt.id })}
            >
              {t("posKasirEdc.unknown.check")}
            </Button>
            <p className="basis-full text-left text-base text-muted-foreground">
              {t("posKasirEdc.unknown.footnote")}
            </p>
          </>
        }
      >
        <div className="grid gap-4">
          <p className="text-(length:--density-text) text-muted-foreground">
            {t("posKasirEdc.unknown.subtitle")}
          </p>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-base text-muted-foreground">
                {t("posKasirEdc.unknown.reference")}
              </dt>
              <dd className="tabular text-(length:--density-text) font-semibold">
                {attempt.posRef ?? "-"}
              </dd>
            </div>
            <div>
              <dt className="text-base text-muted-foreground">
                {t("posKasirEdc.unknown.posStatus")}
              </dt>
              <dd className="text-(length:--density-text) font-semibold">
                {t("posKasirEdc.unknown.posStatusValue")}
              </dd>
            </div>
          </dl>
          <Notice tone="warning" title={t("posKasirEdc.unknown.checkTitle")}>
            {t("posKasirEdc.unknown.checkBody")}
          </Notice>
          <ol>
            <Step index={1} title={t("posKasirEdc.unknown.stepOne")}>
              {t("posKasirEdc.unknown.stepOneBody")}
            </Step>
            <Step index={2} title={t("posKasirEdc.unknown.stepTwo")}>
              {t("posKasirEdc.unknown.stepTwoBody")}
            </Step>
          </ol>
          <div aria-live="polite">
            {stillUnknown && (
              <Notice tone="info" title={t("posKasirEdc.unknown.stillTitle")}>
                {t("posKasirEdc.unknown.stillBody")}
              </Notice>
            )}
          </div>
          {check.error && (
            <Notice tone="danger" title={t("posKasirEdc.unknown.checkError")}>
              {errorText(check.error)}
            </Notice>
          )}
        </div>
      </PosPanel>
    </EdcLayout>
  );
}
