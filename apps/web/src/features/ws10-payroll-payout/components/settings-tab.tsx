// Pengaturan PT tab: payout method, source account and limits of one legal
// entity. Four states: loading, error, empty (no settings yet) and the form.
import * as React from "react";
import { Landmark } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { PayoutAccess } from "../guard";
import {
  usePayoutConfig,
  usePayoutLegalEntities,
  usePayoutSourceAccounts,
} from "../hooks";
import { SettingsForm } from "./settings-form";

export type SettingsTabProps = {
  legalEntityId: string;
  batchId?: string;
  access: PayoutAccess;
  currentUserId: string;
  onSelectBatch: (id: string) => void;
};

function SettingsSkeleton() {
  const t = useT();
  return (
    <div
      aria-busy="true"
      aria-label={t("payrollPayoutSettings.loading")}
      role="status"
      className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]"
    >
      <Card className="gap-5">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
        <Skeleton className="h-11 w-40" />
      </Card>
      <Card className="gap-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-16 w-full" />
      </Card>
    </div>
  );
}

export function SettingsTab({ legalEntityId, access }: SettingsTabProps) {
  const t = useT();
  const config = usePayoutConfig(legalEntityId);
  const accounts = usePayoutSourceAccounts(legalEntityId);
  const entities = usePayoutLegalEntities();
  // The PT the user chose to start settings for; another PT starts closed.
  const [creatingFor, setCreatingFor] = React.useState<string | null>(null);
  const creating = creatingFor === legalEntityId;

  const entityName =
    entities.data?.find((entity) => entity.id === legalEntityId)?.name ?? null;

  if (config.isPending) return <SettingsSkeleton />;
  if (config.isError)
    return (
      <Card>
        <ErrorState
          error={config.error}
          title={t("payrollPayoutSettings.error.title")}
          description={t("payrollPayoutSettings.error.hint")}
          onRetry={() => void config.refetch()}
        />
      </Card>
    );

  const saved = config.data ?? null;
  if (saved === null && !creating)
    return (
      <Card>
        <EmptyState
          icon={Landmark}
          title={t("payrollPayoutSettings.empty.title")}
          description={t(
            access.canConfigure
              ? "payrollPayoutSettings.empty.hint"
              : "payrollPayoutSettings.empty.noAccess",
          )}
          action={
            access.canConfigure ? (
              <Button
                className="min-h-11"
                onClick={() => setCreatingFor(legalEntityId)}
              >
                {t("payrollPayoutSettings.empty.create")}
              </Button>
            ) : undefined
          }
        />
      </Card>
    );

  return (
    <SettingsForm
      // A fresh form per PT; the draft survives a save so the toast stays.
      key={legalEntityId}
      legalEntityId={legalEntityId}
      entityName={entityName}
      config={saved}
      accounts={accounts.data ?? []}
      accountsState={
        accounts.isPending ? "loading" : accounts.isError ? "error" : "ready"
      }
      onRetryAccounts={() => void accounts.refetch()}
      canConfigure={access.canConfigure}
    />
  );
}
