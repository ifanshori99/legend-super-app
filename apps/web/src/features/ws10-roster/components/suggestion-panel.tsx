// "Usulan AI-13" panel (PRD v1.7 §3 Kelompok D 28 "Saran Jadwal"). The
// suggestion is advisory only: accepting it turns the proposal into a local
// draft, exactly like a manual drop. AI-13's real inputs (covers forecast,
// skills, preferences, labour-cost target) have no endpoint yet, so the
// deterministic coverage-gap heuristic in lib.ts supplies the rows and the
// panel says "Saran" instead of pretending it is a decision.
import type { Employee, ShiftTemplate } from "@starter/shared/hris";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { formatDayLabel, type RosterSuggestion } from "../lib";

export function SuggestionPanel({
  suggestions,
  employeesById,
  templatesById,
  onAccept,
}: {
  suggestions: readonly RosterSuggestion[];
  employeesById: ReadonlyMap<string, Employee>;
  templatesById: ReadonlyMap<string, ShiftTemplate>;
  onAccept: (suggestion: RosterSuggestion) => void;
}) {
  const t = useT();
  return (
    <CardShell>
      <CardShellBody>
        <header className="flex flex-wrap items-start justify-between gap-2 border-b-(length:--border-w) p-card">
          <div className="grid gap-1">
            <h2 className="type-title">{t("roster.suggestions.title")}</h2>
            <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
              {t("roster.suggestions.description")}
            </p>
          </div>
          <Badge tone="info">{t("roster.suggestions.badge")}</Badge>
        </header>
        {suggestions.length === 0 ? (
          <div className="grid gap-1 p-card">
            <p className="text-sm font-medium">{t("roster.suggestions.empty")}</p>
            <p className="text-sm text-muted-foreground">
              {t("roster.suggestions.emptyHint")}
            </p>
          </div>
        ) : (
          <ul className="divide-y-(length:--border-w) divide-border">
            {suggestions.map((suggestion) => {
              const employee = employeesById.get(suggestion.employeeId);
              const template =
                suggestion.templateId === null
                  ? null
                  : templatesById.get(suggestion.templateId);
              const employeeName = employee?.fullName ?? suggestion.employeeId;
              const date = formatDayLabel(suggestion.businessDate);
              return (
                <li
                  key={suggestion.id}
                  className="flex flex-col gap-2 p-card sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="grid min-w-0 gap-0.5">
                    <p className="truncate font-semibold">
                      {employeeName}
                      {template ? ` · ${template.name}` : ""}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {t("roster.suggestions.dateLine", {
                        date,
                        count: suggestion.missing,
                      })}{" "}
                      ·{" "}
                      {t("roster.suggestions.reason", {
                        target: suggestion.target,
                      })}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t("roster.suggestions.assignFor", {
                      employee: employeeName,
                      date,
                    })}
                    onClick={() => onAccept(suggestion)}
                  >
                    {t("roster.suggestions.assign")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardShellBody>
    </CardShell>
  );
}
