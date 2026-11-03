// Campaign detail (/kelola/kampanye/$campaignId; PRD v1.7 §3.21 "Kampanye",
// LOY-04). Shows status, content, A/B split and audience; the legal actions
// come from the contract's own state machine (`transitionCampaign` through
// `campaignActions`). Results are one StatStrip plus a send-status table, and
// the consent notice says how many recipients were skipped and why.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, CalendarClock, CircleSlash } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { EmptyState } from "@/components/ui/feedback-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formatNumber, type MessageKey } from "@starter/shared/i18n";
import type { CampaignAction, CampaignContent } from "@starter/shared/crm";
import { useOutletClock } from "@/lib/tenant-context";
import {
  useCampaignResults,
  useCampaigns,
  useSegments,
  useUpdateCampaign,
} from "../hooks";
import {
  CAMPAIGN_SEND_STATUSES,
  campaignActions,
  campaignActionLabelKey,
  channelHintKey,
  channelLabelKey,
  consentSkipReasonKey,
  formatDateTime,
  formatSplitPercent,
  fromDateTimeLocalValue,
  hasResults,
  sendExplanationKey,
  sendStatusCounts,
  toDateTimeLocalValue,
} from "../lib";
import { Notice, ReadError } from "./campaign-shell";
import { CampaignStatusPill, SendStatusPill } from "./campaign-status";

const ACTION_TOAST: Record<CampaignAction, MessageKey> = {
  schedule: "crmCampaigns.actionDialogs.scheduledToast",
  start: "crmCampaigns.actionDialogs.startedToast",
  complete: "crmCampaigns.actionDialogs.completedToast",
  cancel: "crmCampaigns.actionDialogs.cancelledToast",
};

function ContentBlock({
  label,
  content,
  testId,
}: {
  label: string;
  content: CampaignContent;
  testId?: string;
}) {
  const t = useT();
  return (
    <div data-testid={testId} className="grid gap-1">
      <p className="type-eyebrow text-muted-foreground">{label}</p>
      <p className="font-semibold">{content.title}</p>
      <p className="whitespace-pre-line text-sm leading-6">{content.body}</p>
      <p className="text-xs leading-4 text-muted-foreground">
        {content.templateRef === null
          ? t("crmCampaigns.detail.noTemplateRef")
          : `${t("crmCampaigns.detail.templateRef")}: ${content.templateRef}`}
      </p>
    </div>
  );
}

export function CampaignDetailPage({ campaignId }: { campaignId: string }) {
  const t = useT();
  const toast = useToast();
  const { timeZone } = useOutletClock();
  const campaignsQuery = useCampaigns();
  const resultsQuery = useCampaignResults(campaignId);
  const segmentsQuery = useSegments();
  const update = useUpdateCampaign();

  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [scheduleValue, setScheduleValue] = React.useState("");
  const [scheduleError, setScheduleError] = React.useState<string | undefined>(
    undefined,
  );
  const [actionFailed, setActionFailed] = React.useState(false);

  const campaign = campaignsQuery.data?.data.find(
    (candidate) => candidate.id === campaignId,
  );
  const results = resultsQuery.data?.data;
  const segment = segmentsQuery.data?.data.find(
    (candidate) => candidate.id === campaign?.segmentId,
  );

  function mutate(action: CampaignAction, scheduledAt?: string) {
    if (!campaign) return;
    setActionFailed(false);
    update.mutate(
      {
        campaignId: campaign.id,
        body: {
          action,
          ...(scheduledAt === undefined ? {} : { scheduledAt }),
        },
      },
      {
        onSuccess: (next) =>
          toast({
            title: t(ACTION_TOAST[action], { name: next.name }),
            tone: "success",
          }),
        onError: () => setActionFailed(true),
      },
    );
  }

  function chooseAction(action: CampaignAction) {
    if (!campaign) return;
    if (action === "schedule") {
      setScheduleValue(
        campaign.scheduledAt === null
          ? ""
          : toDateTimeLocalValue(campaign.scheduledAt, timeZone),
      );
      setScheduleError(undefined);
      setScheduleOpen(true);
      return;
    }
    if (action === "cancel") {
      setCancelOpen(true);
      return;
    }
    mutate(action);
  }

  function confirmSchedule() {
    const iso = fromDateTimeLocalValue(scheduleValue, timeZone);
    if (iso === null) {
      setScheduleError(t("crmCampaigns.create.validation.schedule"));
      return;
    }
    setScheduleOpen(false);
    mutate("schedule", iso);
  }

  if (campaignsQuery.isPending)
    return (
      <div aria-busy="true" className="grid gap-5">
        <Card>
          <div className="grid gap-3">
            <span className="sr-only">{t("common.loading")}</span>
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-control w-full" />
            <Skeleton className="h-control w-2/3" />
          </div>
        </Card>
      </div>
    );

  if (campaignsQuery.isError)
    return (
      <Card>
        <ReadError
          error={campaignsQuery.error}
          onRetry={() => void campaignsQuery.refetch()}
        />
      </Card>
    );

  if (!campaign)
    return (
      <Card>
        <EmptyState
          icon={CircleSlash}
          title={t("crmCampaigns.detail.notFoundTitle")}
          description={t("crmCampaigns.detail.notFoundHint")}
          action={
            <Button asChild variant="outline">
              <Link to="/kelola/kampanye">
                <ArrowLeft aria-hidden="true" />
                {t("crmCampaigns.detail.back")}
              </Link>
            </Button>
          }
        />
      </Card>
    );

  const actions = campaignActions(campaign.status);
  const counts = sendStatusCounts(results);
  const timestamp = (labelKey: MessageKey, iso: string | null) =>
    iso === null ? null : (
      <div className="grid gap-0.5">
        <dt className="type-eyebrow text-muted-foreground">{t(labelKey)}</dt>
        <dd className="tabular text-sm">{formatDateTime(iso, timeZone)}</dd>
      </div>
    );

  return (
    <div className="grid min-w-0 gap-5">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/kelola/kampanye">
            <ArrowLeft aria-hidden="true" />
            {t("crmCampaigns.detail.back")}
          </Link>
        </Button>
      </div>

      <CardShell>
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="type-title">{campaign.name}</h3>
                <CampaignStatusPill status={campaign.status} />
                <Badge tone="neutral">
                  {t(channelLabelKey(campaign.channel))}
                </Badge>
              </div>
              <p className="text-sm leading-5 text-muted-foreground">
                {t(channelHintKey(campaign.channel))}
              </p>
            </div>
            {actions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {actions.map((action) => (
                  <Button
                    key={action}
                    type="button"
                    variant={action === "cancel" ? "ghost" : "outline"}
                    size="sm"
                    className={action === "cancel" ? "text-danger" : undefined}
                    loading={update.isPending}
                    disabled={update.isPending}
                    onClick={() => chooseAction(action)}
                  >
                    {t(campaignActionLabelKey(action))}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("crmCampaigns.detail.noActions")}
              </p>
            )}
          </div>

          {actionFailed && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {t("crmCampaigns.actionDialogs.actionFailed")}
            </p>
          )}

          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            {timestamp("crmCampaigns.detail.scheduledAt", campaign.scheduledAt)}
            {timestamp("crmCampaigns.detail.createdAt", campaign.createdAt)}
            {timestamp("crmCampaigns.detail.startedAt", campaign.startedAt)}
            {timestamp("crmCampaigns.detail.completedAt", campaign.completedAt)}
            {timestamp("crmCampaigns.detail.cancelledAt", campaign.cancelledAt)}
          </dl>
        </Card>
      </CardShell>

      <CardShell>
        <Card>
          <h3 className="type-heading">
            {t("crmCampaigns.detail.contentTitle")}
          </h3>
          <ContentBlock
            label={t("crmCampaigns.detail.variantA")}
            content={campaign.content}
            testId="campaign-content-a"
          />
          {campaign.abTest === null ? (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("crmCampaigns.detail.abNone")}
            </p>
          ) : (
            <div className="grid gap-2 border-t pt-3">
              <ContentBlock
                label={t("crmCampaigns.detail.variantB")}
                content={campaign.abTest.variantB}
                testId="campaign-content-b"
              />
              <p className="text-sm font-semibold tabular">
                {t("crmCampaigns.detail.split", {
                  percent: formatSplitPercent(campaign.abTest.splitBp),
                })}
              </p>
            </div>
          )}
        </Card>
      </CardShell>

      <CardShell>
        <Card>
          <h3 className="type-heading">
            {t("crmCampaigns.detail.audienceTitle")}
          </h3>
          <div className="grid gap-0.5">
            <p className="text-sm font-semibold">
              {t("crmCampaigns.detail.segment")}:{" "}
              {segment?.name ?? t("crmCampaigns.detail.segmentMissing")}
            </p>
            {segment && (
              <p className="text-sm text-muted-foreground tabular">
                {t("crmCampaigns.detail.segmentSize", {
                  count: segment.size,
                })}
              </p>
            )}
          </div>
          <Notice tone="info" title={t("crmCampaigns.consent.title")}>
            <p>{t("crmCampaigns.consent.rule")}</p>
            {hasResults(results) && (
              <>
                <p className="mt-1">
                  {results !== undefined && results.skippedNoConsent > 0
                    ? t("crmCampaigns.consent.skipped", {
                        count: results.skippedNoConsent,
                      })
                    : t("crmCampaigns.consent.skippedNone")}
                </p>
                {results !== undefined && results.skippedNoConsent > 0 && (
                  <div className="mt-1">
                    <p>{t("crmCampaigns.consent.reasonsTitle")}</p>
                    <ul className="list-disc ps-5">
                      <li>{t(consentSkipReasonKey("no_marketing_consent"))}</li>
                      <li>{t(consentSkipReasonKey("membership_inactive"))}</li>
                    </ul>
                  </div>
                )}
              </>
            )}
          </Notice>
        </Card>
      </CardShell>

      <section
        aria-labelledby="campaign-results-heading"
        className="grid gap-2"
      >
        <h3 id="campaign-results-heading" className="type-title">
          {t("crmCampaigns.detail.resultsTitle")}
        </h3>
        {resultsQuery.isPending ? (
          <Card>
            <span className="sr-only">
              {t("crmCampaigns.detail.resultsPending")}
            </span>
            <div aria-busy="true" className="grid gap-2 sm:grid-cols-3">
              {Array.from({ length: 9 }, (_, index) => (
                <Skeleton key={index} className="h-16" />
              ))}
            </div>
          </Card>
        ) : resultsQuery.isError ? (
          <Card>
            <ReadError
              error={resultsQuery.error}
              onRetry={() => void resultsQuery.refetch()}
            />
          </Card>
        ) : (
          <StatStrip label={t("crmCampaigns.detail.statsLabel")} columns={3}>
            <StatTile
              label={t("crmCampaigns.detail.stats.recipients")}
              value={
                <NumberDisplay value={results?.recipients ?? 0} size="stat" />
              }
            />
            <StatTile
              label={t("crmCampaigns.detail.stats.sent")}
              value={<NumberDisplay value={results?.sent ?? 0} size="stat" />}
            />
            <StatTile
              label={t("crmCampaigns.detail.stats.delivered")}
              value={
                <NumberDisplay value={results?.delivered ?? 0} size="stat" />
              }
            />
            <StatTile
              label={t("crmCampaigns.detail.stats.failed")}
              value={<NumberDisplay value={results?.failed ?? 0} size="stat" />}
            />
            <StatTile
              label={t("crmCampaigns.detail.stats.skippedNoConsent")}
              value={
                <NumberDisplay
                  value={results?.skippedNoConsent ?? 0}
                  size="stat"
                />
              }
            />
            <StatTile
              label={t("crmCampaigns.detail.stats.opened")}
              value={<NumberDisplay value={results?.opened ?? 0} size="stat" />}
            />
            <StatTile
              label={t("crmCampaigns.detail.stats.redeemed")}
              value={
                <NumberDisplay value={results?.redeemed ?? 0} size="stat" />
              }
            />
            <StatTile
              label={t("crmCampaigns.detail.stats.revenue")}
              value={<Money amount={results?.revenueIdr ?? 0} size="stat" />}
            />
            <StatTile
              label={t("crmCampaigns.detail.stats.cost")}
              value={<Money amount={results?.costIdr ?? 0} size="stat" />}
            />
          </StatStrip>
        )}
        <p className="text-xs leading-4 text-muted-foreground">
          {t("crmCampaigns.detail.resultsNote")}
        </p>
      </section>

      <DataTableShell
        title={t("crmCampaigns.sends.title")}
        description={t("crmCampaigns.sends.description")}
        state={
          resultsQuery.isPending
            ? "loading"
            : resultsQuery.isError
              ? "error"
              : "ready"
        }
        onRetry={() => void resultsQuery.refetch()}
        loadingRows={5}
        rowCount={CAMPAIGN_SEND_STATUSES.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("crmCampaigns.sends.columns.status")}</TableHead>
              <TableHead numeric>
                {t("crmCampaigns.sends.columns.count")}
              </TableHead>
              <TableHead>
                {t("crmCampaigns.sends.columns.explanation")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {CAMPAIGN_SEND_STATUSES.map((status) => (
              <TableRow key={status}>
                <TableCell>
                  <SendStatusPill status={status} />
                </TableCell>
                <TableCell numeric>{formatNumber(counts[status])}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {t(sendExplanationKey(status))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="px-card py-2.5 text-xs leading-4 text-muted-foreground">
          {t("crmCampaigns.sends.caption")}
        </p>
      </DataTableShell>

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("crmCampaigns.actionDialogs.scheduleTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("crmCampaigns.actionDialogs.scheduleHint")}
            </DialogDescription>
          </DialogHeader>
          <FormField
            label={t("crmCampaigns.create.scheduledAtLabel")}
            required
            error={scheduleError}
          >
            <Input
              type="datetime-local"
              value={scheduleValue}
              onChange={(event) => {
                setScheduleValue(event.target.value);
                setScheduleError(undefined);
              }}
              className="tabular"
            />
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setScheduleOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={confirmSchedule}>
              <CalendarClock aria-hidden="true" />
              {t("crmCampaigns.actionDialogs.scheduleSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("crmCampaigns.actionDialogs.cancelTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("crmCampaigns.actionDialogs.cancelHint")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCancelOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setCancelOpen(false);
                mutate("cancel");
              }}
            >
              <CircleSlash aria-hidden="true" />
              {t("crmCampaigns.actionDialogs.cancelConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
