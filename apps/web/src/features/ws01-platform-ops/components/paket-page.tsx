// /platform/paket — packages and module feature flags (PRD v1.7 §3 F4
// "Feature Flag & Paket", TEN-05, TEN-06). Packages are read-only here (the
// contract has no package editor); Super Admin switches a tenant's plan and
// modules, with a confirm step and an audited reason.
import * as React from "react";
import { Lock } from "lucide-react";
import {
  MODULE_KEYS,
  type ModuleKey,
  type PlatformPackage,
  type Tenant,
} from "@starter/shared/platform";
import { formatNumber } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { EmptyState } from "@/components/ui/feedback-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { opsErrorMessage } from "../errors";
import { usePackages, useSetTenantPackage, useTenant } from "../hooks";
import { blockedModules, diffList, nextModules } from "../logic";
import { ChangeDialog, DiffSummary } from "./change-dialog";
import {
  OpsPage,
  Section,
  SectionError,
  SectionLoading,
  TenantPicker,
  useSelectedTenant,
} from "./ops-shell";

export function PaketPage({ canManage }: { canManage: boolean }) {
  const t = useT();
  const packages = usePackages();
  const rows = packages.data?.data ?? [];
  const state = packages.isPending
    ? "loading"
    : packages.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <OpsPage>
      <DataTableShell
        title={t("platformOps.paket.listTitle")}
        description={t("platformOps.paket.listDescription")}
        state={state}
        onRetry={() => void packages.refetch()}
        empty={{
          title: t("platformOps.paket.emptyTitle"),
          description: t("platformOps.paket.emptyHint"),
        }}
        rowCount={rows.length}
        loadingRows={2}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("platformOps.paket.columnName")}</TableHead>
              <TableHead>{t("platformOps.paket.columnStatus")}</TableHead>
              <TableHead numeric>
                {t("platformOps.paket.columnModules")}
              </TableHead>
              <TableHead numeric className="hidden sm:table-cell">
                {t("platformOps.limits.maxOutlets")}
              </TableHead>
              <TableHead numeric className="hidden md:table-cell">
                {t("platformOps.limits.maxActiveEmployees")}
              </TableHead>
              <TableHead numeric className="hidden md:table-cell">
                {t("platformOps.limits.maxDevices")}
              </TableHead>
              <TableHead numeric className="hidden lg:table-cell">
                {t("platformOps.limits.aiRequestsPerMonth")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((pkg) => (
              <TableRow key={pkg.key}>
                <TableCell>
                  <p className="font-semibold">{pkg.name}</p>
                  <p className="text-xs text-muted-foreground">{pkg.key}</p>
                </TableCell>
                <TableCell>
                  <Badge tone={pkg.status === "active" ? "success" : "neutral"}>
                    {t(
                      pkg.status === "active"
                        ? "platformOps.paket.statusActive"
                        : "platformOps.paket.statusRetired",
                    )}
                  </Badge>
                </TableCell>
                <TableCell numeric>
                  {t("platformOps.paket.moduleCount", {
                    count: pkg.modules.length,
                    total: MODULE_KEYS.length,
                  })}
                </TableCell>
                <TableCell numeric className="hidden sm:table-cell">
                  {formatNumber(pkg.defaultLimits.maxOutlets)}
                </TableCell>
                <TableCell numeric className="hidden md:table-cell">
                  {formatNumber(pkg.defaultLimits.maxActiveEmployees)}
                </TableCell>
                <TableCell numeric className="hidden md:table-cell">
                  {formatNumber(pkg.defaultLimits.maxDevices)}
                </TableCell>
                <TableCell numeric className="hidden lg:table-cell">
                  {formatNumber(pkg.defaultLimits.aiRequestsPerMonth)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>

      <ModuleFlagsSection canManage={canManage} packages={rows} />
    </OpsPage>
  );
}

function ModuleFlagsSection({
  canManage,
  packages,
}: {
  canManage: boolean;
  packages: readonly PlatformPackage[];
}) {
  const t = useT();
  const { tenants, rows, tenantId, setTenantId } = useSelectedTenant();
  const tenant = useTenant(tenantId);

  let body: React.ReactNode;
  if (tenants.isPending || (tenantId !== null && tenant.isPending))
    body = <SectionLoading />;
  else if (tenants.isError || tenant.isError)
    body = (
      <SectionError
        onRetry={() => {
          void tenants.refetch();
          void tenant.refetch();
        }}
      />
    );
  else if (rows.length === 0 || !tenant.data)
    body = (
      <EmptyState
        title={t("platformOps.noTenantsTitle")}
        description={t("platformOps.noTenantsHint")}
      />
    );
  else
    body = (
      <ModuleEditor
        key={`${tenant.data.data.id}:${tenant.data.data.plan}:${tenant.data.data.featureFlags.modules.join(",")}`}
        tenant={tenant.data.data}
        packages={packages}
        canManage={canManage}
      />
    );

  return (
    <Section
      title={t("platformOps.flags.title")}
      description={t("platformOps.flags.description")}
      actions={
        <TenantPicker rows={rows} value={tenantId} onChange={setTenantId} />
      }
    >
      {body}
    </Section>
  );
}

function ModuleEditor({
  tenant,
  packages,
  canManage,
}: {
  tenant: Tenant;
  packages: readonly PlatformPackage[];
  canManage: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const save = useSetTenantPackage(tenant.id);
  const [plan, setPlan] = React.useState<string>(tenant.plan);
  const [modules, setModules] = React.useState<ModuleKey[]>(
    tenant.featureFlags.modules,
  );
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const pkg = packages.find((row) => row.key === plan);
  const blocked = blockedModules(modules, pkg);
  const diff = diffList(tenant.featureFlags.modules, modules);
  const dirty =
    plan !== tenant.plan || diff.added.length + diff.removed.length > 0;
  const selectable = packages.filter(
    (row) => row.status === "active" || row.key === tenant.plan,
  );
  const label = (key: ModuleKey) => t(`platformOps.modules.${key}`);

  const summaryRows = [
    ...(plan !== tenant.plan
      ? [
          {
            label: t("platformOps.flags.summaryPlan"),
            value: `${packages.find((row) => row.key === tenant.plan)?.name ?? tenant.plan} → ${pkg?.name ?? plan}`,
          },
        ]
      : []),
    ...(diff.added.length > 0
      ? [
          {
            label: t("platformOps.flags.summaryOn"),
            value: diff.added.map(label).join(", "),
          },
        ]
      : []),
    ...(diff.removed.length > 0
      ? [
          {
            label: t("platformOps.flags.summaryOff"),
            value: diff.removed.map(label).join(", "),
            tone: "remove" as const,
          },
        ]
      : []),
  ];

  const confirm = (reason: string) => {
    setError(null);
    save.mutate(
      {
        plan,
        featureFlags: {
          modules,
          integrationProviders: tenant.featureFlags.integrationProviders,
        },
        limits: tenant.limits,
        reason,
      },
      {
        onSuccess: () => {
          toast({ title: t("platformOps.flags.saved"), tone: "success" });
          setConfirming(false);
        },
        onError: (failure) => setError(opsErrorMessage(failure, t)),
      },
    );
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-1.5 sm:max-w-sm">
        <label htmlFor="ops-plan" className="text-sm font-semibold">
          {t("platformOps.flags.plan")}
        </label>
        <Select value={plan} onValueChange={setPlan} disabled={!canManage}>
          <SelectTrigger id="ops-plan" className="h-control-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {selectable.map((row) => (
              <SelectItem key={row.key} value={row.key}>
                {row.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("platformOps.flags.ten05")}
      </p>

      <ul className="grid divide-y rounded-control border-(length:--border-w)">
        {MODULE_KEYS.map((key) => {
          const on = modules.includes(key);
          const inPackage = pkg?.modules.includes(key) ?? false;
          const id = `ops-module-${key}`;
          return (
            <li
              key={key}
              className="flex min-h-12 items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <label htmlFor={id} className="text-sm font-semibold">
                  {label(key)}
                </label>
                {!inPackage && (
                  <p
                    className={
                      on
                        ? "text-xs text-danger"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {t(
                      on
                        ? "platformOps.flags.outsideOn"
                        : "platformOps.flags.outsideOff",
                      { plan: pkg?.name ?? plan },
                    )}
                  </p>
                )}
              </div>
              <Switch
                id={id}
                checked={on}
                disabled={!canManage || (!inPackage && !on)}
                onCheckedChange={(next) =>
                  setModules((current) => nextModules(current, key, next))
                }
                aria-label={label(key)}
              />
            </li>
          );
        })}
      </ul>

      {blocked.length > 0 && (
        <p role="alert" className="text-sm text-danger">
          {t("platformOps.flags.blocked", {
            modules: blocked.map(label).join(", "),
          })}
        </p>
      )}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!dirty || blocked.length > 0}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            {t("platformOps.flags.review")}
          </Button>
          <Button
            variant="outline"
            disabled={!dirty}
            onClick={() => {
              setPlan(tenant.plan);
              setModules(tenant.featureFlags.modules);
            }}
          >
            {t("platformOps.reset")}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("platformOps.readOnly")}
        </p>
      )}

      <ChangeDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("platformOps.flags.confirmTitle", { tenant: tenant.name })}
        description={t("platformOps.flags.confirmDescription")}
        summary={<DiffSummary rows={summaryRows} />}
        destructive={diff.removed.length > 0}
        pending={save.isPending}
        error={error}
        onConfirm={confirm}
      />
    </div>
  );
}
