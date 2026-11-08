// Failed item recovery page (PRD §3 F10 "Pemulihan Item Gagal", §4 flow A
// step 8, ORD-08). The guest chooses "Ganti menu" or "Kredit ke voucher";
// nothing else is offered, and staff notes and costs are never shown.
import { Link } from "@tanstack/react-router";
import { Check, CircleCheck, Info, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useTableJourney } from "@/features/ws03-qr-order/context";
import {
  useChooseIssueResolution,
  useOrderIssues,
} from "@/features/ws03-qr-order/hooks";
import { useOnline } from "@/lib/use-online";
import type { GuestOrderIssue } from "@starter/shared/qr-order";
import { QrSubPage } from "../session-states";
import { IssueChoices } from "./issue-choices";
import { VoucherReceipt } from "./voucher-receipt";

function IssueSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-4">
      <span className="sr-only">{t("common.loading")}</span>
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-20 w-full rounded-qr-media" />
      <Skeleton className="h-24 w-full rounded-qr-media" />
      <Skeleton className="h-24 w-full rounded-qr-media" />
      <Skeleton className="h-14 w-full rounded-qr-float" />
    </div>
  );
}

function ResolvedNotice({
  children,
  icon: Icon = CircleCheck,
}: {
  children: React.ReactNode;
  icon?: typeof CircleCheck;
}) {
  return (
    <p className="flex items-start gap-2 font-semibold">
      <Icon
        className="mt-0.5 size-icon shrink-0 text-success"
        aria-hidden="true"
      />
      <span>{children}</span>
    </p>
  );
}

function Resolved({
  issue,
  token,
  timeZone,
}: {
  issue: GuestOrderIssue;
  token: string;
  timeZone: string | undefined;
}) {
  const t = useT();

  if (issue.status === "cancelled")
    return (
      <p className="qr-paper flex items-start gap-2 p-4 text-muted-foreground">
        <Info className="mt-0.5 size-icon shrink-0" aria-hidden="true" />
        {t("qrRecovery.issue.resolved.cancelled")}
      </p>
    );

  if (issue.resolution === "swap" && issue.replacementItemName) {
    const difference = issue.priceDifferenceIdr ?? 0;
    return (
      <section className="qr-paper grid gap-3 p-4">
        <ResolvedNotice>
          {t("qrRecovery.issue.resolved.swapTitle", {
            name: issue.replacementItemName,
          })}
        </ResolvedNotice>
        <p className="text-sm text-muted-foreground">
          {difference === 0 ? (
            t("qrRecovery.issue.choices.swap.diffEven")
          ) : (
            <>
              {difference > 0
                ? t("qrRecovery.issue.choices.swap.diffPay")
                : t("qrRecovery.issue.choices.swap.diffCredit")}{" "}
              <Money amount={Math.abs(difference)} size="sm" />
            </>
          )}
        </p>
        {difference > 0 && (
          <Button asChild>
            <Link to="/t/$token/bill" params={{ token }}>
              {t("qrRecovery.issue.resolved.payBill")}
            </Link>
          </Button>
        )}
      </section>
    );
  }

  if (issue.resolution === "voucher" && issue.voucher)
    return <VoucherReceipt voucher={issue.voucher} timeZone={timeZone} />;

  return (
    <div className="qr-paper p-4">
      <ResolvedNotice>{t("qrRecovery.issue.resolved.byStaff")}</ResolvedNotice>
    </div>
  );
}

export function IssuePage({ issueId }: { issueId: string }) {
  const t = useT();
  const online = useOnline();
  const journey = useTableJourney();
  const { qrToken, guest, sessionId, menu } = journey;
  const issues = useOrderIssues(sessionId);
  const choose = useChooseIssueResolution(sessionId ?? "none");
  const title = t("qrRecovery.issue.title");

  if (guest === null)
    return (
      <QrSubPage title={title}>
        <EmptyState
          className="qr-paper"
          title={t("qrRecovery.issue.notJoined.title")}
          description={t("qrRecovery.issue.notJoined.hint")}
          action={
            <Button type="button" onClick={() => journey.openJoin()}>
              {t("qrRecovery.issue.notJoined.action")}
            </Button>
          }
        />
      </QrSubPage>
    );

  const list = issues.data?.data;
  if (!list) {
    if (issues.isError)
      return (
        <QrSubPage title={title}>
          <ErrorState
            className="qr-paper"
            title={t("qrRecovery.issue.error.title")}
            description={t("qrRecovery.issue.error.hint")}
            onRetry={() => void issues.refetch()}
          />
        </QrSubPage>
      );
    return (
      <QrSubPage title={title}>
        <IssueSkeleton />
      </QrSubPage>
    );
  }

  const issue = list.find((entry) => entry.id === issueId);
  if (!issue)
    return (
      <QrSubPage title={title}>
        <EmptyState
          className="qr-paper"
          title={t("qrRecovery.issue.notFound.title")}
          description={t("qrRecovery.issue.notFound.hint")}
          action={
            <Button asChild>
              <Link to="/t/$token/orders" params={{ token: qrToken }}>
                {t("qrRecovery.issue.notFound.action")}
              </Link>
            </Button>
          }
        />
      </QrSubPage>
    );

  return (
    <QrSubPage title={title}>
      {issue.status === "open" && (
        <p className="px-1 leading-6 text-muted-foreground">
          {t("qrRecovery.issue.apology")}
        </p>
      )}

      {!online && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-qr-media bg-surface-2 p-3 text-sm leading-5"
        >
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("qrRecovery.issue.offline")}
        </p>
      )}

      <section className="qr-paper flex items-start justify-between gap-3 p-4">
        <div className="grid min-w-0 gap-1">
          <p className="font-semibold">
            {t("qrRecovery.issue.itemLine", {
              name: issue.itemName,
              quantity: issue.quantity,
            })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(`qrRecovery.issue.reason.${issue.type}`)}
          </p>
        </div>
        <Money amount={issue.lineTotalIdr} className="font-semibold" />
      </section>

      <p
        aria-live="polite"
        className="flex items-center gap-1.5 px-1 text-sm empty:-mb-4"
      >
        {choose.isSuccess && (
          <>
            <Check className="size-4" aria-hidden="true" />
            {t("qrRecovery.issue.saved")}
          </>
        )}
      </p>

      {issue.status === "open" ? (
        <IssueChoices
          issue={issue}
          pending={choose.isPending}
          saved={choose.isSuccess}
          error={choose.error}
          offline={!online}
          onClearError={() => {
            if (choose.isError) choose.reset();
          }}
          onReload={() => {
            choose.reset();
            void issues.refetch();
          }}
          onSubmit={(input) =>
            choose.mutate({ orderIssueId: issue.id, ...input })
          }
        />
      ) : (
        <Resolved
          issue={issue}
          token={qrToken}
          timeZone={menu?.outlet.timeZone}
        />
      )}
    </QrSubPage>
  );
}
