// Opening-hours field: one row per day (Monday first), a switch to open the
// day and a start/end time. The rows are grouped back into the contract's
// `zoneHoursSchema` windows when the zone is saved (PRD §3 F9 "Zona").
import { useT } from "@/components/i18n";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DAY_LABEL_KEYS, WEEK_ORDER, type DayHours } from "../lib";

type Props = {
  /** Seven rows, indexed by the contract's day number (0 = Sunday). */
  value: DayHours[];
  onChange: (value: DayHours[]) => void;
  error?: string;
  idPrefix?: string;
};

function ZoneHoursField({ value, onChange, error, idPrefix = "hours" }: Props) {
  const t = useT();
  const errorId = `${idPrefix}-error`;

  const update = (day: number, patch: Partial<DayHours>) => {
    onChange(
      value.map((entry, index) =>
        index === day ? { ...entry, ...patch } : entry,
      ),
    );
  };

  return (
    <fieldset
      className="grid gap-2"
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="text-sm font-semibold">
        {t("floorEditor.formHours")}
      </legend>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("floorEditor.formHoursHint")}
      </p>
      <div className="grid gap-1.5">
        {WEEK_ORDER.map((day) => {
          const entry = value[day];
          const label = t(DAY_LABEL_KEYS[day]);
          const switchId = `${idPrefix}-${day}-open`;
          return (
            <div
              key={day}
              className="grid grid-cols-[2.5rem_auto_minmax(0,1fr)] items-center gap-2"
            >
              <label
                htmlFor={switchId}
                className="text-sm font-medium text-muted-foreground"
              >
                {label}
              </label>
              <Switch
                id={switchId}
                checked={entry.open}
                onCheckedChange={(open) => update(day, { open })}
              />
              <div className="flex min-w-0 items-center gap-1.5">
                <Input
                  type="time"
                  aria-label={`${t("floorEditor.hoursFrom")} ${label}`}
                  aria-describedby={error ? errorId : undefined}
                  className="h-control-sm min-w-0 flex-1 px-2"
                  disabled={!entry.open}
                  value={entry.start}
                  onChange={(event) =>
                    update(day, { start: event.target.value })
                  }
                />
                <span className="text-muted-foreground" aria-hidden="true">
                  –
                </span>
                <Input
                  type="time"
                  aria-label={`${t("floorEditor.hoursTo")} ${label}`}
                  aria-describedby={error ? errorId : undefined}
                  className="h-control-sm min-w-0 flex-1 px-2"
                  disabled={!entry.open}
                  value={entry.end}
                  onChange={(event) => update(day, { end: event.target.value })}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div id={errorId} aria-live="polite">
        {error && (
          <p className="text-sm leading-5 font-medium text-danger">{error}</p>
        )}
      </div>
    </fieldset>
  );
}

export { ZoneHoursField };
