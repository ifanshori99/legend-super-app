// Result of a saved leave clock-in decision, shown on the detail page (bead
// legend-3jem1). Keeping the leave is never rendered as "Ditolak": the API
// stores it as a rejected review, but HR decided the leave stands.
import { Link } from "@tanstack/react-router";
import { CalendarDays, CircleCheck, Undo2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatBusinessDate } from "@/features/ws10-attendance-qr/format.ts";
import type { LeaveClockinAction, LeaveClockinCase } from "../types.ts";

export function DecisionResult({
  leaveCase,
  action,
}: {
  leaveCase: LeaveClockinCase;
  /** The confirmed decision; the copy follows it, never a default. */
  action: LeaveClockinAction;
}) {
  const t = useT();
  const cancelled = action === "cancel_leave";
  const date = formatBusinessDate(leaveCase.businessDate);
  const title = cancelled
    ? t("leaveClockinReview.result.cancelledTitle")
    : t("leaveClockinReview.result.keptTitle");
  const detail = cancelled
    ? t("leaveClockinReview.result.cancelledDetail", { date })
    : t("leaveClockinReview.result.keptDetail", { date });

  return (
    <div className="grid gap-4" data-testid="leave-clockin-result">
      <section
        aria-label={t("leaveClockinReview.detail.summaryTitle")}
        className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6"
      >
        <p className="min-w-0 text-lg leading-6 font-semibold break-words">
          {leaveCase.employeeName ??
            t("leaveClockinReview.detail.unknownEmployee")}
        </p>
        <p className="flex items-center gap-2 text-sm tabular">
          <CalendarDays
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {date}
        </p>
        <StatusPill status={cancelled ? "info" : "success"}>{title}</StatusPill>
      </section>

      <section
        role="status"
        className="grid gap-2 rounded-container bg-success-subtle p-card"
      >
        <h2 className="type-heading flex items-center gap-2 text-success">
          <CircleCheck className="size-5 shrink-0" aria-hidden="true" />
          {t("leaveClockinReview.result.banner")}
        </h2>
        <p className="text-sm leading-6 text-foreground">{detail}</p>
      </section>

      <div>
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link to="/kelola/absensi/tinjauan-cuti">
            <Undo2 aria-hidden="true" />
            {t("leaveClockinReview.result.back")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
