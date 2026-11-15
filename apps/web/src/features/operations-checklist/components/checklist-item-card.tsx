// One checklist item on the execution screen. Required evidence (photo,
// number, signature, note) is collected here and recorded through the contract
// endpoint the moment the user marks the item done or failed (PRD v1.7 §3 F41;
// a failed answer also needs a note — the contract stays silent, this is the
// safest reading and is stated in the report). Finished items are read-only:
// changing an answer needs an API rule that does not exist yet.
import * as React from "react";
import { AlertTriangle, Camera, Check, PenLine } from "lucide-react";
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
import type { OutletId } from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";
import type {
  ChecklistItem,
  ChecklistItemResult,
} from "@starter/shared/operations";
import { normalizeImageFile, uploadStorageFile } from "@/features/storage/api";
import { ApiError } from "@/lib/api/errors";
import { useOnline } from "@/lib/use-online";
import {
  evidenceSummary,
  formatDateTime,
  normalizeDecimalInput,
  runErrorMessageKey,
} from "../logic.ts";
import { useRecordChecklistItemResult } from "../hooks.ts";
import type { ChecklistAnswerQueueView } from "../use-answer-queue.ts";
import {
  PhotoField,
  photoUploadErrorKey,
} from "../../ws06-inventory/components/photo-field.tsx";
import { SignatureField, type SignatureHandle } from "./signature-field.tsx";

function signatureUploadErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 0)
      return "opsChecklist.run.item.signatureUploadOffline";
    if (error.status === 503)
      return "opsChecklist.run.item.signatureUploadUnavailable";
  }
  if (error instanceof TypeError)
    return "opsChecklist.run.item.signatureUploadOffline";
  return "opsChecklist.run.item.signatureUploadFailed";
}

type FieldErrors = {
  photo?: string;
  number?: string;
  signature?: string;
  note?: string;
};

export function ChecklistItemCard({
  runId,
  outletId,
  item,
  result,
  editable,
  timeZone,
  answerQueue,
}: {
  runId: string;
  outletId: OutletId;
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
  const signatureHandle = React.useRef<SignatureHandle>(null);
  const photoController = React.useRef<AbortController | null>(null);
  const signatureController = React.useRef<AbortController | null>(null);
  // The uploaded signature is reused by a retry while the drawing is unchanged.
  const signatureUpload = React.useRef<{
    revision: string;
    mediaId: string;
  } | null>(null);

  const [numberValue, setNumberValue] = React.useState("");
  const [note, setNote] = React.useState("");
  const [signerName, setSignerName] = React.useState("");
  const [hasInk, setHasInk] = React.useState(false);
  const [photo, setPhoto] = React.useState<File | null>(null);
  const [photoMediaId, setPhotoMediaId] = React.useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = React.useState(false);
  const [signatureUploading, setSignatureUploading] = React.useState(false);
  const [signatureRetry, setSignatureRetry] = React.useState<
    "done" | "failed" | null
  >(null);
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

  // Leaving the screen cancels any upload still in flight.
  React.useEffect(
    () => () => {
      photoController.current?.abort();
      signatureController.current?.abort();
    },
    [],
  );

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

  async function pickPhoto(file: File) {
    photoController.current?.abort();
    const controller = new AbortController();
    photoController.current = controller;
    setPhoto(file);
    setPhotoMediaId(null);
    setPhotoUploading(true);
    setErrors((current) => ({ ...current, photo: undefined }));
    try {
      const uploaded = await uploadStorageFile({
        purpose: "receipt",
        sourceKind: "checklist_evidence",
        outletId,
        file: await normalizeImageFile(file),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setPhotoMediaId(uploaded.id);
    } catch (error) {
      if (controller.signal.aborted) return;
      setErrors((current) => ({
        ...current,
        photo: t(photoUploadErrorKey(error)),
      }));
    } finally {
      if (photoController.current === controller) {
        photoController.current = null;
        setPhotoUploading(false);
      }
    }
  }

  function clearPhoto() {
    photoController.current?.abort();
    photoController.current = null;
    setPhoto(null);
    setPhotoMediaId(null);
    setPhotoUploading(false);
    setErrors((current) => ({ ...current, photo: undefined }));
  }

  // Uploads the drawn signature as a PNG and returns the API's object id, or
  // null after showing why it failed (the user retries with the same buttons).
  async function uploadSignature(
    status: "done" | "failed",
  ): Promise<string | null> {
    const handle = signatureHandle.current;
    if (!handle) return null;
    const revision = handle.revision();
    const cached = signatureUpload.current;
    if (cached && cached.revision === revision) return cached.mediaId;
    signatureController.current?.abort();
    const controller = new AbortController();
    signatureController.current = controller;
    setSignatureUploading(true);
    try {
      const blob = await handle.exportPng();
      if (blob === null) {
        setErrors((current) => ({
          ...current,
          signature: t("opsChecklist.run.item.evidenceMissing"),
        }));
        return null;
      }
      const uploaded = await uploadStorageFile({
        purpose: "receipt",
        sourceKind: "checklist_evidence",
        outletId,
        file: blob,
        filename: "tanda-tangan.png",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return null;
      // The pad is locked while uploading; if the drawing or name changed
      // anyway, this image is stale and must not be recorded or cached.
      if (handle.revision() !== revision) {
        setErrors((current) => ({
          ...current,
          signature: t("opsChecklist.run.item.signatureChanged"),
        }));
        setSignatureRetry(status);
        return null;
      }
      signatureUpload.current = { revision, mediaId: uploaded.id };
      return uploaded.id;
    } catch (error) {
      if (controller.signal.aborted) return null;
      setErrors((current) => ({
        ...current,
        signature: t(signatureUploadErrorKey(error)),
      }));
      setSignatureRetry(status);
      return null;
    } finally {
      if (signatureController.current === controller) {
        signatureController.current = null;
        setSignatureUploading(false);
      }
    }
  }

  async function save(status: "done" | "failed") {
    if (photoUploading || signatureUploading) return;
    const nextErrors: FieldErrors = {};
    if (requiresPhoto && photoMediaId === null)
      nextErrors.photo =
        errors.photo ?? t("opsChecklist.run.item.evidenceMissing");
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
    setSignatureRetry(null);
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
    let signatureMediaId: string | null = null;
    if (requiresSignature) {
      signatureMediaId = await uploadSignature(status);
      if (signatureMediaId === null) {
        setPendingStatus(null);
        return;
      }
    }
    record.mutate(
      {
        itemId: item.id,
        status,
        numberValue: requiresNumber ? normalizedNumber : null,
        note: note.trim() === "" ? null : note.trim(),
        photoMediaIds: photoMediaId === null ? [] : [photoMediaId],
        signatureMediaId,
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
            <PhotoField
              label={t("opsChecklist.run.evidence.photo")}
              capture="environment"
              contextLabel={item.label}
              hint={t("opsChecklist.run.item.photoHint")}
              mediaId={photoMediaId}
              isUploading={photoUploading}
              disabled={pendingStatus !== null}
              error={errors.photo}
              onSelect={(file) => void pickPhoto(file)}
              onClear={clearPhoto}
              onRetry={photo ? () => void pickPhoto(photo) : undefined}
            />
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
            <div
              className="grid gap-1.5"
              aria-busy={signatureUploading}
              data-slot="checklist-signature-upload"
            >
              <SignatureField
                handleRef={signatureHandle}
                hasInk={hasInk}
                disabled={signatureUploading || pendingStatus !== null}
                onInkChange={(value) => {
                  setHasInk(value);
                  setErrors((current) => ({
                    ...current,
                    signature: undefined,
                  }));
                  setSignatureRetry(null);
                }}
                signerName={signerName}
                onSignerNameChange={(name) => {
                  setSignerName(name);
                  setErrors((current) => ({
                    ...current,
                    signature: undefined,
                  }));
                  setSignatureRetry(null);
                }}
              />
              {signatureUploading && (
                <p
                  role="status"
                  className="text-sm leading-5 text-muted-foreground"
                >
                  {t("opsChecklist.run.item.signatureUploading")}
                </p>
              )}
              {errors.signature && (
                <p
                  role="alert"
                  className="text-sm leading-5 font-medium text-danger"
                >
                  {errors.signature}
                </p>
              )}
              {errors.signature && signatureRetry && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  disabled={pendingStatus !== null || signatureUploading}
                  onClick={() => void save(signatureRetry)}
                >
                  {t("common.retry")}
                </Button>
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
                photoUploading ||
                signatureUploading ||
                (requiresMedia ? !online : !answerQueue?.ready && !online)
              }
              onClick={() => void save("done")}
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
                photoUploading ||
                signatureUploading ||
                (requiresMedia ? !online : !answerQueue?.ready && !online)
              }
              onClick={() => void save("failed")}
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
