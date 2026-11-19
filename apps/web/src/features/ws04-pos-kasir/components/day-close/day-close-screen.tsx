import { useId, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Check, Printer, ShieldCheck, TriangleAlert } from "lucide-react";
import { formatRupiah, type MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";
import { isContractPending, useCloseDay, useDayCloseRecap } from "../../hooks";
import type { DayCloseRecap, DayCloseResult } from "../../types";
import {
  Notice,
  PosPageHeading,
  PosPanel,
  StateBlock,
  StatusPill,
  type StatusPillTone,
} from "../shared";

// /pos/tutup-hari (mockups supervisor-day-close, supervisor-day-closed): the
// outlet manager checks the recap, settles the EDC batches and closes the
// business day. Three different facts stay apart on purpose: the recap is saved
// at the outlet, the bank batch succeeded, and accounting has synced.

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-08" -> "8 November 2026", without any time zone shift. */
function formatBusinessDate(isoDate: string): string {
  const match = ISO_DATE_RE.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** "04:00" -> "04.00", the way the outlet writes the clock. */
function clockText(hhmm: string): string {
  return hhmm.replace(":", ".");
}

function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  })
    .format(new Date(iso))
    .replace(":", ".");
}

function SuccessBlock({
  title,
  children,
  className,
}: {
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="success-block"
      className={cn(
        "rounded-control border-l-4 border-success bg-success-subtle px-4 py-3",
        className,
      )}
    >
      <p className="flex items-center gap-2 text-(length:--density-text) leading-6 font-semibold text-success">
        <Check className="size-5 shrink-0" aria-hidden="true" />
        {title}
      </p>
      {children && (
        <div className="mt-1 text-base leading-6 text-foreground">
          {children}
        </div>
      )}
    </div>
  );
}

function BackToCashier() {
  const t = useT();
  return (
    <Button asChild variant="outline">
      <Link to="/pos">{t("posKasirDayclose.back")}</Link>
    </Button>
  );
}

function AmountRow({
  label,
  amountIdr,
  strong,
  small,
}: {
  label: string;
  /** null: the figure is hidden from the caller, shown as a dash. */
  amountIdr: number | null;
  strong?: boolean;
  small?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3",
        small ? "text-base" : "text-(length:--density-text)",
        strong && "font-semibold",
      )}
    >
      <dt className={cn(!strong && "text-foreground")}>{label}</dt>
      <dd className="text-right font-semibold">
        {amountIdr === null ? (
          <span aria-label={label}>—</span>
        ) : (
          <Money amount={amountIdr} size={small ? "sm" : "md"} />
        )}
      </dd>
    </div>
  );
}

function LoadingState() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("posKasirDayclose.loading")}
      className="grid gap-4 lg:grid-cols-3"
    >
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="grid h-96 content-start gap-4 rounded-container border-(length:--border-w) border-border bg-card p-card"
        >
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-12 w-3/4" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      ))}
    </div>
  );
}

function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const t = useT();
  const pending = isContractPending(error);
  return (
    <div className="rounded-container border-(length:--border-w) border-border bg-card">
      <StateBlock
        title={
          pending
            ? t("posKasirDayclose.error.pending")
            : t("posKasirDayclose.error.title")
        }
        description={
          pending
            ? t("posKasirDayclose.error.pendingHint")
            : t("posKasirDayclose.error.description")
        }
        role="alert"
      >
        <div className="flex flex-wrap justify-center gap-3">
          <Button onClick={onRetry}>{t("posKasirDayclose.error.retry")}</Button>
          <BackToCashier />
        </div>
      </StateBlock>
    </div>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="rounded-container border-(length:--border-w) border-border bg-card">
      <StateBlock
        title={t("posKasirDayclose.empty.title")}
        description={t("posKasirDayclose.empty.description")}
      >
        <BackToCashier />
      </StateBlock>
    </div>
  );
}

function ChannelPanel({ recap }: { recap: DayCloseRecap }) {
  const t = useT();
  const allClosed = recap.shifts.closed >= recap.shifts.total;
  const variance = recap.shifts.cashVarianceIdr;
  return (
    <PosPanel title={t("posKasirDayclose.channels.title")}>
      <div className="grid gap-5">
        <div className="grid gap-1">
          <p className="type-overline text-muted-foreground uppercase">
            {t("posKasirDayclose.channels.totalLabel")}
          </p>
          <Money amount={recap.totalSalesIdr} size="stat" />
          <p className="text-base text-muted-foreground">
            {t("posKasirDayclose.channels.totalHint")}
          </p>
        </div>
        <dl className="grid gap-3">
          {recap.channels.map((channel) => (
            <div
              key={channel.code}
              className="border-b-(length:--border-w) border-border pb-3"
            >
              <AmountRow label={channel.label} amountIdr={channel.amountIdr} />
            </div>
          ))}
        </dl>
        <dl className="grid gap-2">
          <AmountRow
            small
            label={t("posKasirDayclose.channels.refund")}
            amountIdr={recap.refundIdr}
          />
          <AmountRow
            small
            label={t("posKasirDayclose.channels.void")}
            amountIdr={recap.voidIdr}
          />
        </dl>
        {allClosed ? (
          <SuccessBlock
            title={t("posKasirDayclose.channels.shiftsClosedTitle")}
          >
            <p className="tabular">
              {t("posKasirDayclose.channels.shiftsClosed", {
                shifts: recap.shifts.total,
                terminals: recap.shifts.terminals,
              })}
            </p>
            {variance !== null && (
              <p className="tabular">
                {variance === 0
                  ? t("posKasirDayclose.channels.noVariance")
                  : t("posKasirDayclose.channels.variance", {
                      amount: formatRupiah(variance),
                    })}
              </p>
            )}
          </SuccessBlock>
        ) : (
          <Notice
            tone="warning"
            title={t("posKasirDayclose.channels.shiftsOpenTitle")}
          >
            <p className="tabular">
              {t("posKasirDayclose.channels.shiftsOpen", {
                open: recap.shifts.total - recap.shifts.closed,
                total: recap.shifts.total,
              })}
            </p>
          </Notice>
        )}
      </div>
    </PosPanel>
  );
}

function NetPaymentPanel({ recap }: { recap: DayCloseRecap }) {
  const t = useT();
  return (
    <PosPanel title={t("posKasirDayclose.net.title")}>
      <div className="grid gap-4">
        <p className="text-base text-muted-foreground">
          {t("posKasirDayclose.net.subtitle")}
        </p>
        <dl className="grid gap-3">
          {recap.netPayments.map((payment) => (
            <div
              key={payment.code}
              className="border-b-(length:--border-w) border-border pb-3"
            >
              <AmountRow label={payment.label} amountIdr={payment.netIdr} />
            </div>
          ))}
        </dl>
        <dl>
          <AmountRow
            strong
            label={t("posKasirDayclose.net.total")}
            amountIdr={recap.totalNetIdr}
          />
        </dl>
        <p className="text-base text-muted-foreground">
          {t("posKasirDayclose.net.separate")}
        </p>
        {recap.drawerFiguresHidden && (
          <p className="text-base text-muted-foreground">
            {t("posKasirDayclose.channels.blindNote")}
          </p>
        )}
      </div>
    </PosPanel>
  );
}

function SettlementLines({
  settlement,
}: {
  settlement: DayCloseRecap["settlement"];
}) {
  const t = useT();
  if (settlement === null)
    return <p>{t("posKasirDayclose.check.settlementPending")}</p>;
  if (settlement.length === 0)
    return <p>{t("posKasirDayclose.check.settlementNone")}</p>;
  return (
    <ul className="grid gap-0.5">
      {settlement.map((row) => (
        <li key={row.bank} className="tabular">
          {t("posKasirDayclose.check.settlementBank", {
            bank: row.bank,
            amount: formatRupiah(row.amountIdr),
          })}
        </li>
      ))}
    </ul>
  );
}

function CheckPanel({ recap }: { recap: DayCloseRecap }) {
  const t = useT();
  const stockId = useId();
  const closeDay = useCloseDay();
  const [deduct, setDeduct] = useState(false);
  const stock = recap.stockDeduction;
  const allClosed = recap.shifts.closed >= recap.shifts.total;
  const unmatched = recap.standaloneUnmatched ?? 0;
  const unsynced = recap.unsyncedReceiptCount ?? 0;

  const failure =
    closeDay.error instanceof ApiError
      ? closeDay.error.message
      : closeDay.error
        ? t("posKasirDayclose.error.description")
        : null;

  return (
    <PosPanel
      title={t("posKasirDayclose.check.title")}
      footer={
        <div className="flex w-full flex-col gap-3">
          <Button
            size="lg"
            className="w-full"
            loading={closeDay.isPending}
            disabled={!allClosed || closeDay.isPending}
            onClick={() =>
              closeDay.mutate({ inventoryDeduction: stock.available && deduct })
            }
          >
            {closeDay.isPending
              ? t("posKasirDayclose.check.submitting")
              : t("posKasirDayclose.check.submit")}
          </Button>
          <Button asChild variant="outline" size="lg" className="w-full">
            <Link to="/pos">{t("posKasirDayclose.back")}</Link>
          </Button>
        </div>
      }
    >
      <div className="grid gap-5">
        {unsynced > 0 && (
          <Notice
            tone="warning"
            title={t("posKasirDayclose.check.unsyncedTitle")}
          >
            <p>
              {t("posKasirDayclose.check.unsyncedReceipts", {
                count: unsynced,
              })}
            </p>
          </Notice>
        )}
        <Notice
          tone="warning"
          title={t("posKasirDayclose.check.settlementTitle")}
        >
          <div className="grid gap-2">
            <SettlementLines settlement={recap.settlement} />
            <p>
              {unmatched > 0
                ? t("posKasirDayclose.check.unmatched", { count: unmatched })
                : t("posKasirDayclose.check.noUnmatched")}
            </p>
          </div>
        </Notice>
        <div className="grid gap-2">
          <h3 className="text-(length:--density-text) font-semibold">
            {t("posKasirDayclose.check.stockHeading")}
          </h3>
          {stock.available ? (
            <div className="flex items-start gap-3">
              <Checkbox
                id={stockId}
                checked={deduct}
                onCheckedChange={(value) => setDeduct(value === true)}
                disabled={closeDay.isPending}
              />
              <Label
                htmlFor={stockId}
                className="grid cursor-pointer gap-0.5 text-base"
              >
                <span className="text-(length:--density-text)">
                  {t("posKasirDayclose.check.stockLabel")}
                </span>
                <span className="font-normal text-muted-foreground">
                  {t("posKasirDayclose.check.stockHint")}
                </span>
              </Label>
            </div>
          ) : (
            <p className="text-base text-muted-foreground">
              {t("posKasirDayclose.check.stockUnavailable")}
            </p>
          )}
        </div>
        <p className="text-base text-muted-foreground">
          {t("posKasirDayclose.check.saveNote")}
        </p>
        {failure && (
          <Notice tone="danger" title={t("posKasirDayclose.check.failTitle")}>
            <p>{failure}</p>
            <p>{t("posKasirDayclose.check.failHint")}</p>
          </Notice>
        )}
      </div>
    </PosPanel>
  );
}

function OpenDay({ recap }: { recap: DayCloseRecap }) {
  return (
    <div className="grid items-stretch gap-4 lg:grid-cols-3">
      <ChannelPanel recap={recap} />
      <NetPaymentPanel recap={recap} />
      <CheckPanel recap={recap} />
    </div>
  );
}

const ACCOUNTING: Record<
  DayCloseResult["accounting"],
  {
    tone: StatusPillTone;
    pill: MessageKey;
    body: MessageKey;
    hint: MessageKey;
  }
> = {
  queued: {
    tone: "warning",
    pill: "posKasirDayclose.closed.accountingQueued",
    body: "posKasirDayclose.closed.accountingQueuedBody",
    hint: "posKasirDayclose.closed.accountingQueuedHint",
  },
  synced: {
    tone: "success",
    pill: "posKasirDayclose.closed.accountingSynced",
    body: "posKasirDayclose.closed.accountingSyncedBody",
    hint: "posKasirDayclose.closed.accountingSyncedHint",
  },
  failed: {
    tone: "danger",
    pill: "posKasirDayclose.closed.accountingFailed",
    body: "posKasirDayclose.closed.accountingFailedBody",
    hint: "posKasirDayclose.closed.accountingFailedHint",
  },
};

function ClosedDay({
  recap,
  result,
}: {
  recap: DayCloseRecap;
  result: DayCloseResult;
}) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const accounting = ACCOUNTING[result.accounting];
  const variance = recap.shifts.cashVarianceIdr;
  const anyBatchFailed = result.batches.some((b) => b.status === "failed");
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <SuccessBlock title={t("posKasirDayclose.closed.successTitle")}>
        <p className="tabular">
          {variance === null
            ? t("posKasirDayclose.closed.successBlind", {
                terminals: recap.shifts.terminals,
                shifts: recap.shifts.total,
              })
            : variance === 0
              ? t("posKasirDayclose.closed.successNoVariance", {
                  terminals: recap.shifts.terminals,
                  shifts: recap.shifts.total,
                })
              : t("posKasirDayclose.closed.success", {
                  terminals: recap.shifts.terminals,
                  shifts: recap.shifts.total,
                  amount: formatRupiah(variance),
                })}
        </p>
        {recap.drawerFiguresHidden && (
          <p className="text-muted-foreground">
            {t("posKasirDayclose.channels.blindNote")}
          </p>
        )}
        <p className="tabular text-muted-foreground">
          {t("posKasirDayclose.closed.closedBy", {
            name: result.closedByName,
            time: formatClock(result.closedAt, timeZone),
          })}
        </p>
      </SuccessBlock>
      <div className="grid items-stretch gap-4 md:grid-cols-2">
        <section
          aria-label={t("posKasirDayclose.closed.totalLabel")}
          className="grid content-start gap-4 rounded-container border-(length:--border-w) border-border bg-card p-card"
        >
          <div className="grid gap-1">
            <p className="type-overline text-muted-foreground uppercase">
              {t("posKasirDayclose.closed.totalLabel")}
            </p>
            <Money amount={recap.totalSalesIdr} size="stat" />
          </div>
          <dl className="grid gap-3 border-t-(length:--border-w) border-border pt-4">
            <AmountRow
              label={t("posKasirDayclose.closed.refund")}
              amountIdr={recap.refundIdr}
            />
            <div className="flex items-baseline justify-between gap-3 text-(length:--density-text)">
              <dt>{t("posKasirDayclose.closed.stock")}</dt>
              <dd className="font-semibold">
                {result.stockDeductionApplied
                  ? t("posKasirDayclose.closed.stockApplied")
                  : t("posKasirDayclose.closed.stockNotApplied")}
              </dd>
            </div>
          </dl>
        </section>
        <PosPanel
          title={t("posKasirDayclose.closed.accountingTitle")}
          aside={
            <StatusPill tone={accounting.tone}>{t(accounting.pill)}</StatusPill>
          }
        >
          <div className="grid gap-3" aria-live="polite">
            <p className="text-(length:--density-text) leading-6">
              {t(accounting.body)}
            </p>
            <p className="text-base text-muted-foreground">
              {t(accounting.hint)}
            </p>
          </div>
        </PosPanel>
      </div>
      <Notice
        tone={anyBatchFailed ? "danger" : "warning"}
        title={t("posKasirDayclose.closed.settlementTitle")}
      >
        <div className="grid gap-1">
          {result.batches.length === 0 ? (
            <p>{t("posKasirDayclose.closed.batchNone")}</p>
          ) : (
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {result.batches.map((batch) => (
                <li key={batch.bank} className="flex items-center gap-1.5">
                  {batch.status === "success" ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <TriangleAlert className="size-4" aria-hidden="true" />
                  )}
                  {t(
                    batch.status === "success"
                      ? "posKasirDayclose.closed.batchSuccess"
                      : "posKasirDayclose.closed.batchFailed",
                    { bank: batch.bank },
                  )}
                </li>
              ))}
            </ul>
          )}
          <p>
            {result.standaloneUnmatched > 0
              ? t("posKasirDayclose.closed.reconcile", {
                  count: result.standaloneUnmatched,
                })
              : t("posKasirDayclose.closed.reconcileNone")}
          </p>
          {anyBatchFailed && (
            <p>{t("posKasirDayclose.closed.batchFailedNote")}</p>
          )}
        </div>
      </Notice>
      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          variant="outline"
          size="lg"
          className="print:hidden"
          onClick={() => window.print()}
        >
          <Printer aria-hidden="true" />
          {t("posKasirDayclose.closed.print")}
        </Button>
        <Button asChild size="lg" className="print:hidden">
          <Link to="/pos">{t("posKasirDayclose.back")}</Link>
        </Button>
      </div>
    </div>
  );
}

export function DayCloseScreen() {
  const t = useT();
  const { outlet } = useTenantContext();
  const recapQuery = useDayCloseRecap();
  const recap = recapQuery.data;

  const dateText = recap ? formatBusinessDate(recap.businessDate) : "";
  const closed = recap?.status === "closed" && recap.result !== undefined;
  const outletName = outlet?.name;

  let heading: ReactNode;
  if (recap && closed) {
    heading = (
      <PosPageHeading
        title={t("posKasirDayclose.closed.title")}
        subtitle={
          outletName
            ? t("posKasirDayclose.closed.subtitle", {
                date: dateText,
                outlet: outletName,
              })
            : t("posKasirDayclose.closed.subtitleNoOutlet", { date: dateText })
        }
        action={
          <StatusPill tone="success">
            {t("posKasirDayclose.closed.saved")}
          </StatusPill>
        }
      />
    );
  } else {
    const cutoff = recap ? clockText(recap.cutoffTime) : "";
    heading = (
      <PosPageHeading
        title={t("posKasirDayclose.title")}
        subtitle={
          recap
            ? outletName
              ? t("posKasirDayclose.subtitle", {
                  date: dateText,
                  outlet: outletName,
                  cutoff,
                })
              : t("posKasirDayclose.subtitleNoOutlet", {
                  date: dateText,
                  cutoff,
                })
            : undefined
        }
        action={
          <StatusPill tone="neutral" icon={ShieldCheck}>
            {t("posKasirDayclose.access")}
          </StatusPill>
        }
      />
    );
  }

  let body: ReactNode;
  if (recapQuery.isPending) body = <LoadingState />;
  else if (recapQuery.isError || !recap)
    body = (
      <ErrorState
        error={recapQuery.error}
        onRetry={() => void recapQuery.refetch()}
      />
    );
  else if (closed && recap.result)
    body = <ClosedDay recap={recap} result={recap.result} />;
  else if (
    recap.channels.length === 0 &&
    recap.netPayments.length === 0 &&
    recap.shifts.total === 0
  )
    body = <EmptyState />;
  else body = <OpenDay recap={recap} />;

  return (
    <div data-slot="pos-day-close" className="grid gap-4">
      {heading}
      {body}
    </div>
  );
}
