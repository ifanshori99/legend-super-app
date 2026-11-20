// /kelola/akuntansi/bagi-hasil/distribusi — the distribution cycle per profit
// entity (PRD §3.37 "Siklus Distribusi", §4 "Alur P", SH-02, SH-04). The page
// owns the selected run, so the wizard resumes from the run's status; an
// approved run opens locked and only an adjustment distribution changes it.
import * as React from "react";
import type {
  DistributionRun,
  DistributionRunSummary,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { type DataState } from "@/components/ui/data-table-shell";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { useCanPostJournals } from "@/features/ws07-accounting/guard";
import { useCanApproveShareAllocation } from "../guard";
import { useDistributionRuns, useProfitEntities } from "../hooks";
import { distributedNetIdr, openRuns } from "../lib";
import { AdjustmentDialog } from "./adjustment-dialog";
import { DistributionRunsTable } from "./distribution-runs-table";
import { DistributionWizardDialog } from "./distribution-wizard";
import { ProfitEntityDialog, ProfitEntityPicker } from "./profit-entity-picker";

export function DistributionsPage({
  legalEntityId,
}: {
  legalEntityId: string;
}) {
  const t = useT();
  const canWrite = useCanPostJournals();
  const canApprove = useCanApproveShareAllocation();
  const entitiesQuery = useProfitEntities();
  const [selectedEntityId, setSelectedEntityId] = React.useState<string | null>(
    null,
  );
  const [entityDialogOpen, setEntityDialogOpen] = React.useState(false);
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const [startCancel, setStartCancel] = React.useState(false);
  const [adjustTarget, setAdjustTarget] =
    React.useState<DistributionRun | null>(null);

  const entities = entitiesQuery.data ?? [];
  const entity = React.useMemo(
    () =>
      entities.find((row) => row.id === selectedEntityId) ??
      entities.find((row) => row.legalEntityId === legalEntityId) ??
      entities[0],
    [entities, selectedEntityId, legalEntityId],
  );
  const runsQuery = useDistributionRuns(entity?.id);
  const runs = runsQuery.data?.data ?? [];
  const state: DataState = runsQuery.isPending
    ? "loading"
    : runsQuery.isError
      ? "error"
      : runs.length === 0
        ? "empty"
        : "ready";

  const stats = entity ? openRuns(runs, entity.id) : null;
  const distributed = entity ? distributedNetIdr(runs, entity.id) : 0;

  const openNew = () => {
    setStartCancel(false);
    setSelectedRunId(null);
    setWizardOpen(true);
  };
  const openRun = (run: DistributionRunSummary, cancel = false) => {
    setStartCancel(cancel);
    setSelectedRunId(run.id);
    setWizardOpen(true);
  };

  return (
    <div className="grid min-w-0 gap-5">
      <header className="grid gap-1">
        <h2 className="type-title">{t("accounting.share.title")}</h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("accounting.share.subtitle")}
        </p>
      </header>

      {entitiesQuery.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-control-sm w-52" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : entitiesQuery.isError ? (
        <ErrorState
          onRetry={() => {
            void entitiesQuery.refetch();
          }}
        />
      ) : !entity ? (
        <EmptyState
          title={t("accounting.share.entityEmptyTitle")}
          description={t("accounting.share.entityEmptyHint")}
          action={
            canWrite ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setEntityDialogOpen(true)}
              >
                {t("accounting.share.entityAdd")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ProfitEntityPicker
            entities={entities}
            value={entity.id}
            onChange={(profitEntityId) => {
              setSelectedEntityId(profitEntityId);
              setWizardOpen(false);
              setSelectedRunId(null);
            }}
            onAdd={() => setEntityDialogOpen(true)}
          />

          <StatStrip label={t("accounting.share.runs.stats.label")} columns={3}>
            <StatTile
              label={t("accounting.share.runs.stats.distributed")}
              value={<Money amount={distributed} />}
              context={t("accounting.share.runs.stats.distributedContext")}
            />
            <StatTile
              label={t("accounting.share.runs.stats.awaitingApproval")}
              value={<NumberDisplay value={stats?.awaitingApproval ?? 0} />}
              context={t("accounting.share.runs.stats.awaitingApprovalContext")}
            />
            <StatTile
              label={t("accounting.share.runs.stats.awaitingPayment")}
              value={<NumberDisplay value={stats?.awaitingPayment ?? 0} />}
              context={t("accounting.share.runs.stats.awaitingPaymentContext")}
            />
          </StatStrip>

          <DistributionRunsTable
            runs={runs}
            state={state}
            canWrite={canWrite}
            canApprove={canApprove}
            onRetry={() => {
              void runsQuery.refetch();
            }}
            onCreate={openNew}
            onOpen={(run) => openRun(run)}
            onCancelApproved={(run) => openRun(run, true)}
          />
        </>
      )}

      <ProfitEntityDialog
        open={entityDialogOpen}
        onOpenChange={setEntityDialogOpen}
      />

      {entity && (
        <DistributionWizardDialog
          open={wizardOpen}
          onOpenChange={(open) => {
            setWizardOpen(open);
            if (!open) setSelectedRunId(null);
          }}
          legalEntityId={legalEntityId}
          profitEntity={entity}
          runId={selectedRunId}
          onRunChange={setSelectedRunId}
          startCancel={startCancel}
          onAdjust={(run) => setAdjustTarget(run)}
        />
      )}

      <AdjustmentDialog
        open={adjustTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAdjustTarget(null);
        }}
        legalEntityId={legalEntityId}
        target={adjustTarget}
        onCreated={(run) => {
          setSelectedRunId(run.id);
          setWizardOpen(true);
        }}
      />
    </div>
  );
}
