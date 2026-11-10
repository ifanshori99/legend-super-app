// /operasional/checklist/template — the template catalog: name, type, scope
// (shift/station/zone), item count, version and last update, plus "Template
// baru". PRD v1.7 §3 F41 "Checklist Operasional": per shift, station and zone.
// The contract has no `active` flag (the brief asked for one): every template
// is shown and the screen states the gap instead of inventing the field.
import { ClipboardList, Info } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import { formatDateTime, typeLabelKey } from "../logic.ts";
import { roleName, shiftName, stationName } from "../fixtures.ts";
import { useChecklistTemplates, useFloorZones } from "../hooks.ts";
import { OfflineNotice } from "./offline-notice.tsx";

function ListSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <span className="sr-only" role="status">
        {t("opsChecklist.templates.loading")}
      </span>
      <Skeleton className="h-20 w-full rounded-container" />
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-48 w-full rounded-container" />
        ))}
      </div>
    </div>
  );
}

export function TemplateListPage() {
  const t = useT();
  const online = useOnline();
  const { clock } = useOutletClock();
  const { outlet } = useTenantContext();
  const templatesQuery = useChecklistTemplates(outlet?.id);
  const floorsQuery = useFloorZones();
  const zoneById = new Map(
    (floorsQuery.data?.data.zones ?? []).map((zone) => [zone.id, zone.name]),
  );

  if (outlet && templatesQuery.isPending) return <ListSkeleton />;

  if (templatesQuery.error)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <header className="grid gap-1">
          <h1 className="type-display">{t("opsChecklist.templates.title")}</h1>
        </header>
        <ErrorState
          error={templatesQuery.error}
          title={t("opsChecklist.templates.errorTitle")}
          description={t("opsChecklist.templates.errorHint")}
          onRetry={() => {
            void templatesQuery.refetch();
          }}
        />
      </div>
    );

  if (!outlet)
    return (
      <EmptyState
        title={t("state.emptyTitle")}
        description={t("state.emptyHint")}
      />
    );

  const templates = templatesQuery.data?.data ?? [];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1 className="type-display">{t("opsChecklist.templates.title")}</h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("opsChecklist.templates.subtitle")}
          </p>
        </div>
        <Button asChild>
          <Link
            to="/operasional/checklist/template/$templateId"
            params={{ templateId: "baru" }}
          >
            {t("opsChecklist.templates.new")}
          </Link>
        </Button>
      </header>

      {!online && (
        <OfflineNotice
          title={t("opsChecklist.runs.offlineTitle")}
          hint={t("opsChecklist.runs.offlineHint")}
        />
      )}

      <p className="flex items-start gap-2 rounded-container bg-surface-2 p-3 text-sm leading-5 text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("opsChecklist.templates.contractGap")}
      </p>

      {templates.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={t("opsChecklist.templates.emptyTitle")}
          description={t("opsChecklist.templates.emptyHint")}
          action={
            <Button asChild variant="outline">
              <Link
                to="/operasional/checklist/template/$templateId"
                params={{ templateId: "baru" }}
              >
                {t("opsChecklist.templates.new")}
              </Link>
            </Button>
          }
        />
      ) : (
        <ul
          data-slot="checklist-template-list"
          className="grid gap-3 md:grid-cols-2"
        >
          {templates.map((template) => {
            const shift =
              shiftName(template.schedule.shiftTemplateId) ??
              t("opsChecklist.runs.scopeAnyShift");
            const station =
              stationName(template.schedule.stationId) ??
              t("opsChecklist.runs.scopeAnyStation");
            const zone =
              (template.schedule.zoneId === null
                ? null
                : (zoneById.get(template.schedule.zoneId) ?? null)) ??
              t("opsChecklist.runs.scopeAnyZone");
            const role =
              roleName(template.roleId) ?? t("opsChecklist.templates.roleNone");
            return (
              <li key={template.id} className="min-w-0">
                <Link
                  to="/operasional/checklist/template/$templateId"
                  params={{ templateId: template.id }}
                  data-slot="checklist-template-card"
                  data-template-id={template.id}
                  className="flex h-full flex-col gap-2 rounded-container border-(length:--border-w) border-border bg-card p-card text-foreground shadow-hairline transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="flex flex-wrap items-start justify-between gap-2">
                    <span className="type-heading min-w-0">
                      {template.name}
                    </span>
                    <Badge tone="neutral">
                      {t(typeLabelKey(template.type))}
                    </Badge>
                  </span>
                  <span className="text-sm leading-5 text-muted-foreground">
                    {t("opsChecklist.runs.scope", { shift, station, zone })}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral">
                      {t("opsChecklist.templates.itemCount", {
                        count: template.items.length,
                      })}
                    </Badge>
                    <Badge tone="neutral">
                      {t("opsChecklist.templates.version", {
                        version: template.version,
                      })}
                    </Badge>
                  </span>
                  <span className="mt-auto grid gap-0.5 text-sm leading-5 text-muted-foreground">
                    <span>
                      {t("opsChecklist.templates.role", { name: role })}
                    </span>
                    <span className="tabular">
                      {t("opsChecklist.templates.dueTime", {
                        time: template.schedule.dueTime,
                      })}
                    </span>
                    <span className="tabular">
                      {t("opsChecklist.templates.updatedAt", {
                        time: formatDateTime(
                          template.updatedAt,
                          clock.timeZone,
                        ),
                      })}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
