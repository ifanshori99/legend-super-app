import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useRouteContext } from "@tanstack/react-router";
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
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { useOutletClock } from "@/lib/tenant-context";
import {
  useCurrentUserId,
  useDecideHeldCashMovement,
  useHeldCashOuts,
} from "../../hooks";
import type {
  HeldCashDecision,
  HeldCashOut,
  HeldCashOutReview,
} from "../../shift-extra-types";
import { Notice, PosPanel, StatusPill } from "../shared";
import { formatShiftTime } from "../shift/shift-format";

const MINUS = "−";

/** Deciding a held cash out needs the same permission as the API route. */
function useCanDecideHeld(): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return context.access
    ? holdsAny(context.access, ["shift.cash.approve_close"])
    : false;
}

type PendingDecision = { item: HeldCashOut; decision: HeldCashDecision };

/** The verdict that was just saved, kept to word the success notice. */
type DoneDecision = PendingDecision;

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

function typeLabelKey(item: HeldCashOut) {
  return item.type === "drop"
    ? ("posKasirSupervisor.held.typeDrop" as const)
    : ("posKasirSupervisor.held.typeCashOut" as const);
}

function HeldRow({
  item,
  selfRecorded,
  onDecide,
}: {
  item: HeldCashOut;
  /** The signed-in user recorded it: the API refuses their own verdict. */
  selfRecorded: boolean;
  /** Absent when the user may not decide: the buttons are not shown. */
  onDecide?: (decision: HeldCashDecision) => void;
}) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const type = t(typeLabelKey(item));
  const id = useId();
  const titleId = `${id}-title`;
  const metaId = `${id}-meta`;
  const reasonId = `${id}-self`;
  const describedBy = selfRecorded
    ? `${titleId} ${metaId} ${reasonId}`
    : `${titleId} ${metaId}`;
  return (
    <li className="grid gap-2 border-l-4 border-warning pl-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p
            id={titleId}
            className="text-(length:--density-text) font-semibold break-words"
          >
            {t("posKasirSupervisor.held.itemTitle", {
              type,
              reason: item.reasonNote,
            })}
          </p>
          <p id={metaId} className="text-base text-muted-foreground tabular">
            {t("posKasirSupervisor.held.itemMeta", {
              time: formatShiftTime(item.recordedAt, timeZone),
              cashier: item.cashierName,
            })}
          </p>
        </div>
        <Money amount={item.amountIdr} className="font-semibold" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone="warning">
          {t("posKasirSupervisor.held.needsApproval")}
        </StatusPill>
        {onDecide && (
          <div
            role="group"
            aria-label={t("posKasirSupervisor.held.decide.groupLabel", {
              type,
              amount: formatRupiah(item.amountIdr),
            })}
            className="ml-auto flex gap-2"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={selfRecorded}
              aria-describedby={describedBy}
              onClick={() => onDecide("rejected")}
            >
              {t("posKasirSupervisor.held.decide.reject")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={selfRecorded}
              aria-describedby={describedBy}
              onClick={() => onDecide("approved")}
            >
              {t("posKasirSupervisor.held.decide.approve")}
            </Button>
          </div>
        )}
      </div>
      {onDecide && selfRecorded && (
        <p id={reasonId} className="text-base text-muted-foreground">
          {t("posKasirSupervisor.held.decide.selfRecorded")}
        </p>
      )}
    </li>
  );
}

/** Confirmation before a verdict: both are final, so the effect is spelled out. */
function DecideDialog({
  pending,
  busy,
  error,
  retryable,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: {
  pending: PendingDecision | null;
  busy: boolean;
  error: string | null;
  retryable: boolean;
  onConfirm: () => void;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const t = useT();
  // Keep the last item while the dialog animates out.
  const [shown, setShown] = useState<PendingDecision | null>(pending);
  if (pending && pending !== shown) setShown(pending);
  const view = pending ?? shown;
  const approve = view?.decision === "approved";
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        {view && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t(
                  approve
                    ? "posKasirSupervisor.held.decide.approveTitle"
                    : "posKasirSupervisor.held.decide.rejectTitle",
                  {
                    type: t(typeLabelKey(view.item)).toLocaleLowerCase("id-ID"),
                  },
                )}
              </DialogTitle>
              <DialogDescription>
                {t(
                  approve
                    ? "posKasirSupervisor.held.decide.approveBody"
                    : "posKasirSupervisor.held.decide.rejectBody",
                  {
                    type: t(typeLabelKey(view.item)),
                    amount: formatRupiah(view.item.amountIdr),
                    reason: view.item.reasonNote,
                  },
                )}
              </DialogDescription>
            </DialogHeader>
            {error && (
              <Notice
                tone="danger"
                title={t("posKasirSupervisor.held.decide.failedTitle")}
              >
                {error}
              </Notice>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onClose}
              >
                {t(
                  error !== null && !retryable
                    ? "posKasirSupervisor.held.decide.close"
                    : "posKasirSupervisor.held.decide.cancel",
                )}
              </Button>
              {(error === null || retryable) && (
                <Button
                  type="button"
                  variant={approve ? "default" : "destructive"}
                  loading={busy}
                  onClick={onConfirm}
                >
                  {t(
                    busy
                      ? "posKasirSupervisor.held.decide.pending"
                      : approve
                        ? "posKasirSupervisor.held.decide.confirmApprove"
                        : "posKasirSupervisor.held.decide.confirmReject",
                  )}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Live region for the saved verdict. It stays mounted while empty so screen
 * readers announce the text when it appears, and takes focus then, because the
 * row that held the buttons is gone.
 */
function DoneRegion({
  done,
  regionRef,
}: {
  done: DoneDecision | null;
  regionRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const approved = done?.decision === "approved";
  return (
    <div ref={regionRef} role="status" tabIndex={-1} className="empty:absolute">
      {done && (
        <Notice
          tone="info"
          title={t(
            approved
              ? "posKasirSupervisor.held.decide.doneApproved"
              : "posKasirSupervisor.held.decide.doneRejected",
            {
              type: t(typeLabelKey(done.item)),
              amount: formatRupiah(done.item.amountIdr),
            },
          )}
        >
          {t("posKasirSupervisor.held.decide.recountHint")}
        </Notice>
      )}
    </div>
  );
}

function HeldPanel({
  review,
  result,
  currentUserId,
  onDecide,
  onBack,
  onContinue,
  onForceClose,
}: {
  review: HeldCashOutReview;
  result: ReactNode;
  currentUserId: string;
  onDecide?: (item: HeldCashOut, decision: HeldCashDecision) => void;
  onBack: () => void;
  onContinue: () => void;
  onForceClose?: () => void;
}) {
  const t = useT();
  const {
    physicalVarianceIdr,
    bookVarianceIdr,
    heldCorrectionIdr,
    totalHeldIdr,
  } = review;
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
        {result}
        <ul className="grid gap-4">
          {review.items.map((item) => (
            <HeldRow
              key={item.id}
              item={item}
              selfRecorded={
                currentUserId !== "" && item.recordedBy === currentUserId
              }
              onDecide={onDecide && ((decision) => onDecide(item, decision))}
            />
          ))}
        </ul>
        <div>
          <Line label={t("posKasirSupervisor.held.total")} strong>
            <Money amount={totalHeldIdr} className="font-bold" />
          </Line>
          <p className="pb-2 text-right text-base text-muted-foreground">
            {t("posKasirSupervisor.held.expired")}
          </p>
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
            {t("posKasirSupervisor.held.formulaBooked", {
              physical: signed(physicalVarianceIdr),
              correction: signed(heldCorrectionIdr),
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
  const decide = useDecideHeldCashMovement();
  const canDecide = useCanDecideHeld();
  const currentUserId = useCurrentUserId();
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [done, setDone] = useState<DoneDecision | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const focusDoneOnClose = useRef(false);

  // The list may swap from the review panel to the approval form once the
  // last item is decided; the notice remounts there, so focus it again.
  const view = held.data
    ? held.data.items.length > 0 && !reviewed
      ? "panel"
      : "form"
    : "none";
  useEffect(() => {
    if (done && view !== "none" && !pending) regionRef.current?.focus();
  }, [done, view, pending]);

  function openDecision(item: HeldCashOut, decision: HeldCashDecision) {
    decide.reset();
    setFailure(null);
    setDone(null);
    setPending({ item, decision });
  }

  function closeDecision() {
    if (decide.isPending) return;
    setPending(null);
    setFailure(null);
  }

  function failureText(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 403)
        return t("posKasirSupervisor.held.decide.forbidden");
      if (error.status === 404)
        return t("posKasirSupervisor.held.decide.notFound");
      // 409 carries a distinct server message per cause; show it as is.
      if (error.status === 409)
        return error.message || t("posKasirSupervisor.held.decide.conflict");
    }
    return t("posKasirSupervisor.held.decide.failedGeneric");
  }

  function confirmDecision() {
    if (!pending) return;
    const { item, decision } = pending;
    setFailure(null);
    decide.mutate(
      { shiftId, movementId: item.id, decision },
      {
        onSuccess: () => {
          focusDoneOnClose.current = true;
          setPending(null);
          setDone({ item, decision });
        },
        onError: (error) => setFailure(failureText(error)),
      },
    );
  }

  // The dialog would hand focus back to the row button, which is gone after a
  // verdict: send it to the success notice instead. Cancel keeps the default.
  function onDialogCloseAutoFocus(event: Event) {
    if (!focusDoneOnClose.current) return;
    focusDoneOnClose.current = false;
    event.preventDefault();
    regionRef.current?.focus();
  }

  // 403, 404 and 409 will not change on a retry; a network or server fault may.
  const retryable =
    !(decide.error instanceof ApiError) ||
    ![403, 404, 409].includes(decide.error.status);
  const decisionDialog = (
    <DecideDialog
      pending={pending}
      busy={decide.isPending}
      error={failure}
      retryable={retryable}
      onConfirm={confirmDecision}
      onClose={closeDecision}
      onCloseAutoFocus={onDialogCloseAutoFocus}
    />
  );
  const doneRegion = <DoneRegion done={done} regionRef={regionRef} />;

  function body() {
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

    // A failed refetch keeps the last list on screen, and the notice with it.
    if (held.isError && !held.data)
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
          result={doneRegion}
          currentUserId={currentUserId}
          onDecide={canDecide ? openDecision : undefined}
          onBack={onBack}
          onContinue={() => {
            setDone(null);
            setReviewed(true);
          }}
          onForceClose={review.limitReached ? onForceClose : undefined}
        />
      );

    return (
      <div className="grid content-start gap-4">
        {doneRegion}
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

  return (
    <>
      {body()}
      {decisionDialog}
    </>
  );
}
