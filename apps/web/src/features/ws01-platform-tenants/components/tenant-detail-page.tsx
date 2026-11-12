// Tenant detail for Super Admin (PRD §3 F1, §3 F4): status, package, usage
// against quotas and cost caps (R18), brands/outlets, legal entities with NPWP
// and PKP, and the first admin.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Building2, LifeBuoy, Power, PowerOff } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { formatNumber } from "@starter/shared/i18n";
import { MODULE_KEYS } from "@starter/shared/platform";
import type { Tenant } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { API_MOCK } from "@/lib/api/mock-flag";
import { ApiError } from "@/lib/api/errors";
import {
  usePackages,
  useTenant,
  useTenantBrands,
  useTenantLegalEntities,
  useTenantOutlets,
  useTenantUsage,
} from "../hooks";
import {
  CAP_LABEL,
  maskNpwp,
  mergeById,
  QUOTA_LABEL,
  statusActions,
  usagePercent,
  usageTone,
} from "../logic";
import { getProvisioned } from "../session-cache";
import { OwnerSection } from "./owner-section";
import { RestoreSection } from "./restore-section";
import { StatusChangeDialog } from "./status-change-dialog";
import { TenantStatusBadge } from "./tenant-status";

const k = (key: string) => `platformTenants.detail.${key}` as MessageKey;

const dateFormat = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeZone: "Asia/Jakarta",
});

function Frame({
  title,
  children,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm">
            <Link to="/platform/tenant" aria-label={t(k("back"))}>
              <ArrowLeft aria-hidden="true" />
            </Link>
          </Button>
          <h2 className="type-title truncate">{title}</h2>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <CardShell>
      <CardShellBody className="p-card">
        <h3 className="type-title">{title}</h3>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
        <div className="mt-4">{children}</div>
      </CardShellBody>
    </CardShell>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid content-start gap-0.5">
      <dt className="type-eyebrow text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

export function TenantDetailPage({ tenantId }: { tenantId: string }) {
  const t = useT();
  const tenant = useTenant(tenantId);

  if (tenant.isPending)
    return (
      <Frame title={t("common.loading")}>
        <div aria-busy="true" className="grid gap-3">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-28" />
          <Skeleton className="h-40" />
          <Skeleton className="h-56" />
        </div>
      </Frame>
    );

  if (tenant.isError) {
    const missing =
      tenant.error instanceof ApiError && tenant.error.status === 404;
    return (
      <Frame title={t(k("notFound"))}>
        <Card className="p-0">
          {missing ? (
            <EmptyState
              icon={Building2}
              title={t(k("notFound"))}
              description={t(k("notFoundHint"))}
              action={
                <Button asChild variant="outline" size="sm">
                  <Link to="/platform/tenant">{t(k("back"))}</Link>
                </Button>
              }
            />
          ) : (
            <ErrorState onRetry={() => void tenant.refetch()} />
          )}
        </Card>
      </Frame>
    );
  }

  return <TenantDetail key={tenant.data.data.id} tenant={tenant.data.data} />;
}

function TenantDetail({ tenant }: { tenant: Tenant }) {
  const t = useT();
  const [target, setTarget] = React.useState<"active" | "suspended" | null>(
    null,
  );
  const actions = statusActions(tenant.status);
  // Stays mounted after a successful restore, so its success state is shown
  // even though the refetched tenant is no longer archived (legend-nb4iy).
  const wasArchived = React.useRef(false);
  if (tenant.status === "archived") wasArchived.current = true;

  return (
    <Frame
      title={tenant.name}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/platform/akses-dukungan">
              <LifeBuoy aria-hidden="true" />
              {t(k("supportAccess"))}
            </Link>
          </Button>
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "suspended" ? "outline" : "default"}
              onClick={() => setTarget(action as "active" | "suspended")}
            >
              {action === "suspended" ? (
                <PowerOff aria-hidden="true" />
              ) : (
                <Power aria-hidden="true" />
              )}
              {t(action === "suspended" ? k("deactivate") : k("activate"))}
            </Button>
          ))}
        </div>
      }
    >
      {tenant.status !== "active" && (
        <p
          role="status"
          className="rounded-container border-(length:--border-w) bg-warning-subtle p-card text-sm font-medium text-warning"
        >
          {t(
            tenant.status === "suspended"
              ? k("suspendedNote")
              : k("archivedNote"),
          )}
        </p>
      )}
      {wasArchived.current && (
        <RestoreSection
          key={tenant.id}
          kind="tenant"
          tenantId={tenant.id}
          name={tenant.name}
          statusLabel={(status) =>
            t(`platformTenants.status.${status}` as MessageKey)
          }
        />
      )}
      <Identity tenant={tenant} />
      <Usage tenantId={tenant.id} />
      <PackageSection tenant={tenant} />
      <OrgSection
        tenantId={tenant.id}
        tenantName={tenant.name}
        tenantStatus={tenant.status}
      />
      <OwnerSection tenantId={tenant.id} tenantName={tenant.name} />
      {target && (
        <StatusChangeDialog
          tenantId={tenant.id}
          tenantName={tenant.name}
          target={target}
          open
          onOpenChange={(open) => !open && setTarget(null)}
        />
      )}
    </Frame>
  );
}

function Identity({ tenant }: { tenant: Tenant }) {
  const t = useT();
  const packages = usePackages();
  const admin = getProvisioned(tenant.id).admin;
  return (
    <Section title={t(k("identity"))}>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label={t(k("status"))}>
          <TenantStatusBadge status={tenant.status} />
        </Fact>
        <Fact label={t(k("slug"))}>{tenant.slug}</Fact>
        <Fact label={t(k("mode"))}>
          {t(`platformTenants.mode.${tenant.deploymentMode}` as MessageKey)}
        </Fact>
        <Fact label={t(k("created"))}>
          {dateFormat.format(new Date(tenant.createdAt))}
        </Fact>
        <Fact label={t(k("package"))}>
          {packages.data?.data.find((p) => p.key === tenant.plan)?.name ??
            tenant.plan}
        </Fact>
        <Fact label={t(k("firstAdmin"))}>
          {admin ? (
            <span className="grid gap-0.5">
              <span>{admin.name}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {admin.whatsappMasked}
                {admin.emailMasked ? ` · ${admin.emailMasked}` : ""}
              </span>
            </span>
          ) : (
            <span className="font-normal text-muted-foreground">
              {t(k("firstAdminHidden"))}
            </span>
          )}
        </Fact>
      </dl>
    </Section>
  );
}

function Usage({ tenantId }: { tenantId: string }) {
  const t = useT();
  const usage = useTenantUsage(tenantId);
  if (usage.isPending)
    return (
      <div aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-32" />
      </div>
    );
  if (usage.isError)
    return (
      <Card className="p-0">
        <ErrorState onRetry={() => void usage.refetch()} />
      </Card>
    );
  const view = usage.data.data;
  return (
    <div className="grid gap-5">
      <StatStrip label={t(k("usageQuota"))} columns={4}>
        {view.quotas.map((row) => (
          <StatTile
            key={row.quota}
            label={t(QUOTA_LABEL[row.quota])}
            value={
              <span className="tabular">
                {formatNumber(row.used)}
                <span className="text-muted-foreground">
                  {" / "}
                  {formatNumber(row.limit)}
                </span>
              </span>
            }
            context={t(k("usagePercent"), {
              percent: usagePercent(row.used, row.limit),
              month: view.usage.month,
            })}
          />
        ))}
      </StatStrip>
      <Section
        title={t(k("costCaps"))}
        description={t(k("costCapsHint"), { month: view.usage.month })}
      >
        <ul className="grid gap-3">
          {view.costCaps.map((row) => {
            const tone = usageTone(row.spentIdr, row.capIdr);
            return (
              <li
                key={row.cap}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className="text-sm font-medium">
                  {t(CAP_LABEL[row.cap])}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-sm">
                    <Money amount={row.spentIdr} />
                    <span className="text-muted-foreground">
                      {" / "}
                      <Money amount={row.capIdr} />
                    </span>
                  </span>
                  <Badge tone={tone}>
                    {t(
                      `platformTenants.detail.capState.${row.state}` as MessageKey,
                    )}
                  </Badge>
                </span>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

function PackageSection({ tenant }: { tenant: Tenant }) {
  const t = useT();
  const enabled = new Set<string>(tenant.featureFlags.modules);
  return (
    <Section title={t(k("modules"))} description={t(k("modulesHint"))}>
      <Button asChild variant="outline" size="sm" className="mb-3">
        <Link to="/platform/paket">{t(k("changePackage"))}</Link>
      </Button>
      <ul className="flex flex-wrap gap-2" aria-label={t(k("modules"))}>
        {MODULE_KEYS.map((key) => (
          <li key={key}>
            <Badge tone={enabled.has(key) ? "success" : "neutral"}>
              {t(`platformTenants.modules.${key}` as MessageKey)}
              <span className="sr-only">
                {" "}
                {t(enabled.has(key) ? k("moduleOn") : k("moduleOff"))}
              </span>
            </Badge>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function OrgSection({
  tenantId,
  tenantName,
  tenantStatus,
}: {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
}) {
  const t = useT();
  const brands = useTenantBrands();
  const outlets = useTenantOutlets();
  const entities = useTenantLegalEntities();
  const created = getProvisioned(tenantId);
  // Outlets seen closed keep their restore panel after the restore succeeds.
  const everClosed = React.useRef(new Set<string>());

  if (brands.isPending || outlets.isPending || entities.isPending)
    return (
      <div aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-40" />
      </div>
    );
  if (brands.isError || outlets.isError || entities.isError)
    return (
      <Card className="p-0">
        <ErrorState
          onRetry={() => {
            void brands.refetch();
            void outlets.refetch();
            void entities.refetch();
          }}
        />
      </Card>
    );

  const own = <T extends { tenantId: string }>(rows: readonly T[]) =>
    rows.filter((row) => row.tenantId === tenantId);
  const brandRows = mergeById(
    own(brands.data.data),
    created.brand ? [created.brand] : [],
  );
  const outletRows = mergeById(
    own(outlets.data.data),
    created.outlet ? [created.outlet] : [],
  );
  const entityRows = mergeById(
    own(entities.data.data),
    created.legalEntity ? [created.legalEntity] : [],
  );
  for (const outlet of outletRows)
    if (outlet.status === "closed") everClosed.current.add(outlet.id);
  const entityName = (id: string) =>
    entityRows.find((e) => e.id === id)?.name ?? "-";

  return (
    <>
      <Section title={t(k("brandsOutlets"))}>
        {brandRows.length === 0 && outletRows.length === 0 ? (
          <EmptyState
            title={t(k("brandsEmpty"))}
            description={t(k("brandsEmptyHint"))}
          />
        ) : (
          <div className="grid gap-4">
            {brandRows.map((brand) => (
              <div key={brand.id} className="grid gap-2">
                <p className="font-semibold">
                  {brand.name}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    {brand.slug}
                  </span>
                </p>
                <ul className="grid gap-2">
                  {outletRows
                    .filter((outlet) => outlet.brandId === brand.id)
                    .map((outlet) => (
                      <li
                        key={outlet.id}
                        className="grid gap-0.5 rounded-control border-(length:--border-w) p-3 text-sm"
                      >
                        <span className="font-medium">
                          {outlet.name}{" "}
                          <span className="text-xs text-muted-foreground">
                            {outlet.code}
                          </span>
                        </span>
                        <span className="text-muted-foreground">
                          {outlet.address}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(k("bookedBy"), {
                            name: entityName(outlet.legalEntityId),
                          })}
                          {" · "}
                          {t(
                            `platformTenants.outletStatus.${outlet.status}` as MessageKey,
                          )}
                        </span>
                        {everClosed.current.has(outlet.id) && (
                          <ClosedOutletRestore
                            key={outlet.id}
                            tenantId={tenantId}
                            tenantName={tenantName}
                            tenantStatus={tenantStatus}
                            outletId={outlet.id}
                            name={outlet.name}
                          />
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title={t(k("legalEntities"))} description={t(k("legalHint"))}>
        {entityRows.length === 0 ? (
          <EmptyState title={t(k("legalEmpty"))} />
        ) : (
          <ul className="grid gap-2">
            {entityRows.map((entity) => (
              <li
                key={entity.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-control border-(length:--border-w) p-3 text-sm"
              >
                {/* TEN-04: registered address may be a person's home for a
                    small CV; platform staff see name, NPWP last 4 and PKP only. */}
                <span className="font-medium">{entity.name}</span>
                <span className="flex items-center gap-2">
                  <span className="tabular text-muted-foreground">
                    {maskNpwp(entity.npwpLast4)
                      ? `${t(k("npwp"))} ${maskNpwp(entity.npwpLast4)}`
                      : t(k("npwpMissing"))}
                  </span>
                  <Badge tone={entity.isPkp ? "success" : "neutral"}>
                    {t(entity.isPkp ? k("pkp") : k("nonPkp"))}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

/** Restore panel of a closed outlet; kept after success like the tenant one. */
function ClosedOutletRestore({
  tenantId,
  tenantName,
  tenantStatus,
  outletId,
  name,
}: {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  outletId: string;
  name: string;
}) {
  const t = useT();
  return (
    <div className="mt-2">
      <RestoreSection
        kind="outlet"
        tenantId={tenantId}
        outletId={outletId}
        tenantName={tenantName}
        parentStatus={tenantStatus}
        name={name}
        statusLabel={(status) =>
          t(`platformTenants.outletStatus.${status}` as MessageKey)
        }
      />
    </div>
  );
}
