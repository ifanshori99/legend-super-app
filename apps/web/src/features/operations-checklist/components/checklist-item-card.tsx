// One checklist item on the execution screen. Required evidence (photo,
// number, signature, note) is collected here and recorded through the contract
// endpoint the moment the user marks the item done or failed (PRD v1.7 §3 F41;
// a failed answer also needs a note — the contract stays silent, this is the
// safest reading and is stated in the report). Finished items are read-only:
// changing an answer needs an API rule that does not exist yet.
import * as React from "react";
import { AlertTriangle, Camera, Check, PenLine, Trash2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import type { MessageKey } from "@starter/shared/i18n";
import type {
  ChecklistItem,
  ChecklistItemResult,
} from "@starter/shared/operations";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useOnline } from "@/lib/use-online";
import {
  evidenceSummary,
  formatDateTime,
  normalizeDecimalInput,
  runErrorMessageKey,
} from "../logic.ts";
import { useRecordChecklistItemResult } from "../hooks.ts";
import type { ChecklistAnswerQueueView } from "../use-answer-queue.ts";
import { SignatureField } from "./signature-field.tsx";

type FieldErrors = {
  photo?: string;
  number?: string;
  signature?: string;
  note?: string;
};

export function ChecklistItemCard({
  runId,
  item,
  result,
  editable,
  timeZone,
  answerQueue,
}: {
  runId: string;
  item: ChecklistItem;
  result: ChecklistItemResult | undefined;
  /** True only while the run is in progress (the machine's write window). */
  editable: boolean;
  timeZone: string;
  answerQueue?: ChecklistAnswerQueueView;
}) {
  const t = useT();
  const record = useRecordChecklistItemResult(runId);
  const online = useOnline();
  const headingId = React.useId();
  const fileInput = React.useRef<HTMLInputElement>(null);

  const [numberValue, setNumberValue] = React.useState("");
  const [note, setNote] = React.useState("");
  const [signerName, setSignerName] = React.useState("");
  const [hasInk, setHasInk] = React.useState(false);
  const [photo, setPhoto] = React.useState<{
    mediaId: string;
    url: string;
    name: string;
  } | null>(null);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [saveErrorKey, setSaveErrorKey] = React.useState<MessageKey | null>(
    null,
  );
  const [queueSaveError, setQueueSaveError] = React.useState<string | null>(
    null,
  );
  const [pendingStatus, setPendingStatus] = React.useState<
    "done" | "failed" | null
  >(null);
  const [discardKey, setDiscardKey] = React.useState<string | null>(null);
  const [discarding, setDiscarding] = React.useState(false);
  const [discardError, setDiscardError] = React.useState<string | null>(null);

  // Local preview only: a mock media id stands in until upload wiring lands.
  React.useEffect(() => {
    if (!photo) return;
    return () => URL.revokeObjectURL(photo.url);
  }, [photo]);

  const requiresPhoto = item.requiredEvidence.includes("photo");
  const requiresNumber = item.requiredEvidence.includes("number");
  const requiresSignature = item.requiredEvidence.includes("signature");
  const finished = result !== undefined && result.status !== "pending";
  const requiresMedia = requiresPhoto || requiresSignature;
  const queued = answerQueue?.entries.find((entry) => entry.itemId === item.id);
  const conflicts = (answerQueue?.conflicts ?? []).filter(
    (entry) => entry.itemId === item.id,
  );

  async function discardLocalAnswer() {
    if (!answerQueue || discardKey === null) return;
    setDiscarding(true);
    setDiscardError(null);
    try {
      await answerQueue.discardConflict(discardKey);
      setDiscardKey(null);
    } catch (error) {
      setDiscardError(
        error instanceof Error
          ? error.message
          : t("opsChecklist.run.item.discardLocalFailed"),
      );
    } finally {
      setDiscarding(false);
    }
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPhoto({
      mediaId: newIdempotencyKey(),
      url: URL.createObjectURL(file),
      name: file.name,
    });
    setErrors((current) => ({ ...current, photo: undefined }));
    // Allow re-picking the same file.
    event.target.value = "";
  }

  function save(status: "done" | "failed") {
    const nextErrors: FieldErrors = {};
    if (requiresPhoto && photo === null)
      nextErrors.photo = t("opsChecklist.run.item.evidenceMissing");
    const normalizedNumber = normalizeDecimalInput(numberValue);
    if (requiresNumber) {
      if (numberValue.trim() === "")
        nextErrors.number = t("opsChecklist.run.item.evidenceMissing");
      else if (normalizedNumber === null)
        nextErrors.number = t("opsChecklist.run.item.numberInvalid");
    }
    if (requiresSignature && !hasInk && signerName.trim() === "")
      nextErrors.signature = t("opsChecklist.run.item.evidenceMissing");
    if (status === "failed" && note.trim() === "")
      nextErrors.note = t("opsChecklist.run.item.noteRequired");
    setErrors(nextErrors);
    setSaveErrorKey(null);
    setQueueSaveError(null);
    if (
      Object.values(nextErrors).some(Boolean) ||
      (!online && (requiresMedia || !answerQueue?.ready))
    )
      return;

    setPendingStatus(status);
    if (!requiresMedia && answerQueue?.ready) {
      void answerQueue
        .save({
          itemId: item.id,
          status,
          numberValue: requiresNumber ? normalizedNumber : null,
          note: note.trim() === "" ? null : note.trim(),
          photoMediaIds: [],
          signatureMediaId: null,
        })
        .catch((error: unknown) => {
          setQueueSaveError(
            error instanceof Error
              ? error.message
              : t("opsChecklist.run.item.queueSaveFailed"),
          );
        })
        .finally(() => setPendingStatus(null));
      return;
    }
    record.mutate(
      {
        itemId: item.id,
        status,
        numberValue: requiresNumber ? normalizedNumber : null,
        note: note.trim() === "" ? null : note.trim(),
        photoMediaIds: photo === null ? [] : [photo.mediaId],
        signatureMediaId:
          requiresSignature && (hasInk || signerName.trim() !== "")
            ? newIdempotencyKey()
            : null,
      },
      {
        onSuccess: () => {
          setPendingStatus(null);
        },
        onError: (error) => {
          setPendingStatus(null);
          setSaveErrorKey(
            runErrorMessageKey(error, "opsChecklist.run.item.saveFailed"),
          );
        },
      },
    );
  }

  return (
    <article
      data-slot="checklist-item"
      data-item-id={item.id}
      data-item-status={result?.status ?? "pending"}
      data-queue-state={
        conflicts.length > 0
          ? "conflict"
          : queued
            ? queued.error
              ? "error"
              : "pending"
            : undefined
      }
      data-evidence={item.requiredEvidence.join(" ") || undefined}
      aria-labelledby={headingId}
      className="grid gap-3 rounded-container border-(length:--border-w) border-border bg-card p-card shadow-hairline"
    >
      <div className="grid gap-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 id={headingId} className="type-heading min-w-0">
            {item.label}
          </h3>
          {finished && result && (
            <StatusPill
              status={result.status === "failed" ? "danger" : "success"}
            >
              {t(
                result.status === "failed"
                  ? "opsChecklist.run.item.resultFailed"
                  : "opsChecklist.run.item.resultDone",
              )}
            </StatusPill>
          )}
        </div>
        {item.instruction && (
          <p className="text-sm leading-5 text-muted-foreground">
            {item.instruction}
          </p>
        )}
        <p className="text-sm leading-5 text-muted-foreground">
          {item.requiredEvidence.length === 0
            ? t("opsChecklist.run.evidenceNone")
            : t("opsChecklist.run.evidenceRequired", {
                evidence: evidenceSummary(item, t),
              })}
        </p>
      </div>

      {conflicts.map((entry) => (
        <div
          key={entry.idempotencyKey}
          data-slot="checklist-item-conflict"
          className="grid gap-2 rounded-control border-(length:--border-w) border-border bg-surface-2 p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">
              {t("opsChecklist.run.item.conflictBadge")}
            </Badge>
            <span className="text-sm leading-5 font-medium">
              {t("opsChecklist.run.item.conflictStatus", {
                status: t(
                  entry.body.status === "failed"
                    ? "opsChecklist.run.item.resultFailed"
                    : "opsChecklist.run.item.resultDone",
                ),
              })}
            </span>
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("opsChecklist.run.item.conflictHint")}
          </p>
          {entry.body.numberValue !== null &&
            entry.body.numberValue !== undefined && (
              <p className="text-sm leading-5 tabular">
                {t("opsChecklist.run.item.numberValue", {
                  value: entry.body.numberValue,
                })}
              </p>
            )}
          {entry.body.note && (
            <p className="text-sm leading-5 wrap-break-word">
              {t("opsChecklist.run.item.noteValue", { note: entry.body.note })}
            </p>
          )}
          {!!entry.body.photoMediaIds?.length && (
            <Badge tone="neutral">
              {t("opsChecklist.run.item.photoStored", {
                count: entry.body.photoMediaIds.length,
              })}
            </Badge>
          )}
          {entry.body.signatureMediaId && (
            <Badge tone="neutral">
              {t("opsChecklist.run.item.signatureLabel")}
            </Badge>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={!answerQueue?.ready}
            onClick={() => {
              setDiscardError(null);
              setDiscardKey(entry.idempotencyKey);
            }}
          >
            {t("opsChecklist.run.item.discardLocal")}
          </Button>
        </div>
      ))}

      {finished && result ? (
        <div data-slot="checklist-item-result" className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {result.numberValue !== null && (
              <Badge tone="neutral">
                {t("opsChecklist.run.item.numberValue", {
                  value: result.numberValue,
                })}
              </Badge>
            )}
            {result.photoMediaIds.length > 0 && (
              <Badge tone="neutral">
                <Camera aria-hidden="true" />
                {t("opsChecklist.run.item.photoStored", {
                  count: result.photoMediaIds.length,
                })}
              </Badge>
            )}
            {result.signatureMediaId !== null && (
              <Badge tone="neutral">
                <PenLine aria-hidden="true" />
                {t("opsChecklist.run.item.signatureLabel")}
              </Badge>
            )}
          </div>
          {result.note !== null && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("opsChecklist.run.item.noteValue", { note: result.note })}
            </p>
          )}
          {result.completedAt !== null && (
            <p className="text-sm leading-5 text-muted-foreground tabular">
              {t("opsChecklist.run.item.completedAt", {
                time: formatDateTime(result.completedAt, timeZone),
              })}
            </p>
          )}
        </div>
      ) : queued ? (
        <div data-slot="checklist-item-queued" className="grid gap-1.5">
          <p role="status" className="text-sm leading-5 font-medium">
            {t("opsChecklist.run.item.queuedTitle")}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("opsChecklist.run.item.queuedHint")}
          </p>
          {queued.body.numberValue !== null &&
            queued.body.numberValue !== undefined && (
              <p className="text-sm leading-5 tabular">
                {queued.body.numberValue}
              </p>
            )}
          {queued.body.note && (
            <p className="text-sm leading-5 text-muted-foreground">
              {queued.body.note}
            </p>
          )}
        </div>
      ) : conflicts.length > 0 ? null : editable ? (
        <div className="grid gap-3" data-slot="checklist-item-evidence">
          {requiresPhoto && (
            <div className="grid gap-1.5">
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                data-slot="checklist-photo-input"
                onChange={handleFile}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                >
                  <Camera aria-hidden="true" />
                  {photo
                    ? t("opsChecklist.run.item.photoReplace")
                    : t("opsChecklist.run.item.photoAction")}
                </Button>
                {photo && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPhoto(null)}
                  >
                    <Trash2 aria-hidden="true" />
                    {t("opsChecklist.run.item.photoRemove")}
                  </Button>
                )}
              </div>
              {photo && (
                <div className="grid gap-1">
                  <img
                    src={photo.url}
                    alt={t("opsChecklist.run.item.photoPreviewAlt", {
                      label: item.label,
                    })}
                    data-slot="checklist-photo-preview"
                    className="max-h-48 w-full rounded-media border-(length:--border-w) border-border object-cover"
                  />
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("opsChecklist.run.item.photoMockNote")}
                  </p>
                </div>
              )}
              {errors.photo && (
                <p
                  role="alert"
                  className="text-sm leading-5 font-medium text-danger"
                >
                  {errors.photo}
                </p>
              )}
            </div>
          )}

          {requiresNumber && (
            <FormField
              label={t("opsChecklist.run.item.numberLabel")}
              hint={t("opsChecklist.run.item.numberHint")}
              error={errors.number}
              required
            >
              <Input
                inputMode="decimal"
                value={numberValue}
                onChange={(event) => {
                  setNumberValue(event.target.value);
                  setErrors((current) => ({ ...current, number: undefined }));
                }}
              />
            </FormField>
          )}

          {requiresSignature && (
            <div className="grid gap-1.5">
              <SignatureField
                hasInk={hasInk}
                onInkChange={setHasInk}
                signerName={signerName}
                onSignerNameChange={(value) => {
                  setSignerName(value);
                  setErrors((current) => ({
                    ...current,
                    signature: undefined,
                  }));
                }}
              />
              {errors.signature && (
                <p
                  role="alert"
                  className="text-sm leading-5 font-medium text-danger"
                >
                  {errors.signature}
                </p>
              )}
            </div>
          )}

          <FormField
            label={t("opsChecklist.run.item.note")}
            hint={t("opsChecklist.run.item.noteHint")}
            error={errors.note}
          >
            <Textarea
              value={note}
              rows={2}
              onChange={(event) => {
                setNote(event.target.value);
                setErrors((current) => ({ ...current, note: undefined }));
              }}
            />
          </FormField>

          {saveErrorKey && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {t(saveErrorKey)}
            </p>
          )}

          {queueSaveError && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {queueSaveError}
            </p>
          )}

          {!online && requiresMedia && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("opsChecklist.run.item.offlineMediaHint")}
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              loading={pendingStatus === "done"}
              disabled={
                pendingStatus !== null ||
                (requiresMedia ? !online : !answerQueue?.ready && !online)
              }
              onClick={() => save("done")}
            >
              <Check aria-hidden="true" />
              {t("opsChecklist.run.item.done")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="text-danger"
              loading={pendingStatus === "failed"}
              disabled={
                pendingStatus !== null ||
                (requiresMedia ? !online : !answerQueue?.ready && !online)
              }
              onClick={() => save("failed")}
            >
              <AlertTriangle aria-hidden="true" />
              {t("opsChecklist.run.item.failed")}
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={discardKey !== null}
        onOpenChange={(open) => {
          if (!open && !discarding) setDiscardKey(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("opsChecklist.run.item.discardLocalTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("opsChecklist.run.item.discardLocalHint", {
                label: item.label,
              })}
            </DialogDescription>
          </DialogHeader>
          {discardError && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {discardError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={discarding}
              onClick={() => setDiscardKey(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={discarding}
              onClick={() => void discardLocalAnswer()}
            >
              {t("opsChecklist.run.item.discardLocal")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}
