// /kelola/akuntansi/bagi-hasil — profit entity, versioned shareholder register
// (SH-03: exactly 10,000 bp and an approval), the register itself and the
// distribution policy (PRD §3.37 "Entitas Bagi Hasil", "Daftar Pemegang Saham
// Berversi", "Kebijakan Distribusi").
import * as React from "react";
import type {
  ShareAllocationVersion,
  Shareholder,
} from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { type DataState } from "@/components/ui/data-table-shell";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { useCanPostJournals } from "@/features/ws07-accounting/guard";
import {
  useCanApproveShareAllocation,
  useCanChangeShareAllocation,
} from "../guard";
import { useProfitEntities, useShareholders, useShareVersions } from "../hooks";
import {
  effectiveVersionOfEntity,
  formatShareBp,
  formatShareDate,
  previousVersionOf,
  shareDateToday,
  suggestedEffectiveFrom,
  versionTotalBp,
  versionsOfEntity,
} from "../lib";
import { PolicyCard } from "./policy-card";
import { ProfitEntityDialog, ProfitEntityPicker } from "./profit-entity-picker";
import { ShareholderDialog } from "./shareholder-dialog";
import { ShareholdersTable } from "./shareholders-table";
import { VersionDiffDialog } from "./version-diff-dialog";
import { VersionEditorDialog } from "./version-editor-dialog";
import { VersionFocusCard } from "./version-focus-card";
import { VersionsTable } from "./versions-table";

export function ProfitSharePage({ legalEntityId }: { legalEntityId: string }) {
  const t = useT();
  const canWrite = useCanPostJournals();
  const canChangeShares = useCanChangeShareAllocation();
  const canApproveShares = useCanApproveShareAllocation();
  const entitiesQuery = useProfitEntities();
  const shareholdersQuery = useShareholders();

  const [selectedEntityId, setSelectedEntityId] = React.useState<string | null>(
    null,
  );
  const [focusVersionNumber, setFocusVersionNumber] = React.useState<
    number | null
  >(null);
  const [entityDialogOpen, setEntityDialogOpen] = React.useState(false);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editingVersion, setEditingVersion] =
    React.useState<ShareAllocationVersion | null>(null);
  const [diffVersion, setDiffVersion] =
    React.useState<ShareAllocationVersion | null>(null);
  const [shareholderDialogOpen, setShareholderDialogOpen] =
    React.useState(false);
  const [editingShareholder, setEditingShareholder] =
    React.useState<Shareholder | null>(null);

  const entities = entitiesQuery.data ?? [];
  const entity = React.useMemo(
    () =>
      entities.find((row) => row.id === selectedEntityId) ??
      entities.find((row) => row.legalEntityId === legalEntityId) ??
      entities[0],
    [entities, selectedEntityId, legalEntityId],
  );
  const versionsQuery = useShareVersions(entity?.id);
  const versions = React.useMemo(
    () => (entity ? versionsOfEntity(versionsQuery.data ?? [], entity.id) : []),
    [versionsQuery.data, entity],
  );
  const shareholders = shareholdersQuery.data ?? [];
  const focused =
    versions.find((row) => row.version === focusVersionNumber) ??
    versions[0] ??
    null;
  const today = shareDateToday();
  const activeVersion = entity
    ? effectiveVersionOfEntity(versions, entity.id, today)
    : null;

  const versionsState: DataState = versionsQuery.isPending
    ? "loading"
    : versionsQuery.isError
      ? "error"
      : versions.length === 0
        ? "empty"
        : "ready";
  const shareholdersState: DataState = shareholdersQuery.isPending
    ? "loading"
    : shareholdersQuery.isError
      ? "error"
      : shareholders.length === 0
        ? "empty"
        : "ready";

  const openCreateVersion = () => {
    setEditingVersion(null);
    setEditorOpen(true);
  };
  const openEditVersion = (version: ShareAllocationVersion) => {
    setEditingVersion(version);
    setEditorOpen(true);
  };
  const openShareholder = (shareholder: Shareholder | null) => {
    setEditingShareholder(shareholder);
    setShareholderDialogOpen(true);
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
              setFocusVersionNumber(null);
            }}
            onAdd={() => setEntityDialogOpen(true)}
          />

          <StatStrip label={t("accounting.share.stats.label")} columns={3}>
            <StatTile
              label={t("accounting.share.stats.activeShare")}
              value={
                activeVersion ? (
                  <span className="tabular">
                    {formatShareBp(versionTotalBp(activeVersion))}
                  </span>
                ) : (
                  <span className="text-sm font-medium text-muted-foreground">
                    {t("accounting.share.stats.activeShareNone")}
                  </span>
                )
              }
              context={
                activeVersion
                  ? t("accounting.share.stats.activeShareContext", {
                      version: activeVersion.version,
                    })
                  : undefined
              }
            />
            <StatTile
              label={t("accounting.share.stats.shareholders")}
              value={
                <NumberDisplay
                  value={
                    shareholders.filter((row) => row.status === "active").length
                  }
                />
              }
              context={t("accounting.share.stats.shareholdersContext", {
                total: shareholders.length,
              })}
            />
            <StatTile
              label={t("accounting.share.stats.version")}
              value={
                activeVersion ? (
                  t("accounting.share.versions.versionLabel", {
                    version: activeVersion.version,
                  })
                ) : (
                  <span className="text-sm font-medium text-muted-foreground">
                    {t("accounting.share.stats.versionNone")}
                  </span>
                )
              }
              context={
                activeVersion
                  ? t("accounting.share.stats.versionContext", {
                      date: formatShareDate(activeVersion.effectiveFrom),
                    })
                  : undefined
              }
            />
          </StatStrip>

          {versionsQuery.isPending ? (
            <CardShell>
              <CardShellBody>
                <div className="grid gap-2 p-card" aria-busy="true">
                  <span className="sr-only">{t("common.loading")}</span>
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-row w-full" />
                  <Skeleton className="h-row w-full" />
                  <Skeleton className="h-row w-full" />
                </div>
              </CardShellBody>
            </CardShell>
          ) : versionsQuery.isError ? (
            <CardShell>
              <CardShellBody>
                <ErrorState
                  onRetry={() => {
                    void versionsQuery.refetch();
                  }}
                />
              </CardShellBody>
            </CardShell>
          ) : focused ? (
            <VersionFocusCard
              version={focused}
              shareholders={shareholders}
              canWrite={canChangeShares}
              canApprove={canApproveShares}
              onEdit={() => openEditVersion(focused)}
            />
          ) : (
            <CardShell>
              <CardShellBody>
                <EmptyState
                  title={t("accounting.share.versions.emptyTitle")}
                  description={t("accounting.share.versions.emptyHint")}
                  action={
                    canChangeShares ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={openCreateVersion}
                      >
                        {t("accounting.share.versions.create")}
                      </Button>
                    ) : undefined
                  }
                />
              </CardShellBody>
            </CardShell>
          )}

          <VersionsTable
            versions={versions}
            state={versionsState}
            canWrite={canChangeShares}
            onRetry={() => {
              void versionsQuery.refetch();
            }}
            onCreate={openCreateVersion}
            onOpen={(version) => setFocusVersionNumber(version.version)}
            onCompare={setDiffVersion}
            hasPrevious={(version) =>
              previousVersionOf(versions, version) !== null
            }
          />

          <ShareholdersTable
            shareholders={shareholders}
            state={shareholdersState}
            canWrite={canWrite}
            onRetry={() => {
              void shareholdersQuery.refetch();
            }}
            onCreate={() => openShareholder(null)}
            onEdit={(shareholder) => openShareholder(shareholder)}
          />

          <PolicyCard entity={entity} canWrite={canWrite} />
        </>
      )}

      <ProfitEntityDialog
        open={entityDialogOpen}
        onOpenChange={setEntityDialogOpen}
      />
      {entity && (
        <VersionEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          profitEntityId={entity.id}
          version={
            editingVersion && editingVersion.status === "draft"
              ? editingVersion
              : null
          }
          baseVersion={activeVersion ?? focused}
          suggestedDate={suggestedEffectiveFrom(versions, entity.id, today)}
          shareholders={shareholders}
        />
      )}
      <VersionDiffDialog
        open={diffVersion !== null}
        onOpenChange={(open) => {
          if (!open) setDiffVersion(null);
        }}
        version={diffVersion}
        previous={diffVersion ? previousVersionOf(versions, diffVersion) : null}
        shareholders={shareholders}
      />
      <ShareholderDialog
        open={shareholderDialogOpen}
        onOpenChange={setShareholderDialogOpen}
        shareholder={editingShareholder}
      />
    </div>
  );
}
