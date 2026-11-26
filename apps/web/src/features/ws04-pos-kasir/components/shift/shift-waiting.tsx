import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { useOutletClock } from "@/lib/tenant-context";
import { ApiError } from "@/lib/api/errors";
import { ApprovalDialog } from "../../../ws04-pos-correction/components/approval-dialog";
import { isCloseSettled, isCloseStale, isQrisHoldBlock } from "../../shift-api";
import {
  useActiveShift,
  useCloseShiftWithApproval,
  useOwnCountSummary,
  useStartRecount,
} from "../../shift-hooks";
import { SHIFT_CASHIER_COUNT_LIMIT } from "../../shift-extra-types";
import type { ActiveShift } from "../../types";
import {
  Notice,
  PosPageHeading,
  PosPanel,
  PosTwoPane,
  StateBlock,
  StatusPill,
} from "../shared";
import { formatShiftTime } from "./shift-format";
import { ContextBlock } from "./shift-parts";

// The limit screen on /pos/shift/tutup sends the cashier to /pos/shift, where
// ShiftWaiting mounts fresh. This one-shot flag tells it to open the status
// view directly, so one tap on "Lihat status" is enough.
let openStatusOnMount = false;
export function requestShiftStatusView() {
  openStatusOnMount = true;
}

type WaitingShift = Pick<ActiveShift, "id" | "cashierName" | "terminalLabel">;

// The count was sent and the cashier used all recounts: nothing can be sent
// anymore, a supervisor recounts and force closes (legend-7mlf). Shows the
// counted figure only, never a system figure.
export function ShiftCountLimit({
  shift,
  countedIdr,
  used = SHIFT_CASHIER_COUNT_LIMIT,
  onStatus,
}: {
  shift: WaitingShift;
  countedIdr: number | null;
  used?: number;
  onStatus: () => void;
}) {
  const t = useT();
  const router = useRouter();
  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={t("posKasirShift.limit.title")}
        subtitle={t("posKasirShift.count.shiftPill", {
          cashier: shift.cashierName,
          terminal: shift.terminalLabel,
        })}
        action={
          <StatusPill tone="danger">{t("posKasirShift.limit.pill")}</StatusPill>
        }
      />
      <PosTwoPane
        side={
          <PosPanel title={t("posKasirShift.limit.sideTitle")}>
            <div className="grid gap-4">
              <ContextBlock label={t("posKasirShift.limit.countsLabel")}>
                <span className="tabular">
                  {t("posKasirShift.limit.countsValue", {
                    used,
                    max: SHIFT_CASHIER_COUNT_LIMIT,
                  })}
                </span>
              </ContextBlock>
              {countedIdr !== null && (
                <ContextBlock label={t("posKasirShift.limit.physicalLabel")}>
                  <Money amount={countedIdr} className="font-semibold" />
                </ContextBlock>
              )}
            </div>
          </PosPanel>
        }
      >
        <PosPanel
          title={t("posKasirShift.limit.mainTitle")}
          footer={
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.history.back()}
              >
                {t("posKasirShift.limit.back")}
              </Button>
              <Button type="button" onClick={onStatus}>
                {t("posKasirShift.limit.status")}
              </Button>
            </>
          }
        >
          <div className="grid content-start gap-4">
            <Notice tone="warning" title={t("posKasirShift.limit.noticeTitle")}>
              {t("posKasirShift.limit.noticeBody")}
            </Notice>
            <p className="text-base text-muted-foreground">
              {t("posKasirShift.limit.note")}
            </p>
          </div>
        </PosPanel>
      </PosTwoPane>
    </div>
  );
}

// After the cashier sent the count: nothing left to do but wait. Shows the
// cashier's own counted figure, no system balance and no variance (blind count).
export function ShiftWaiting({ shift }: { shift: WaitingShift }) {
  const t = useT();
  const router = useRouter();
  const { timeZone } = useOutletClock();
  const active = useActiveShift();
  const summary = useOwnCountSummary(shift.id);
  const close = useCloseShiftWithApproval();
  const startRecount = useStartRecount();
  const [closing, setClosing] = useState(false);
  const [showStatus, setShowStatus] = useState(() => openStatusOnMount);
  useEffect(() => {
    openStatusOnMount = false;
  }, []);
  const last = summary.data ?? null;
  // The supervisor close needs the stored count (real wire); the recount is the
  // cashier's own, up to the server's limit.
  const closeCount = last?.countId
    ? { countId: last.countId, noteRequired: last.noteRequired ?? false }
    : null;
  const stale = isCloseStale(close.error);
  const holdBlocked = isQrisHoldBlock(close.error);
  const dialogError =
    close.isError && !stale && !holdBlocked
      ? close.error instanceof ApiError &&
        close.error.status >= 400 &&
        close.error.status < 500
        ? t("posKasirShift.close.pinRejected")
        : t("posKasirShift.close.overrideFailed")
      : null;
  // The approval was accepted but its answer is unknown: no dialog, no new PIN,
  // only "Coba lagi" with the stored body. Closed by a lost answer: read again.
  const dialogOpen =
    closing &&
    !close.canRetry &&
    !close.isSuccess &&
    !isCloseSettled(close.error);
  const recount = () => {
    close.reset();
    startRecount(shift.id);
  };

  if (last?.limitReached && !showStatus)
    return (
      <ShiftCountLimit
        shift={shift}
        countedIdr={last.countedIdr}
        used={last.sequence}
        onStatus={() => setShowStatus(true)}
      />
    );

  if (!last)
    return (
      <div className="grid gap-4">
        <PosPageHeading
          title={t("posKasirShift.waiting.heading")}
          subtitle={t("posKasirShift.waiting.subtitle")}
          action={
            <StatusPill tone="warning">
              {t("posKasirShift.count.shiftPill", {
                cashier: shift.cashierName,
                terminal: shift.terminalLabel,
              })}
            </StatusPill>
          }
        />
        <PosPanel title={t("posKasirShift.waiting.status")}>
          <StateBlock
            mark="ok"
            title={t("posKasirShift.waiting.title")}
            description={t("posKasirShift.waiting.description")}
            role="status"
            aria-live="polite"
          />
        </PosPanel>
      </div>
    );

  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={t("posKasirShift.submitted.title")}
        subtitle={t("posKasirShift.count.shiftPill", {
          cashier: shift.cashierName,
          terminal: shift.terminalLabel,
        })}
        action={
          <StatusPill tone="warning">
            {t("posKasirShift.waiting.status")}
          </StatusPill>
        }
      />
      <PosTwoPane
        side={
          <PosPanel title={t("posKasirShift.submitted.sideTitle")}>
            <div className="grid gap-4">
              <ContextBlock label={t("posKasirShift.submitted.ordinalLabel")}>
                <span className="tabular">
                  {t("posKasirShift.submitted.ordinalValue", {
                    number: last.sequence,
                  })}
                </span>
              </ContextBlock>
              <ContextBlock label={t("posKasirShift.submitted.physicalLabel")}>
                <Money amount={last.countedIdr} className="font-semibold" />
              </ContextBlock>
              <ContextBlock label={t("posKasirShift.submitted.sentLabel")}>
                <span className="tabular">
                  {formatShiftTime(last.submittedAt, timeZone)}
                </span>
              </ContextBlock>
            </div>
          </PosPanel>
        }
      >
        <PosPanel
          title={t("posKasirShift.submitted.mainTitle")}
          footer={
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.history.back()}
              >
                {t("posKasirShift.submitted.back")}
              </Button>
              {closeCount && last.sequence < SHIFT_CASHIER_COUNT_LIMIT && (
                <Button type="button" variant="outline" onClick={recount}>
                  {t("posKasirShift.submitted.recount")}
                </Button>
              )}
              {closeCount && close.canRetry && (
                <Button
                  type="button"
                  loading={close.isPending}
                  onClick={() => {
                    setClosing(false);
                    close.retry();
                  }}
                >
                  {t("posKasirShift.close.retry")}
                </Button>
              )}
              {closeCount && !close.canRetry && (
                <Button
                  type="button"
                  loading={close.isPending}
                  onClick={() => {
                    close.reset();
                    setClosing(true);
                  }}
                >
                  {t("posKasirShift.submitted.closeAction")}
                </Button>
              )}
              <Button
                type="button"
                variant={closeCount ? "outline" : "default"}
                loading={active.isFetching}
                onClick={() => {
                  void active.refetch();
                  void summary.refetch();
                }}
              >
                {active.isFetching
                  ? t("posKasirShift.submitted.refreshing")
                  : t("posKasirShift.submitted.status")}
              </Button>
            </>
          }
        >
          <div
            className="grid content-start gap-4"
            role="status"
            aria-live="polite"
          >
            <Notice
              tone="info"
              title={t("posKasirShift.submitted.noticeTitle")}
            >
              {t("posKasirShift.submitted.noticeBody")}
            </Notice>
            <p className="text-base text-muted-foreground">
              {t("posKasirShift.submitted.note")}
            </p>
            {stale && (
              <Notice tone="danger" title={t("posKasirShift.close.staleTitle")}>
                <p>{t("posKasirShift.close.staleBody")}</p>
                <Button type="button" className="mt-3" onClick={recount}>
                  {t("posKasirShift.close.staleAction")}
                </Button>
              </Notice>
            )}
            {close.canRetry && !close.isPending && (
              <Notice
                tone="warning"
                title={t("posKasirShift.close.retryHint")}
              />
            )}
            {holdBlocked && (
              <Notice tone="warning" title={t("posKasirShift.close.holdTitle")}>
                {t("posKasirShift.close.holdBody")}
              </Notice>
            )}
          </div>
        </PosPanel>
      </PosTwoPane>
      {closeCount && (
        <ApprovalDialog
          open={dialogOpen}
          onOpenChange={setClosing}
          action="cash_shift_close"
          title={t("posKasirShift.close.dialogTitle")}
          summary={t("posKasirShift.close.dialogSummary")}
          reasonLabel={t("posKasirShift.close.noteLabel")}
          pending={close.isPending}
          error={dialogError}
          onSubmit={({ approverUserId, pin, reason }) =>
            close.mutate(
              {
                shiftId: shift.id,
                countId: closeCount.countId,
                noteRequired: closeCount.noteRequired,
                approverUserId,
                pin,
                reason,
              },
              {
                onSettled: (_data, error) => {
                  if (!error || isCloseStale(error) || isQrisHoldBlock(error))
                    setClosing(false);
                },
              },
            )
          }
        />
      )}
    </div>
  );
}
