// AI-11 "Ringkasan Ulasan" panel (PRD v1.7 §3.21 "Ulasan & Keluhan": review
// summary; AI-11 table). The panel is titled "Dibantu AI" but shows only what
// the loaded queue can prove: counts, the mean rating and open complaints per
// outlet. Theme extraction needs the AI service, which the CRM contract does
// not expose yet, so the footer says so instead of inventing themes.
import * as React from "react";
import { Sparkles } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import type { Feedback, FeedbackStatus } from "@starter/shared/crm";
import { Badge } from "@/components/ui/badge";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { summarizeFeedback, shortRef } from "../lib";
import { useCrm360T } from "../t";
import { FeedbackStatusPill } from "./crm-shell";

const STATUSES: readonly FeedbackStatus[] = [
  "open",
  "in_review",
  "resolved",
  "closed",
];

export function AiSummaryPanel({
  rows,
  loading = false,
}: {
  rows: readonly Feedback[];
  loading?: boolean;
}) {
  const t = useCrm360T();
  const summary = React.useMemo(() => summarizeFeedback(rows), [rows]);
  const openComplaints = summary.openComplaintsByOutlet.reduce(
    (total, row) => total + row.count,
    0,
  );

  return (
    <section className="grid min-w-0 gap-3" aria-label={t("crm360.ai.title")}>
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="type-title">{t("crm360.ai.title")}</h3>
          <Badge tone="info">
            <Sparkles aria-hidden="true" />
            {t("crm360.ai.badge")}
          </Badge>
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("crm360.ai.description")}
        </p>
        {!loading && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("crm360.ai.computedFrom", {
              count: formatNumber(summary.total),
            })}
          </p>
        )}
      </header>

      {loading ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-28" />
          <Skeleton className="h-24" />
        </div>
      ) : summary.total === 0 ? (
        <CardShell>
          <CardShellBody>
            <EmptyState
              title={t("crm360.ai.emptyTitle")}
              description={t("crm360.ai.emptyHint")}
            />
          </CardShellBody>
        </CardShell>
      ) : (
        <>
          <StatStrip label={t("crm360.ai.title")}>
            <StatTile
              label={t("crm360.ai.averageRating")}
              value={
                summary.averageRating === null ? (
                  <span className="text-muted-foreground">
                    {t("crm360.ai.noValue")}
                  </span>
                ) : (
                  <NumberDisplay
                    value={summary.averageRating}
                    fractionDigits={1}
                    size="stat"
                  />
                )
              }
              context={
                summary.ratings === 0
                  ? t("crm360.ai.noRatings")
                  : t("crm360.ai.averageContext", {
                      count: formatNumber(summary.ratings),
                    })
              }
            />
            <StatTile
              label={t("crm360.ai.ratings")}
              value={<NumberDisplay value={summary.ratings} size="stat" />}
              context={t("crm360.ai.ratingsContext", {
                count: formatNumber(summary.ratings),
                total: formatNumber(summary.total),
              })}
            />
            <StatTile
              label={t("crm360.ai.complaints")}
              value={<NumberDisplay value={summary.complaints} size="stat" />}
              context={t("crm360.ai.complaintsContext", {
                count: formatNumber(openComplaints),
              })}
            />
            <StatTile
              label={t("crm360.ai.recent")}
              value={<NumberDisplay value={summary.recentCount} size="stat" />}
              context={t("crm360.ai.recentContext")}
            />
          </StatStrip>

          <CardShell>
            <CardShellBody>
              <div className="grid gap-5 p-card sm:grid-cols-2">
                <div className="grid gap-2">
                  <h4 className="type-eyebrow text-muted-foreground">
                    {t("crm360.ai.statusTitle")}
                  </h4>
                  <ul className="grid gap-1.5">
                    {STATUSES.map((status) => (
                      <li
                        key={status}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <FeedbackStatusPill status={status} />
                        <span className="text-sm font-semibold tabular">
                          {formatNumber(summary.byStatus[status])}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="grid gap-2">
                  <h4 className="type-eyebrow text-muted-foreground">
                    {t("crm360.ai.outletTitle")}
                  </h4>
                  {summary.openComplaintsByOutlet.length === 0 ? (
                    <p className="text-sm leading-5 text-muted-foreground">
                      {t("crm360.ai.noOpenComplaints")}
                    </p>
                  ) : (
                    <ul className="grid gap-1.5">
                      {summary.openComplaintsByOutlet.map((row) => (
                        <li
                          key={row.outletId}
                          className="flex flex-wrap items-center justify-between gap-2 text-sm"
                        >
                          <span className="min-w-0 break-words">
                            {t("crm360.feedback.outletRef", {
                              ref: shortRef(row.outletId),
                            })}
                          </span>
                          <span className="font-semibold tabular">
                            {formatNumber(row.count)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </CardShellBody>
            <CardShellFooter>{t("crm360.ai.limitNote")}</CardShellFooter>
          </CardShell>
        </>
      )}
    </section>
  );
}
