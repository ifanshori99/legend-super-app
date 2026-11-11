// Result of a saved leave clock-in decision, shown on the detail page (bead
// legend-3jem1). Keeping the leave is never rendered as "Ditolak": the API
// stores it as a rejected review, but HR decided the leave stands.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { CircleCheck, Undo2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatBusinessDate } from "@/features/ws10-attendance-qr/format.ts";
import type { LeaveClockinAction, LeaveClockinCase } from "../types.ts";
import { KindPill } from "./kind-pill.tsx";

export function DecisionResult({
  leaveCase,
  action,
  focusOnMount = false,
}: {
  leaveCase: LeaveClockinCase;
  /** The confirmed decision; the copy follows it, never a default. */
  action: LeaveClockinAction;
  /** Move focus to the heading (right after a save, when the dialog closed). */
  focusOnMount?: boolean;
}) {
  const t = useT();
  const heading = React.useRef<HTMLHeadingElement>(null);
  // The dialog that held focus is gone: the saved heading takes it, so a
  // screen reader announces the outcome instead of landing on the page top.
  React.useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);
  const cancelled = action === "cancel_leave";
  const date = formatBusinessDate(leaveCase.businessDate);
  const title = cancelled
    ? t("leaveClockinReview.result.cancelledTitle")
    : t("leaveClockinReview.result.keptTitle");
  const detail = cancelled
    ? t("leaveClockinReview.result.cancelledDetail", { date })
    : t("leaveClockinReview.result.keptDetail", { date });

  const facts: { label: string; value: React.ReactNode }[] = [
    {
      label: t("leaveClockinReview.result.employee"),
      value:
        leaveCase.employeeName ??
        t("leaveClockinReview.detail.unknownEmployee"),
    },
    {
      label: t("leaveClockinReview.result.date"),
      value: <span className="tabular">{date}</span>,
    },
    {
      label: t("leaveClockinReview.result.caseKind"),
      value: <KindPill kind={leaveCase.kind} />,
    },
    {
      label: t("leaveClockinReview.result.status"),
      value: (
        <StatusPill status={cancelled ? "info" : "success"}>{title}</StatusPill>
      ),
    },
  ];

  return (
    <div className="grid gap-4" data-testid="leave-clockin-result">
      <section className="grid gap-2 rounded-container bg-success-subtle p-card">
        <h3
          ref={heading}
          tabIndex={-1}
          className="type-heading flex items-center gap-2 text-success outline-none"
        >
          <CircleCheck className="size-5 shrink-0" aria-hidden="true" />
          {t("leaveClockinReview.result.banner")}
        </h3>
        <p className="leading-6 text-foreground">{detail}</p>
      </section>

      <section
        aria-label={t("leaveClockinReview.detail.summaryTitle")}
        className="rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
      >
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]">
          {facts.map((fact) => (
            <div
              key={fact.label}
              className="grid grid-cols-[8rem_1fr] items-center gap-3 sm:contents"
            >
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="min-w-0 font-semibold break-words">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div>
        <Button asChild className="w-full sm:w-auto">
          <Link to="/kelola/absensi/tinjauan-cuti">
            <Undo2 aria-hidden="true" />
            {t("leaveClockinReview.result.back")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
