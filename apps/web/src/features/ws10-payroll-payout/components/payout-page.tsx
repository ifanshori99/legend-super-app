// Pencairan gaji (legend-wnkep.6, .7): four tabs over one legal entity (PT).
// Siap bayar (runs) / Persetujuan / Status karyawan / Pengaturan PT. The shell
// owns the h1; this page renders the intro, the PT picker and the tabs. The
// selected tab, PT and batch live in the URL (`tab`, `entity`, `batch`), so a
// reviewer can be sent straight to one batch.
import * as React from "react";
import { Landmark } from "lucide-react";
import type { PayoutBatchStatus } from "@starter/shared/validators/payroll-payout";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";
import { isPayoutOffline } from "../errors";
import { useEntityBatches, usePayoutLegalEntities } from "../hooks";
import type { PayoutAccess } from "../guard";
import { type PayoutTabProps } from "../lib";
import { ApprovalTab } from "./approval-tab";
import { RunsTab } from "./runs-tab";
import { SettingsTab } from "./settings-tab";
import { StatusTab } from "./status-tab";

export const PAYOUT_TABS = ["runs", "approval", "status", "settings"] as const;
export type PayoutTab = (typeof PAYOUT_TABS)[number];

export type PayoutSearch = {
  tab: PayoutTab;
  entity?: string;
  batch?: string;
};

const TAB_LABEL = {
  runs: "payrollPayout.tabs.runs",
  approval: "payrollPayout.tabs.approval",
  status: "payrollPayout.tabs.status",
  settings: "payrollPayout.tabs.settings",
} as const;

/** Batches the status tab follows: sent, waiting for the bank, or finished. */
const STATUS_BATCHES: readonly PayoutBatchStatus[] = [
  "approved",
  "sending",
  "exported",
  "partially_failed",
  "halted",
  "completed",
];

export function PayoutPage({
  access,
  currentUserId,
  search,
  onSearchChange,
}: {
  access: PayoutAccess;
  currentUserId: string;
  search: PayoutSearch;
  onSearchChange: (next: PayoutSearch) => void;
}) {
  const t = useT();
  const entities = usePayoutLegalEntities();
  // An entity id from the URL that this tenant does not have falls back to the
  // first one, so a stale link never opens an empty, unreachable PT.
  const entityId =
    entities.data?.find((entity) => entity.id === search.entity)?.id ??
    entities.data?.[0]?.id;

  if (entities.isPending) return <PageSkeleton />;
  if (entities.isError)
    return (
      <ErrorState
        title={t(
          isPayoutOffline(entities.error)
            ? "payrollPayout.error.offlineTitle"
            : "payrollPayout.page.error.title",
        )}
        description={t("payrollPayout.page.error.description")}
        error={entities.error}
        onRetry={() => void entities.refetch()}
      />
    );
  if (!entityId)
    return (
      <EmptyState
        icon={Landmark}
        title={t("payrollPayout.page.noEntity.title")}
        description={t("payrollPayout.page.noEntity.description")}
      />
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("payrollPayout.page.subtitle")}
          </p>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
      </header>

      <PayoutTabs
        access={access}
        currentUserId={currentUserId}
        legalEntityId={entityId}
        search={search}
        onSearchChange={onSearchChange}
        labels={{
          runs: t(TAB_LABEL.runs),
          approval: t(TAB_LABEL.approval),
          status: t(TAB_LABEL.status),
          settings: t(TAB_LABEL.settings),
        }}
        ariaLabel={t("payrollPayout.tabs.label")}
        picker={
          <div className="grid min-w-0 gap-1 sm:max-w-sm">
            <FormField
              required
              label={t("payrollPayout.page.entity")}
              hint={t("payrollPayout.page.entityHint")}
            >
              <Select
                value={entityId}
                onValueChange={(entity) =>
                  onSearchChange({ tab: search.tab, entity })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(entities.data ?? []).map((entity) => (
                    <SelectItem key={entity.id} value={entity.id}>
                      {entity.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
        }
      />
    </div>
  );
}

function PayoutTabs({
  access,
  currentUserId,
  legalEntityId,
  search,
  onSearchChange,
  labels,
  ariaLabel,
  picker,
}: {
  access: PayoutAccess;
  currentUserId: string;
  legalEntityId: string;
  search: PayoutSearch;
  onSearchChange: (next: PayoutSearch) => void;
  labels: Record<PayoutTab, string>;
  ariaLabel: string;
  /** The PT picker, shown between the tab list and the tab content. */
  picker: React.ReactNode;
}) {
  const batches = useEntityBatches(legalEntityId, {
    includePaid: search.tab === "status",
  });
  const all = batches.entries.flatMap((entry) => entry.batches);
  const newest = (rows: typeof all) =>
    [...rows].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0]?.id;
  // Without `batch` in the URL each tab opens the batch it is about.
  const defaultBatch =
    search.tab === "approval"
      ? newest(all.filter((row) => row.status === "pending_approval"))
      : search.tab === "status"
        ? // A batch that still needs follow-up beats a finished one.
          (newest(
            all.filter(
              (row) =>
                STATUS_BATCHES.includes(row.status) &&
                row.status !== "completed",
            ),
          ) ?? newest(all.filter((row) => row.status === "completed")))
        : undefined;
  const batchId = search.batch ?? defaultBatch;

  const tabProps: PayoutTabProps = {
    legalEntityId,
    batchId,
    access,
    currentUserId,
    onSelectBatch: (id: string, status?: PayoutBatchStatus) =>
      onSearchChange({
        tab:
          status === undefined ||
          status === "pending_approval" ||
          status === "draft"
            ? "approval"
            : "status",
        entity: legalEntityId,
        batch: id,
      }),
  };

  return (
    <Tabs
      className="min-w-0"
      value={search.tab}
      onValueChange={(tab) =>
        onSearchChange({
          tab: tab as PayoutTab,
          entity: legalEntityId,
          // A batch id fits one kind of tab (approval: waiting for approval,
          // status: already sent). Each tab opens its own default batch.
          batch: undefined,
        })
      }
    >
      <TabsList aria-label={ariaLabel} className="max-w-full overflow-x-auto">
        {PAYOUT_TABS.map((tab) => (
          <TabsTrigger key={tab} value={tab} className="px-2.5 sm:px-3.5">
            {labels[tab]}
          </TabsTrigger>
        ))}
      </TabsList>
      <div className="mt-4">{picker}</div>
      {/* The key resets tab state (selected run, open panels) per PT. */}
      <div key={legalEntityId} className="min-w-0">
        <TabsContent value="runs">
          <RunsTab {...tabProps} />
        </TabsContent>
        <TabsContent value="approval">
          <ApprovalTab {...tabProps} />
        </TabsContent>
        <TabsContent value="status">
          <StatusTab {...tabProps} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab {...tabProps} />
        </TabsContent>
      </div>
    </Tabs>
  );
}

function PageSkeleton() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("payrollPayout.common.loading")}
      className="grid gap-4"
    >
      <Skeleton className="h-5 w-80 max-w-full" />
      <Skeleton className="h-10 w-full sm:w-[28rem]" />
      <Skeleton className="h-11 w-full sm:max-w-sm" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
