import { useState, type ReactNode } from "react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutletClock } from "@/lib/tenant-context";
import { useHeldCashOuts } from "../../hooks";
import type { HeldCashOut, HeldCashOutReview } from "../../shift-extra-types";
import { Notice, PosPanel, StatusPill } from "../shared";
import { formatShiftTime } from "../shift/shift-format";

const MINUS = "−";

/** Signed rupiah text: "−Rp20.000", "+Rp180.000". */
function signed(amountIdr: number): string {
  if (amountIdr === 0) return formatRupiah(0);
  return `${amountIdr < 0 ? MINUS : "+"}${formatRupiah(Math.abs(amountIdr))}`;
}

function Line({
  label,
  children,
  strong = false,
}: {
  label: string;
  children: ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={
        strong
          ? "flex items-baseline justify-between gap-4 border-t-2 border-foreground py-2.5 text-(length:--density-text) font-bold"
          : "flex items-baseline justify-between gap-4 border-t-(length:--border-w) border-border py-2.5 text-(length:--density-text)"
      }
    >
      <span>{label}</span>
      <span className="tabular text-right font-semibold whitespace-nowrap">
        {children}
      </span>
    </div>
  );
}

function HeldRow({ item }: { item: HeldCashOut }) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const type = t(
    item.type === "drop"
      ? "posKasirSupervisor.held.typeDrop"
      : "posKasirSupervisor.held.typeCashOut",
  );
  return (
    <li className="grid gap-2 border-l-4 border-warning pl-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-(length:--density-text) font-semibold break-words">
            {t("posKasirSupervisor.held.itemTitle", {
              type,
              reason: item.reasonNote,
            })}
          </p>
          <p className="text-base text-muted-foreground tabular">
            {t("posKasirSupervisor.held.itemMeta", {
              time: formatShiftTime(item.recordedAt, timeZone),
              cashier: item.cashierName,
            })}
          </p>
        </div>
        <Money amount={item.amountIdr} className="font-semibold" />
      </div>
      <p>
        <StatusPill tone="warning">
          {t("posKasirSupervisor.held.needsApproval")}
        </StatusPill>
      </p>
    </li>
  );
}

function HeldPanel({
  review,
  onBack,
  onContinue,
  onForceClose,
}: {
  review: HeldCashOutReview;
  onBack: () => void;
  onContinue: () => void;
  onForceClose?: () => void;
}) {
  const t = useT();
  const { physicalVarianceIdr, bookVarianceIdr, totalHeldIdr } = review;
  return (
    <PosPanel
      title={t("posKasirSupervisor.held.title")}
      aside={
        <StatusPill tone="warning">
          {t("posKasirSupervisor.held.count", { count: review.items.length })}
        </StatusPill>
      }
      footer={
        <>
          <Button type="button" variant="outline" onClick={onBack}>
            {t("posKasirSupervisor.back")}
          </Button>
          {onForceClose && (
            <Button type="button" variant="outline" onClick={onForceClose}>
              {t("posKasirSupervisor.held.forceClose")}
            </Button>
          )}
          <Button type="button" onClick={onContinue}>
            {t("posKasirSupervisor.held.continue")}
          </Button>
        </>
      }
    >
      <div className="grid content-start gap-4">
        <p className="text-base text-muted-foreground">
          {t("posKasirSupervisor.held.intro")}
        </p>
        <ul className="grid gap-4">
          {review.items.map((item) => (
            <HeldRow key={item.id} item={item} />
          ))}
        </ul>
        <div>
          <Line label={t("posKasirSupervisor.held.total")} strong>
            <Money amount={totalHeldIdr} className="font-bold" />
          </Line>
          {physicalVarianceIdr !== null && bookVarianceIdr !== null && (
            <>
              <Line label={t("posKasirSupervisor.held.physical")}>
                {signed(physicalVarianceIdr)}
              </Line>
              <Line label={t("posKasirSupervisor.held.book")} strong>
                {signed(bookVarianceIdr)}
              </Line>
            </>
          )}
        </div>
        {physicalVarianceIdr !== null && (
          <p className="text-base text-muted-foreground">
            {t("posKasirSupervisor.held.formula", {
              physical: signed(physicalVarianceIdr),
              held: signed(totalHeldIdr),
            })}
          </p>
        )}
        <Notice tone="warning" title={t("posKasirSupervisor.held.noticeTitle")}>
          {t("posKasirSupervisor.held.noticeBody")}
        </Notice>
      </div>
    </PosPanel>
  );
}

// Before the approval form: the cash outs held for review, with the physical
// and the book variance (legend-pspy). Loading and failure block the approval,
// because the supervisor must not approve without seeing them.
export function HeldCashOutGate({
  shiftId,
  onBack,
  onForceClose,
  children,
}: {
  shiftId: string;
  onBack: () => void;
  /** Offered when the cashier used all recounts. */
  onForceClose: () => void;
  /** The approval form, shown once the held cash outs were reviewed. */
  children: ReactNode;
}) {
  const t = useT();
  const held = useHeldCashOuts(shiftId);
  const [reviewed, setReviewed] = useState(false);

  if (held.isPending)
    return (
      <PosPanel title={t("posKasirSupervisor.held.title")}>
        <div role="status" aria-busy="true" className="grid gap-3">
          <p className="font-semibold">
            {t("posKasirSupervisor.held.loadingTitle")}
          </p>
          <p className="text-base text-muted-foreground">
            {t("posKasirSupervisor.held.loadingBody")}
          </p>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/5" />
        </div>
      </PosPanel>
    );

  if (held.isError)
    return (
      <PosPanel
        title={t("posKasirSupervisor.held.title")}
        footer={
          <>
            <Button type="button" variant="outline" onClick={onBack}>
              {t("posKasirSupervisor.back")}
            </Button>
            <Button
              type="button"
              loading={held.isFetching}
              onClick={() => void held.refetch()}
            >
              {t("common.retry")}
            </Button>
          </>
        }
      >
        <Notice tone="danger" title={t("posKasirSupervisor.held.errorTitle")}>
          {t("posKasirSupervisor.held.errorBody")}
        </Notice>
      </PosPanel>
    );

  const review = held.data;
  if (review.items.length > 0 && !reviewed)
    return (
      <HeldPanel
        review={review}
        onBack={onBack}
        onContinue={() => setReviewed(true)}
        onForceClose={review.limitReached ? onForceClose : undefined}
      />
    );

  return (
    <div className="grid content-start gap-4">
      {review.items.length === 0 && (
        <Notice tone="info" title={t("posKasirSupervisor.held.emptyTitle")}>
          {t("posKasirSupervisor.held.emptyBody")}
        </Notice>
      )}
      {review.limitReached && (
        <Button type="button" variant="outline" onClick={onForceClose}>
          {t("posKasirSupervisor.held.forceClose")}
        </Button>
      )}
      {children}
    </div>
  );
}
