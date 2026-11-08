import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { useOutletClock } from "@/lib/tenant-context";
import { useActiveShift } from "../../hooks";
import type { ActiveShift } from "../../types";
import { PosPageHeading, PosPanel, PosTwoPane, StatusPill } from "../shared";
import { CashMovementPanel } from "./cash-movement-panel";
import { ShiftOpenScreen } from "./shift-open-screen";
import { formatShiftDateTime, shiftDuration } from "./shift-format";
import { ContextBlock, ShiftScreenSkeleton } from "./shift-parts";
import { ShiftWaiting } from "./shift-waiting";

/** Wall-clock ms, refreshed every minute; null until hydrated (SSR-safe). */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  return now;
}

function ActiveShiftView({ shift }: { shift: ActiveShift }) {
  const t = useT();
  const { timeZone } = useOutletClock();
  const now = useNow();
  const duration = now === null ? null : shiftDuration(shift.openedAt, now);
  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={t("posKasirShift.active.title")}
        subtitle={t("posKasirShift.active.subtitle")}
        action={
          <StatusPill tone="success">
            {t("posKasirShift.pill.active")}
          </StatusPill>
        }
      />
      <PosTwoPane
        side={
          <PosPanel
            title={t("posKasirShift.active.sideTitle", {
              cashier: shift.cashierName,
              terminal: shift.terminalLabel,
            })}
            footer={
              <div className="grid w-full gap-3">
                <p className="text-base text-muted-foreground">
                  {t("posKasirShift.active.closeNote")}
                </p>
                <Button variant="outline" className="w-full" asChild>
                  <Link to="/pos/shift/tutup">
                    {t("posKasirShift.active.closeAction")}
                  </Link>
                </Button>
              </div>
            }
          >
            <div className="grid gap-4">
              <ContextBlock label={t("posKasirShift.active.opened")}>
                <span className="tabular">
                  {formatShiftDateTime(shift.openedAt, timeZone)}
                </span>
              </ContextBlock>
              <ContextBlock label={t("posKasirShift.active.openingFloat")}>
                <Money amount={shift.openingFloatIdr} size="stat" />
              </ContextBlock>
              <ContextBlock label={t("posKasirShift.active.duration")}>
                <span className="tabular">
                  {duration
                    ? t("posKasirShift.active.durationValue", {
                        hours: duration.hours,
                        minutes: duration.minutes,
                      })
                    : "–"}
                </span>
              </ContextBlock>
            </div>
          </PosPanel>
        }
      >
        <CashMovementPanel shiftId={shift.id} />
      </PosTwoPane>
    </div>
  );
}

// /pos/shift: no shift yet -> the open form; a shift in progress -> cash
// movements and the way to close; after the count was sent -> waiting.
// `returnTo` is the bill to go back to once a shift is opened.
export function ShiftActiveScreen({ returnTo }: { returnTo?: string }) {
  const t = useT();
  const shift = useActiveShift();
  const navigate = useNavigate();
  if (shift.isPending)
    return <ShiftScreenSkeleton label={t("posKasirShift.loading")} />;
  if (shift.isError)
    return (
      <ErrorState
        title={t("posKasirShift.error.title")}
        description={t("posKasirShift.error.hint")}
        onRetry={() => void shift.refetch()}
      />
    );
  if (shift.data === null) return <ShiftOpenScreen returnTo={returnTo} />;
  if (shift.data.status !== "open" || shift.data.countSubmitted)
    return (
      <ShiftWaiting
        shift={shift.data}
        // A sent count can be replaced until the supervisor closes the shift.
        onRecount={
          shift.data.countSubmitted && shift.data.status !== "closed"
            ? () =>
                void navigate({
                  to: "/pos/shift/tutup",
                  // Opens the count form at once instead of a second waiting
                  // screen: it names the count being replaced.
                  search: { recount: shift.data?.countSequence ?? undefined },
                })
            : undefined
        }
      />
    );
  return <ActiveShiftView shift={shift.data} />;
}
