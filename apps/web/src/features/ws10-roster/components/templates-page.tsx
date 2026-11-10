// /kelola/roster/template — shift-template catalog (PRD v1.7 §3 Kelompok D 28
// "Template Shift", F26). Read-only: the contract defines `shiftTemplateSchema`
// but no list/create/update endpoint, so the screen renders the shared
// `shift_templates` fixture and states the gap instead of inventing an edit
// flow. Each card shows its segments, crossing-midnight badge, station,
// position and active state.
import { Info, MoonStar } from "lucide-react";
import { shiftTemplateCrossesMidnight } from "@starter/shared/hris";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardShell,
  CardShellBody,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { useTenantContext } from "@/lib/tenant-context";
import { rosterTemplatesFor, stationName } from "../fixtures";
import { useRosterPositions } from "../hooks";
import { formatTemplateSegments } from "../lib";

export function TemplatesPage() {
  const t = useT();
  const { outlet } = useTenantContext();
  const templates = rosterTemplatesFor(outlet?.id);
  const positionsQ = useRosterPositions();
  const positionsById = new Map(
    (positionsQ.data?.data ?? []).map((position) => [
      position.id,
      position.name,
    ]),
  );

  return (
    <div className="grid min-w-0 gap-5">
      <div className="grid gap-1">
        <h2 className="type-title">{t("roster.templates.title")}</h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("roster.templates.description")}
        </p>
      </div>

      <p className="flex items-start gap-2 rounded-container border-(length:--border-w) bg-shell p-3 text-sm leading-5 text-muted-foreground shadow-hairline">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("roster.templates.readOnly")}
      </p>

      {templates.length === 0 ? (
        <CardShell>
          <CardShellBody>
            <EmptyState title={t("roster.templates.empty")} />
          </CardShellBody>
        </CardShell>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => {
            const crossing = shiftTemplateCrossesMidnight(template);
            const station =
              template.stationId === null
                ? t("roster.templates.allStations")
                : t("roster.templates.station", {
                    name:
                      stationName(template.stationId) ??
                      t("roster.templates.unknownStation"),
                  });
            const position =
              template.positionId === null
                ? t("roster.templates.allPositions")
                : (positionsById.get(template.positionId) ??
                  t("roster.grid.noPosition"));
            return (
              <li key={template.id}>
                <Card className="h-full">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="grid gap-1">
                      <CardTitle>{template.name}</CardTitle>
                      <CardDescription>
                        {t("roster.templates.segments", {
                          count: template.segments.length,
                        })}
                      </CardDescription>
                    </div>
                    <StatusPill
                      status={template.isActive ? "success" : "warning"}
                    >
                      {t(
                        template.isActive
                          ? "roster.templates.active"
                          : "roster.templates.inactive",
                      )}
                    </StatusPill>
                  </div>
                  <p className="text-xl leading-7 font-semibold tabular">
                    {formatTemplateSegments(template)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {crossing && (
                      <Badge tone="info">
                        <MoonStar aria-hidden="true" />
                        {t("roster.templates.crossing")}
                      </Badge>
                    )}
                    <Badge tone="neutral">
                      {t("roster.templates.break", {
                        minutes: template.breakMinutes,
                      })}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {station} · {position}
                  </p>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
