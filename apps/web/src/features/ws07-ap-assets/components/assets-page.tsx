// Fixed assets (PRD v1.7 §3.19 "Aset Tetap [P0] — Registrasi aset dari
// pembelian, depresiasi otomatis, revaluasi, dan penjualan aset"). The register
// carries the straight-line figures; the depreciation card below shows the
// posted runs and starts a new one.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Play, Plus } from "lucide-react";
import type { FixedAsset } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  businessDateToday,
  formatBusinessDate,
  formatPeriod,
} from "@/features/ws07-accounting/lib";
import {
  useDepreciationRuns,
  useFixedAssets,
  useRunDepreciation,
} from "../hooks";
import {
  assetBookValueIdr,
  assetCode,
  assetTotals,
  filterAssets,
  type AssetStatusFilter,
} from "../lib";
import { FixedAssetDetailDialog } from "./asset-detail-dialog";
import { FixedAssetFormDialog } from "./asset-form-dialog";
import { AssetStatusBadge, DepreciationRunStatusBadge } from "./status-badge";

const STATUS_FILTERS: readonly AssetStatusFilter[] = [
  "all",
  "active",
  "fully_depreciated",
  "disposed",
];

export function FixedAssetsPage({ legalEntityId }: { legalEntityId: string }) {
  const t = useT();
  const assetsQuery = useFixedAssets(legalEntityId);
  const runsQuery = useDepreciationRuns(legalEntityId);
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<AssetStatusFilter>("all");
  const [formOpen, setFormOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [runOpen, setRunOpen] = React.useState(false);

  const assets = React.useMemo(
    () => assetsQuery.data ?? [],
    [assetsQuery.data],
  );
  const visible = React.useMemo(
    () => filterAssets(assets, { query: search, status }),
    [assets, search, status],
  );
  const totals = React.useMemo(() => assetTotals(assets), [assets]);
  const runs = React.useMemo(() => runsQuery.data ?? [], [runsQuery.data]);

  const state: DataState = assetsQuery.isPending
    ? "loading"
    : assetsQuery.isError
      ? "error"
      : assets.length === 0
        ? "empty"
        : "ready";
  const statusLabel = (value: AssetStatusFilter) => {
    if (value === "all") return t("accounting.ap.assets.filter.all");
    if (value === "active") return t("accounting.ap.assets.status.active");
    if (value === "fully_depreciated")
      return t("accounting.ap.assets.status.fully_depreciated");
    return t("accounting.ap.assets.status.disposed");
  };
  const runState: DataState = runsQuery.isPending
    ? "loading"
    : runsQuery.isError
      ? "error"
      : runs.length === 0
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 gap-5">
      {assetsQuery.isPending ? (
        <div
          className="grid gap-2 rounded-shell border-(length:--border-w) bg-shell p-2 shadow-hairline sm:grid-cols-2 lg:grid-cols-4"
          aria-busy="true"
        >
          <span className="sr-only">{t("common.loading")}</span>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : assetsQuery.data ? (
        <StatStrip label={t("accounting.ap.assets.title")} columns={4}>
          <StatTile
            label={t("accounting.ap.assets.stats.acquisition")}
            value={<Money amount={totals.acquisitionIdr} size="stat" />}
            context={t("accounting.ap.assets.stats.context", {
              count: totals.totalCount,
            })}
          />
          <StatTile
            label={t("accounting.ap.assets.stats.accumulated")}
            value={<Money amount={totals.accumulatedIdr} size="stat" />}
            context={t("accounting.ap.assets.stats.context", {
              count: totals.totalCount,
            })}
          />
          <StatTile
            label={t("accounting.ap.assets.stats.bookValue")}
            value={<Money amount={totals.bookValueIdr} size="stat" />}
            context={t("accounting.ap.assets.stats.context", {
              count: totals.totalCount,
            })}
          />
          <StatTile
            label={t("accounting.ap.assets.stats.active")}
            value={<NumberDisplay value={totals.activeCount} size="stat" />}
            context={t("accounting.ap.assets.stats.context", {
              count: totals.totalCount,
            })}
          />
        </StatStrip>
      ) : null}

      <DataTableShell
        title={t("accounting.ap.assets.title")}
        description={t("accounting.ap.assets.subtitle")}
        state={state}
        onRetry={() => {
          void assetsQuery.refetch();
        }}
        search={{
          value: search,
          onChange: setSearch,
          label: t("accounting.ap.assets.search"),
        }}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as AssetStatusFilter)}
            >
              <SelectTrigger
                className="h-control-sm sm:w-44"
                aria-label={t("accounting.ap.assets.filter.status")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {statusLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {state !== "empty" && (
              <Button type="button" size="sm" onClick={() => setFormOpen(true)}>
                <Plus aria-hidden="true" />
                {t("accounting.ap.assets.add")}
              </Button>
            )}
          </div>
        }
        noResults={
          search.trim() !== "" || status !== "all"
            ? visible.length === 0
            : false
        }
        rowCount={visible.length}
        loadingRows={4}
        empty={{
          title: t("accounting.ap.assets.emptyTitle"),
          description: t("accounting.ap.assets.emptyHint"),
          action: (
            <Button type="button" size="sm" onClick={() => setFormOpen(true)}>
              <Plus aria-hidden="true" />
              {t("accounting.ap.assets.add")}
            </Button>
          ),
        }}
      >
        <ul className="divide-y divide-border md:hidden">
          {visible.map((asset) => (
            <li key={asset.id} className="grid gap-2 p-card">
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="truncate font-medium">{asset.name}</span>
                  <span className="text-xs tabular text-muted-foreground">
                    {assetCode(asset)}
                  </span>
                </div>
                <AssetStatusBadge status={asset.status} />
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <div className="grid gap-0.5">
                  <dt className="text-xs text-muted-foreground">
                    {t("accounting.ap.assets.columns.cost")}
                  </dt>
                  <dd>
                    <Money amount={asset.costIdr} size="sm" />
                  </dd>
                </div>
                <div className="grid gap-0.5">
                  <dt className="text-xs text-muted-foreground">
                    {t("accounting.ap.assets.columns.bookValue")}
                  </dt>
                  <dd>
                    <Money amount={assetBookValueIdr(asset)} size="sm" />
                  </dd>
                </div>
              </dl>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                aria-label={`${t("accounting.ap.assets.columns.action")} ${asset.name}`}
                onClick={() => setDetailId(asset.id)}
              >
                {t("accounting.ap.assets.columns.action")}
                <ChevronRight aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
        <div className="hidden md:block">
          <Table className="min-w-[64rem]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("accounting.ap.assets.columns.code")}</TableHead>
                <TableHead>{t("accounting.ap.assets.columns.name")}</TableHead>
                <TableHead>
                  {t("accounting.ap.assets.columns.acquiredOn")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.ap.assets.columns.cost")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.ap.assets.columns.accumulated")}
                </TableHead>
                <TableHead numeric>
                  {t("accounting.ap.assets.columns.bookValue")}
                </TableHead>
                <TableHead>
                  {t("accounting.ap.assets.columns.status")}
                </TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">
                    {t("accounting.ap.assets.columns.action")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((asset) => (
                <AssetRow
                  key={asset.id}
                  asset={asset}
                  onOpen={() => setDetailId(asset.id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>

      <DataTableShell
        title={t("accounting.ap.depreciation.title")}
        description={t("accounting.ap.depreciation.subtitle")}
        state={runState}
        onRetry={() => {
          void runsQuery.refetch();
        }}
        actions={
          runState === "empty" ? undefined : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRunOpen(true)}
            >
              <Play aria-hidden="true" />
              {t("accounting.ap.depreciation.run")}
            </Button>
          )
        }
        loadingRows={3}
        empty={{
          title: t("accounting.ap.depreciation.emptyTitle"),
          description: t("accounting.ap.depreciation.emptyHint"),
          action: (
            <Button type="button" size="sm" onClick={() => setRunOpen(true)}>
              <Play aria-hidden="true" />
              {t("accounting.ap.depreciation.emptyAction")}
            </Button>
          ),
        }}
      >
        <Table className="min-w-[44rem]">
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("accounting.ap.depreciation.columns.period")}
              </TableHead>
              <TableHead>
                {t("accounting.ap.depreciation.columns.status")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.ap.depreciation.columns.assets")}
              </TableHead>
              <TableHead numeric>
                {t("accounting.ap.depreciation.columns.total")}
              </TableHead>
              <TableHead>
                {t("accounting.ap.depreciation.columns.journal")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="tabular">
                  {formatPeriod(run.period)}
                </TableCell>
                <TableCell>
                  <DepreciationRunStatusBadge run={run} />
                </TableCell>
                <TableCell numeric>
                  <NumberDisplay value={run.lines.length} />
                </TableCell>
                <TableCell numeric>
                  <Money amount={run.amountIdr} />
                </TableCell>
                <TableCell>
                  {run.journalEntryId ? (
                    <Button asChild variant="link" size="sm">
                      <Link
                        to="/kelola/akuntansi/jurnal/$journalEntryId"
                        params={{ journalEntryId: run.journalEntryId }}
                      >
                        {t("accounting.manual.open")}
                      </Link>
                    </Button>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>

      <FixedAssetFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        legalEntityId={legalEntityId}
      />
      <FixedAssetDetailDialog
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
        fixedAssetId={detailId}
      />
      <DepreciationRunDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        legalEntityId={legalEntityId}
        existingPeriods={runs.map((run) => run.period)}
      />
    </div>
  );
}

function AssetRow({
  asset,
  onOpen,
}: {
  asset: FixedAsset;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <TableRow>
      <TableCell className="tabular text-muted-foreground">
        {assetCode(asset)}
      </TableCell>
      <TableCell className="font-medium">{asset.name}</TableCell>
      <TableCell className="whitespace-nowrap tabular">
        {formatBusinessDate(asset.acquiredOn)}
      </TableCell>
      <TableCell numeric>
        <Money amount={asset.costIdr} />
      </TableCell>
      <TableCell numeric>
        <Money amount={asset.accumulatedDepreciationIdr} />
      </TableCell>
      <TableCell numeric>
        <Money amount={assetBookValueIdr(asset)} />
      </TableCell>
      <TableCell>
        <AssetStatusBadge status={asset.status} />
      </TableCell>
      <TableCell className="text-right">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`${t("accounting.ap.assets.columns.action")} ${asset.name}`}
          onClick={onOpen}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function DepreciationRunDialog({
  open,
  onOpenChange,
  legalEntityId,
  existingPeriods,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  existingPeriods: readonly string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DepreciationRunForm
          legalEntityId={legalEntityId}
          existingPeriods={existingPeriods}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

function DepreciationRunForm({
  legalEntityId,
  existingPeriods,
  onOpenChange,
}: {
  legalEntityId: string;
  existingPeriods: readonly string[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const run = useRunDepreciation();
  const today = React.useMemo(() => businessDateToday(), []);
  const [period, setPeriod] = React.useState(() => today.slice(0, 7));
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      const result = await run.mutateAsync({
        legalEntityId,
        period,
      });
      if (existingPeriods.includes(period))
        toast({
          title: t("accounting.ap.depreciation.alreadyRun", { period }),
        });
      else if (result.amountIdr === 0)
        toast({ title: t("accounting.ap.depreciation.noAssets") });
      else toast({ title: t("accounting.ap.depreciation.saved", { period }) });
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("state.errorTitle"),
      );
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.ap.depreciation.runTitle")}</DialogTitle>
        <DialogDescription>
          {t("accounting.ap.depreciation.runHint")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField
          label={t("accounting.ap.depreciation.period")}
          hint={t("accounting.ap.depreciation.periodHint")}
          required
        >
          <Input
            type="month"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
            className="tabular"
          />
        </FormField>
        {error && (
          <p
            role="alert"
            className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={run.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={run.isPending}>
            {t("accounting.ap.depreciation.submit")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
