// Draggable shift-template palette for the weekly roster. HTML5 drag-and-drop
// writes the template id into the dataTransfer; the grid's cell menu offers the
// same choices to keyboard and touch users (PRD v1.7 §3 Kelompok D 28).
import { MoonStar } from "lucide-react";
import type { ShiftTemplate } from "@starter/shared/hris";
import { shiftTemplateCrossesMidnight } from "@starter/shared/hris";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { formatTemplateSegments } from "../lib";

export function TemplatePalette({
  templates,
}: {
  templates: readonly ShiftTemplate[];
}) {
  const t = useT();
  const active = templates.filter((template) => template.isActive);
  return (
    <CardShell>
      <CardShellBody>
        <header className="grid gap-1 border-b-(length:--border-w) p-card">
          <h2 className="type-title">{t("roster.palette.title")}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("roster.palette.description")}
          </p>
        </header>
        {active.length === 0 ? (
          <p className="p-card text-sm text-muted-foreground">
            {t("roster.palette.empty")}
          </p>
        ) : (
          <ul className="grid gap-2 p-card sm:grid-cols-2 xl:grid-cols-4">
            {active.map((template) => {
              const crossing = shiftTemplateCrossesMidnight(template);
              return (
                <li
                  key={template.id}
                  draggable
                  title={t("roster.palette.dragHint", {
                    template: template.name,
                  })}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", template.id);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  className="grid cursor-grab gap-1 rounded-container border-(length:--border-w) bg-card p-3 shadow-hairline active:cursor-grabbing"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold">{template.name}</p>
                    {crossing && (
                      <Badge tone="info">
                        <MoonStar aria-hidden="true" />
                        {t("roster.palette.crossing")}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm font-semibold tabular">
                    {formatTemplateSegments(template)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("roster.palette.break", {
                      minutes: template.breakMinutes,
                    })}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </CardShellBody>
    </CardShell>
  );
}
