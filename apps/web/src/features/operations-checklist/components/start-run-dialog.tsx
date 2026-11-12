// "Mulai checklist" dialog: template + shift date + assignee. The template
// decides the station/zone/due time (PRD v1.7 §3 F41: per shift, station and
// zone); the run itself is created through the contract endpoint.
import * as React from "react";
import { CalendarClock, MapPin } from "lucide-react";
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
import { useToast } from "@/components/ui/toast";
import type { OutletId, UserId } from "@starter/shared/core";
import type {
  ChecklistRun,
  ChecklistTemplate,
} from "@starter/shared/operations";
import { typeLabelKey } from "../logic.ts";
import { assigneeOptions, shiftName, stationName } from "../fixtures.ts";
import { useCreateChecklistRun } from "../hooks.ts";

export function StartRunDialog({
  open,
  onOpenChange,
  outletId,
  templates,
  defaultShiftDate,
  zoneName,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outletId: string;
  templates: readonly ChecklistTemplate[];
  /** Outlet business date (D-CORE-7) computed by the page from the clock. */
  defaultShiftDate: string;
  /** Resolves the selected template's zone id to its floor name. */
  zoneName: (zoneId: string | null) => string | null;
  onStarted: (run: ChecklistRun) => void;
}) {
  const t = useT();
  const toast = useToast();
  const createRun = useCreateChecklistRun();
  const [templateId, setTemplateId] = React.useState<string | null>(null);
  const [shiftDate, setShiftDate] = React.useState(defaultShiftDate);
  const [assigneeId, setAssigneeId] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string | undefined>();

  const template = templates.find((row) => row.id === templateId) ?? null;
  const people = assigneeOptions();
  const scope = template
    ? [
        shiftName(template.schedule.shiftTemplateId) ??
          t("opsChecklist.runs.scopeAnyShift"),
        stationName(template.schedule.stationId) ??
          t("opsChecklist.runs.scopeAnyStation"),
        zoneName(template.schedule.zoneId) ??
          t("opsChecklist.runs.scopeAnyZone"),
      ].join(" · ")
    : null;

  function reset() {
    setTemplateId(null);
    setShiftDate(defaultShiftDate);
    setAssigneeId(null);
    setErrors({});
    setFormError(undefined);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: Record<string, string | undefined> = {};
    if (template === null)
      nextErrors.template = t("opsChecklist.start.templateRequired");
    if (shiftDate.trim() === "")
      nextErrors.shiftDate = t("opsChecklist.start.shiftDateRequired");
    if (assigneeId === null)
      nextErrors.assignee = t("opsChecklist.start.assigneeRequired");
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    if (template === null || assigneeId === null) return;

    createRun.mutate(
      {
        outletId: outletId as OutletId,
        templateId: template.id,
        shiftDate,
        shiftTemplateId: template.schedule.shiftTemplateId,
        assignedTo: assigneeId as UserId,
      },
      {
        onSuccess: (run) => {
          toast({ title: t("opsChecklist.start.started"), tone: "success" });
          handleOpenChange(false);
          onStarted(run);
        },
        onError: () => setFormError(t("opsChecklist.start.error")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-slot="start-run-dialog">
        <DialogHeader>
          <DialogTitle>{t("opsChecklist.start.title")}</DialogTitle>
          <DialogDescription>{t("opsChecklist.start.hint")}</DialogDescription>
        </DialogHeader>

        {templates.length === 0 ? (
          <p className="rounded-container bg-surface-2 p-3 text-sm leading-5 text-muted-foreground">
            {t("opsChecklist.start.noTemplates")}
          </p>
        ) : (
          <form className="grid gap-4" onSubmit={submit} noValidate>
            <FormField
              label={t("opsChecklist.start.template")}
              required
              error={errors.template}
              hint={t("opsChecklist.start.templateHint")}
            >
              <Select
                value={templateId ?? undefined}
                onValueChange={(value) => {
                  setTemplateId(value);
                  setErrors((current) => ({ ...current, template: undefined }));
                }}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("opsChecklist.start.templatePlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.name} · {t(typeLabelKey(row.type))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {template && (
              <div
                data-slot="start-run-scope"
                className="grid gap-1 rounded-container bg-surface-2 p-3 text-sm leading-5 text-muted-foreground"
              >
                <span className="flex items-start gap-1.5">
                  <MapPin
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  {scope}
                </span>
                <span className="flex items-center gap-1.5 tabular">
                  <CalendarClock className="size-4" aria-hidden="true" />
                  {t("opsChecklist.start.dueTime", {
                    time: template.schedule.dueTime,
                  })}
                </span>
              </div>
            )}

            <FormField
              label={t("opsChecklist.start.shiftDate")}
              required
              error={errors.shiftDate}
            >
              <Input
                type="date"
                value={shiftDate}
                onChange={(event) => {
                  setShiftDate(event.target.value);
                  setErrors((current) => ({
                    ...current,
                    shiftDate: undefined,
                  }));
                }}
              />
            </FormField>

            <FormField
              label={t("opsChecklist.start.assignee")}
              required
              error={errors.assignee}
              hint={t("opsChecklist.start.assigneeHint")}
            >
              <Select
                value={assigneeId ?? undefined}
                onValueChange={(value) => {
                  setAssigneeId(value);
                  setErrors((current) => ({ ...current, assignee: undefined }));
                }}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("opsChecklist.start.assigneePlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {people.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {formError && (
              <p
                role="alert"
                className="text-sm leading-5 font-medium text-danger"
              >
                {formError}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={createRun.isPending}>
                {createRun.isPending
                  ? t("opsChecklist.start.submitting")
                  : t("opsChecklist.start.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
