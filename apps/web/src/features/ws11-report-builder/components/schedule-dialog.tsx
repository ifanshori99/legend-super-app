// Schedule an email delivery of a saved report (PRD v1.7 §3 F36 "jadwalkan
// pengiriman via email"). The fields follow createReportScheduleInputSchema
// (frequency, time, weekday or day of month, format, recipients), checked with
// the contract itself before the call. DASH-04: a report that splits or
// filters by a person is personal data, so it is never mailed on a schedule;
// the dialog says why and points to the approval flow instead of offering a
// form the server would refuse (EXPORT_PII_APPROVAL_REQUIRED).
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  REPORT_SCHEDULE_FORMATS,
  REPORT_SCHEDULE_FREQUENCIES,
  createReportScheduleInputSchema,
  type SavedReport,
} from "@starter/shared/dashboard";
import {
  emptyScheduleDraft,
  queryHasPersonalData,
  reportErrorCodeOf,
  scheduleSettings,
  type ScheduleDraft,
} from "../builder";
import { reportErrorText } from "../format";
import { useAttemptKey, useCreateSchedule } from "../hooks";

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** The schedule field a contract issue belongs to, for its inline message. */
function fieldOf(path: readonly PropertyKey[]): string {
  return String(path[0] ?? "form");
}

function errorKeyFor(field: string): MessageKey {
  switch (field) {
    case "recipients":
      return "reportBuilder.schedule.errors.recipients";
    case "timeOfDay":
      return "reportBuilder.schedule.errors.timeOfDay";
    case "dayOfMonth":
      return "reportBuilder.schedule.errors.dayOfMonth";
    default:
      return "reportBuilder.schedule.errors.form";
  }
}

export function ScheduleDialog({
  report,
  open,
  onOpenChange,
}: {
  report: SavedReport | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateSchedule();
  const attemptKey = useAttemptKey();
  const [draft, setDraft] = useState<ScheduleDraft>(emptyScheduleDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const personal = report !== null && queryHasPersonalData(report.query);
  const set = (patch: Partial<ScheduleDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const close = (next: boolean) => {
    if (!next) {
      setDraft(emptyScheduleDraft());
      setErrors({});
      setServerError(null);
      create.reset();
    }
    onOpenChange(next);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (report === null || personal) return;
    const parsed = createReportScheduleInputSchema.safeParse({
      savedReportId: report.id,
      ...scheduleSettings(draft),
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = fieldOf(issue.path);
        next[field] ??= t(errorKeyFor(field));
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setServerError(null);
    create.mutate(
      { input: parsed.data, idempotencyKey: attemptKey(parsed.data) },
      {
        onSuccess: () => {
          toast({
            title: t("reportBuilder.schedule.created", { name: report.name }),
            tone: "success",
          });
          close(false);
        },
        onError: (error) => setServerError(reportErrorText(t, error)),
      },
    );
  };

  const serverCode = create.error ? reportErrorCodeOf(create.error) : null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("reportBuilder.schedule.title")}</DialogTitle>
          <DialogDescription>
            {t("reportBuilder.schedule.description", {
              name: report?.name ?? "",
            })}
          </DialogDescription>
        </DialogHeader>

        {personal ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-control bg-warning-subtle p-3 text-sm leading-5 text-warning"
          >
            <ShieldAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <div className="grid gap-1">
              <p className="font-semibold">
                {t("reportBuilder.schedule.personalTitle")}
              </p>
              <p>{t("reportBuilder.schedule.personalHint")}</p>
            </div>
          </div>
        ) : (
          <form
            id="report-schedule-form"
            onSubmit={submit}
            noValidate
            className="grid gap-4"
          >
            <FormField label={t("reportBuilder.schedule.frequency")} required>
              <Select
                value={draft.frequency}
                onValueChange={(value) =>
                  set({ frequency: value as ScheduleDraft["frequency"] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_SCHEDULE_FREQUENCIES.map((frequency) => (
                    <SelectItem key={frequency} value={frequency}>
                      {t(`reportBuilder.schedule.frequencies.${frequency}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {draft.frequency === "weekly" && (
              <FormField label={t("reportBuilder.schedule.dayOfWeek")} required>
                <Select
                  value={String(draft.dayOfWeek)}
                  onValueChange={(value) => set({ dayOfWeek: Number(value) })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((day) => (
                      <SelectItem key={day} value={String(day)}>
                        {t(`reportBuilder.weekdays.${day}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            {draft.frequency === "monthly" && (
              <FormField
                label={t("reportBuilder.schedule.dayOfMonth")}
                hint={t("reportBuilder.schedule.dayOfMonthHint")}
                error={errors.dayOfMonth}
                required
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={28}
                  value={draft.dayOfMonth}
                  onChange={(event) =>
                    set({ dayOfMonth: Number(event.target.value) })
                  }
                />
              </FormField>
            )}

            <FormField
              label={t("reportBuilder.schedule.timeOfDay")}
              hint={t("reportBuilder.schedule.timeHint")}
              error={errors.timeOfDay}
              required
            >
              <Input
                type="time"
                value={draft.timeOfDay}
                onChange={(event) => set({ timeOfDay: event.target.value })}
              />
            </FormField>

            <FormField label={t("reportBuilder.schedule.format")} required>
              <Select
                value={draft.format}
                onValueChange={(value) =>
                  set({ format: value as ScheduleDraft["format"] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_SCHEDULE_FORMATS.map((format) => (
                    <SelectItem key={format} value={format}>
                      {t(`reportBuilder.schedule.formats.${format}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label={t("reportBuilder.schedule.recipients")}
              hint={t("reportBuilder.schedule.recipientsHint")}
              error={errors.recipients}
              required
            >
              <Textarea
                rows={3}
                value={draft.recipientsText}
                onChange={(event) =>
                  set({ recipientsText: event.target.value })
                }
                placeholder={t("reportBuilder.schedule.recipientsPlaceholder")}
              />
            </FormField>

            {serverError && (
              <p
                role="alert"
                className="flex items-start gap-2 text-sm leading-5 font-medium text-danger"
              >
                <ShieldAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {serverCode === "EXPORT_PII_APPROVAL_REQUIRED"
                  ? t("reportBuilder.schedule.personalHint")
                  : serverError}
              </p>
            )}
          </form>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            {t("common.cancel")}
          </Button>
          {!personal && (
            <Button
              type="submit"
              form="report-schedule-form"
              loading={create.isPending}
            >
              {t("reportBuilder.schedule.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
