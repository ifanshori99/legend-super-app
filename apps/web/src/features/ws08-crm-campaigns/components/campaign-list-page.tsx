// Campaign list (/kelola/kampanye; PRD v1.7 §3.21 "Kampanye"): every campaign
// with its status, channel, schedule, A/B split and results summary (penerima,
// terkirim, redeem, pendapatan). Creating a campaign opens the form dialog.
// LOY-04 is stated above the table and the skipped recipients of the finished
// campaigns are counted from their results.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Eye, Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  Campaign,
  CampaignResults,
  CampaignStatus,
} from "@starter/shared/crm";
import { formatNumber } from "@starter/shared/i18n";
import { useOutletClock } from "@/lib/tenant-context";
import { useCampaignResultsMany, useCampaigns } from "../hooks";
import {
  CAMPAIGN_STATUSES,
  channelLabelKey,
  formatDateTime,
  formatSplitPercent,
  hasResults,
  sortCampaigns,
  totalSkippedNoConsent,
} from "../lib";
import { CampaignFormDialog } from "./campaign-form-dialog";
import { CampaignsPage, Notice } from "./campaign-shell";
import { CampaignStatusPill } from "./campaign-status";

type StatusFilter = "all" | CampaignStatus;

const DASH = "—";

function resultOf(
  results: Map<string, CampaignResults>,
  campaign: Campaign,
): CampaignResults | undefined {
  return results.get(campaign.id);
}

export function CampaignListPage() {
  const t = useT();
  const { timeZone } = useOutletClock();
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [search, setSearch] = React.useState("");
  const [formOpen, setFormOpen] = React.useState(false);

  const campaignsQuery = useCampaigns(
    statusFilter === "all" ? undefined : statusFilter,
  );
  const campaigns = React.useMemo(
    () => sortCampaigns(campaignsQuery.data?.data ?? []),
    [campaignsQuery.data],
  );
  const filtered = campaigns.filter((campaign) =>
    campaign.name
      .toLocaleLowerCase("id-ID")
      .includes(search.trim().toLocaleLowerCase("id-ID")),
  );

  // Results only exist for finished campaigns; ask for exactly those.
  const completedIds = React.useMemo(
    () =>
      campaigns
        .filter((campaign) => campaign.status === "completed")
        .map((campaign) => campaign.id),
    [campaigns],
  );
  const resultsQueries = useCampaignResultsMany(completedIds);
  const results = new Map<string, CampaignResults>();
  completedIds.forEach((campaignId, index) => {
    const data = resultsQueries[index]?.data?.data;
    if (data) results.set(campaignId, data);
  });
  const resultsLoaded =
    completedIds.length > 0 &&
    resultsQueries.every((query) => query.isSuccess || query.isError);
  const skippedTotal = totalSkippedNoConsent(
    completedIds.map((campaignId) => results.get(campaignId)),
  );

  const state = campaignsQuery.isPending
    ? "loading"
    : campaignsQuery.isError
      ? "error"
      : campaigns.length === 0
        ? "empty"
        : "ready";
  const filteredEmpty = statusFilter !== "all" && campaigns.length === 0;

  const addButton = (variant: "default" | "outline") => (
    <Button variant={variant} onClick={() => setFormOpen(true)}>
      <Plus aria-hidden="true" />
      {t("crmCampaigns.list.add")}
    </Button>
  );

  const resultsLine = (result?: CampaignResults) =>
    hasResults(result) ? formatNumber(result?.recipients ?? 0) : DASH;

  return (
    <CampaignsPage active="campaigns">
      <Notice tone="info" title={t("crmCampaigns.consent.title")}>
        <p>{t("crmCampaigns.consent.rule")}</p>
        {resultsLoaded && (
          <p className="mt-1">
            {skippedTotal > 0
              ? t("crmCampaigns.consent.skipped", { count: skippedTotal })
              : t("crmCampaigns.consent.skippedNone")}
          </p>
        )}
      </Notice>

      <DataTableShell
        title={t("crmCampaigns.list.title")}
        description={t("crmCampaigns.list.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("crmCampaigns.list.searchLabel"),
        }}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as StatusFilter)}
            >
              <SelectTrigger
                aria-label={t("crmCampaigns.list.filterLabel")}
                className="sm:w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("crmCampaigns.list.filterAll")}
                </SelectItem>
                {CAMPAIGN_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(`crmCampaigns.status.${status}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {addButton("default")}
          </div>
        }
        onRetry={() => void campaignsQuery.refetch()}
        empty={{
          title: filteredEmpty
            ? t("crmCampaigns.list.emptyFilteredTitle")
            : t("crmCampaigns.list.emptyTitle"),
          description: filteredEmpty
            ? t("crmCampaigns.list.emptyFilteredHint")
            : t("crmCampaigns.list.emptyHint"),
          action: filteredEmpty ? undefined : addButton("outline"),
        }}
        noResults={filtered.length === 0 && campaigns.length > 0}
        rowCount={filtered.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("crmCampaigns.list.columns.name")}</TableHead>
                <TableHead>{t("crmCampaigns.list.columns.status")}</TableHead>
                <TableHead>{t("crmCampaigns.list.columns.channel")}</TableHead>
                <TableHead>{t("crmCampaigns.list.columns.schedule")}</TableHead>
                <TableHead>{t("crmCampaigns.list.columns.ab")}</TableHead>
                <TableHead numeric>
                  {t("crmCampaigns.list.columns.recipients")}
                </TableHead>
                <TableHead numeric>
                  {t("crmCampaigns.list.columns.sent")}
                </TableHead>
                <TableHead numeric>
                  {t("crmCampaigns.list.columns.redeemed")}
                </TableHead>
                <TableHead numeric>
                  {t("crmCampaigns.list.columns.revenue")}
                </TableHead>
                <TableHead numeric>
                  {t("crmCampaigns.list.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((campaign) => {
                const result = resultOf(results, campaign);
                return (
                  <TableRow key={campaign.id}>
                    <TableCell className="font-medium">
                      <Link
                        to="/kelola/kampanye/$campaignId"
                        params={{ campaignId: campaign.id }}
                        className="underline-offset-4 hover:underline"
                      >
                        {campaign.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <CampaignStatusPill status={campaign.status} />
                    </TableCell>
                    <TableCell>
                      <Badge tone="neutral">
                        {t(channelLabelKey(campaign.channel))}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular text-sm">
                      {campaign.scheduledAt === null ? (
                        <span className="text-muted-foreground">
                          {t("crmCampaigns.list.notScheduled")}
                        </span>
                      ) : (
                        <span className="tabular">
                          {formatDateTime(campaign.scheduledAt, timeZone)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-sm">
                      {campaign.abTest === null ? (
                        <span className="text-muted-foreground">
                          {t("crmCampaigns.list.noAb")}
                        </span>
                      ) : (
                        t("crmCampaigns.list.abSplit", {
                          percent: formatSplitPercent(campaign.abTest.splitBp),
                        })
                      )}
                    </TableCell>
                    <TableCell numeric>
                      {hasResults(result)
                        ? formatNumber(result?.recipients ?? 0)
                        : DASH}
                    </TableCell>
                    <TableCell numeric>
                      {hasResults(result)
                        ? formatNumber(result?.sent ?? 0)
                        : DASH}
                    </TableCell>
                    <TableCell numeric>
                      {hasResults(result)
                        ? formatNumber(result?.redeemed ?? 0)
                        : DASH}
                    </TableCell>
                    <TableCell numeric>
                      {hasResults(result) ? (
                        <Money amount={result?.revenueIdr ?? 0} size="sm" />
                      ) : (
                        DASH
                      )}
                    </TableCell>
                    <TableCell numeric>
                      <Button asChild variant="ghost" size="icon-sm">
                        <Link
                          to="/kelola/kampanye/$campaignId"
                          params={{ campaignId: campaign.id }}
                          aria-label={t("crmCampaigns.list.open", {
                            name: campaign.name,
                          })}
                        >
                          <Eye aria-hidden="true" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {filtered.map((campaign) => {
            const result = resultOf(results, campaign);
            return (
              <li
                key={campaign.id}
                className="grid gap-2 border-b px-card py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <Link
                    to="/kelola/kampanye/$campaignId"
                    params={{ campaignId: campaign.id }}
                    className="min-w-0 font-medium underline-offset-4 hover:underline"
                  >
                    {campaign.name}
                  </Link>
                  <CampaignStatusPill status={campaign.status} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge tone="neutral">
                    {t(channelLabelKey(campaign.channel))}
                  </Badge>
                  <span className="tabular">
                    {campaign.scheduledAt === null
                      ? t("crmCampaigns.list.notScheduled")
                      : formatDateTime(campaign.scheduledAt, timeZone)}
                  </span>
                  {campaign.abTest !== null && (
                    <span className="tabular">
                      {t("crmCampaigns.list.abSplit", {
                        percent: formatSplitPercent(campaign.abTest.splitBp),
                      })}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1 text-sm tabular">
                  <span className="text-muted-foreground">
                    {t("crmCampaigns.list.columns.recipients")}:{" "}
                    {resultsLine(result)}
                  </span>
                  <span className="text-muted-foreground">
                    {t("crmCampaigns.list.columns.sent")}:{" "}
                    {hasResults(result)
                      ? formatNumber(result?.sent ?? 0)
                      : DASH}
                  </span>
                  <span className="text-muted-foreground">
                    {t("crmCampaigns.list.columns.redeemed")}:{" "}
                    {hasResults(result)
                      ? formatNumber(result?.redeemed ?? 0)
                      : DASH}
                  </span>
                  <span className="text-muted-foreground">
                    {t("crmCampaigns.list.columns.revenue")}:{" "}
                    {hasResults(result) ? (
                      <Money amount={result?.revenueIdr ?? 0} size="sm" />
                    ) : (
                      DASH
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </DataTableShell>

      {/* The key remounts the dialog, so each open starts from an empty form. */}
      <CampaignFormDialog
        key={formOpen ? "open" : "closed"}
        open={formOpen}
        onOpenChange={setFormOpen}
      />
    </CampaignsPage>
  );
}
