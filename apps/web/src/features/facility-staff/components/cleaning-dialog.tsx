// The cleaning cycle for one unit (PRD v1.7 §3 F22 "Siklus Kebersihan",
// FAC-06): start the task, tick the four checklist items and attach an optional
// photo. The unit only returns to `available` when the contract machine accepts
// the complete call, and the board refetches on success.
//
// The photo is a local preview only: the screen stores a UUID media id in the
// ticket's `mediaIds` (the contract shape), but no storage upload exists yet —
// wiring it to the WS-00 storage adapter is a follow-up (reported with bead
// legend-1oi9).
import * as React from "react";
import { X } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import { MediaPlate } from "@/components/ui/media-plate";
import { useToast } from "@/components/ui/toast";
import {
  cleaningTaskStatus,
  type CleaningTask,
} from "@starter/shared/facility";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useCompleteCleaningTask, useStartCleaningTask } from "../hooks.ts";
import {
  CHECKLIST_KEYS,
  CHECKLIST_LABEL_KEYS,
  type CleaningChecklistKey,
} from "../view.ts";

type Checks = Record<CleaningChecklistKey, boolean>;

function initialChecks(task: CleaningTask): Checks {
  const checks = Object.fromEntries(
    CHECKLIST_KEYS.map((key) => [key, false]),
  ) as Checks;
  for (const item of task.checklist) checks[item.key] = item.done;
  return checks;
}

export function CleaningDialog({
  task,
  unitCode,
  onClose,
}: {
  task: CleaningTask;
  unitCode: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const start = useStartCleaningTask();
  const complete = useCompleteCleaningTask();
  const [started, setStarted] = React.useState(
    () => cleaningTaskStatus(task) !== "pending",
  );
  const [checks, setChecks] = React.useState<Checks>(() => initialChecks(task));
  const [photo, setPhoto] = React.useState<{
    url: string;
    mediaId: string;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const checklistTitleId = React.useId();

  React.useEffect(() => {
    if (!photo) return;
    return () => URL.revokeObjectURL(photo.url);
  }, [photo]);

  const allChecked = CHECKLIST_KEYS.every((key) => checks[key]);

  const handleStart = () => {
    setError(null);
    start.mutate(
      { taskId: task.id, body: {} },
      {
        onSuccess: () => {
          setStarted(true);
          toast({
            title: t("facilityStaff.cleaning.toast.started", {
              unit: unitCode,
            }),
            tone: "success",
          });
        },
        onError: (caught) => setError(caught.message),
      },
    );
  };

  const handleComplete = () => {
    setError(null);
    if (!started) {
      setError(t("facilityStaff.cleaning.dialog.mustStart"));
      return;
    }
    if (!allChecked) {
      setError(t("facilityStaff.cleaning.dialog.incomplete"));
      return;
    }
    complete.mutate(
      {
        taskId: task.id,
        body: {
          checklist: CHECKLIST_KEYS.map((key) => ({
            key,
            done: true,
            note: null,
          })),
          mediaIds: photo ? [photo.mediaId] : undefined,
        },
      },
      {
        onSuccess: () => {
          toast({
            title: t("facilityStaff.cleaning.toast.completed", {
              unit: unitCode,
            }),
            tone: "success",
          });
          onClose();
        },
        onError: (caught) => setError(caught.message),
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-slot="cleaning-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("facilityStaff.cleaning.dialog.title", { unit: unitCode })}
          </DialogTitle>
          <DialogDescription>
            {t("facilityStaff.cleaning.dialog.hint")}
          </DialogDescription>
        </DialogHeader>

        <section
          aria-labelledby={checklistTitleId}
          className="grid gap-2"
          data-slot="cleaning-checklist"
        >
          <h3 id={checklistTitleId} className="type-heading">
            {t("facilityStaff.cleaning.dialog.checklistTitle")}
          </h3>
          {!started && (
            <p className="text-sm text-muted-foreground">
              {t("facilityStaff.cleaning.dialog.startHint")}
            </p>
          )}
          <div className="grid gap-2">
            {CHECKLIST_KEYS.map((key) => {
              const id = `${task.id}-${key}`;
              return (
                <div key={key} className="flex min-h-11 items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={checks[key]}
                    disabled={!started}
                    onCheckedChange={(value) =>
                      setChecks((previous) => ({
                        ...previous,
                        [key]: value === true,
                      }))
                    }
                  />
                  <Label htmlFor={id}>{t(CHECKLIST_LABEL_KEYS[key])}</Label>
                </div>
              );
            })}
          </div>
        </section>

        <FormField
          label={t("facilityStaff.cleaning.dialog.photoLabel")}
          hint={t("facilityStaff.cleaning.dialog.photoHint")}
        >
          <Input
            type="file"
            accept="image/*"
            data-slot="cleaning-photo-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setPhoto({
                url: URL.createObjectURL(file),
                // Mock-only media id: the stored contract value is a uuid; the
                // real upload replaces it with the storage adapter's id.
                mediaId: newIdempotencyKey(),
              });
            }}
          />
        </FormField>

        {photo && (
          <div className="grid max-w-xs gap-2">
            <MediaPlate
              src={photo.url}
              alt={t("facilityStaff.cleaning.dialog.photoAlt", {
                unit: unitCode,
              })}
              ratio="card"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={() => setPhoto(null)}
            >
              <X aria-hidden="true" />
              {t("facilityStaff.cleaning.dialog.removePhoto")}
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
          {started ? (
            <Button
              type="button"
              loading={complete.isPending}
              onClick={handleComplete}
            >
              {t("facilityStaff.cleaning.dialog.submitComplete")}
            </Button>
          ) : (
            <Button
              type="button"
              loading={start.isPending}
              onClick={handleStart}
            >
              {t("facilityStaff.cleaning.dialog.submitStart")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
