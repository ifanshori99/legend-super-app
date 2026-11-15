// The cleaning cycle for one unit (PRD v1.7 §3 F22 "Siklus Kebersihan",
// FAC-06): start the task, tick the four checklist items and attach an optional
// photo. The unit only returns to `available` when the contract machine accepts
// the complete call, and the board refetches on success.
//
// The photo is uploaded to storage (sourceKind `cleaning_task`) as soon as it
// is picked; the ticket's `mediaIds` carries the id the API returned, and
// completing is blocked while an upload is running or failed.
import * as React from "react";
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
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import {
  cleaningTaskStatus,
  type CleaningTask,
} from "@starter/shared/facility";
import { normalizeImageFile, uploadStorageFile } from "@/features/storage/api";
import {
  PhotoField,
  photoUploadErrorKey,
} from "@/features/ws06-inventory/components/photo-field";
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
  const [photo, setPhoto] = React.useState<File | null>(null);
  const [mediaId, setMediaId] = React.useState<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [photoError, setPhotoError] = React.useState<string | null>(null);
  const uploadController = React.useRef<AbortController | null>(null);
  const checklistTitleId = React.useId();

  React.useEffect(() => () => uploadController.current?.abort(), []);

  const photoPending = isUploading || Boolean(photo && !mediaId);

  async function uploadPhoto(file: File) {
    uploadController.current?.abort();
    const controller = new AbortController();
    uploadController.current = controller;
    setMediaId(null);
    setPhotoError(null);
    setIsUploading(true);
    try {
      const uploaded = await uploadStorageFile({
        purpose: "receipt",
        sourceKind: "cleaning_task",
        outletId: task.outletId,
        file: await normalizeImageFile(file),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setMediaId(uploaded.id);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setPhotoError(t(photoUploadErrorKey(caught)));
    } finally {
      if (uploadController.current === controller) {
        uploadController.current = null;
        setIsUploading(false);
      }
    }
  }

  function pickPhoto(file: File) {
    setPhoto(file);
    void uploadPhoto(file);
  }

  function clearPhoto() {
    uploadController.current?.abort();
    uploadController.current = null;
    setPhoto(null);
    setMediaId(null);
    setIsUploading(false);
    setPhotoError(null);
  }

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
    if (photoPending) return;
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
          mediaIds: mediaId ? [mediaId] : undefined,
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

        <PhotoField
          label={t("facilityStaff.cleaning.dialog.photoLabel")}
          hint={t("facilityStaff.cleaning.dialog.photoHint")}
          mediaId={mediaId}
          isUploading={isUploading}
          disabled={complete.isPending}
          error={photoError ?? undefined}
          capture="environment"
          onSelect={pickPhoto}
          onClear={clearPhoto}
          onRetry={photo ? () => void uploadPhoto(photo) : undefined}
        />

        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}

        {started && photoPending && !isUploading && (
          <p className="text-sm text-muted-foreground">
            {t("facilityStaff.cleaning.dialog.photoFailedBlock")}
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
              disabled={photoPending}
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
