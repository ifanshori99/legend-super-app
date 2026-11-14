// Shared photo evidence control for receipt, petty-purchase, and waste forms.
// Uploads belong to each form; persisted photos are read through signed URLs.
import * as React from "react";
import { ImagePlus, X } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useStorageObjectUrl } from "@/features/storage/hooks";
import { ApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";

export const WASTE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const WASTE_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function photoUploadErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 0) return "waste.form.photoUploadOffline";
    if (error.status === 503) return "waste.form.photoUploadUnavailable";
    if (error.status === 413) return "waste.form.photoTooLarge";
    if (error.status === 415 || error.status === 422)
      return "waste.form.photoInvalid";
  }
  if (error instanceof Error) {
    if (error.message === "fileTooLarge") return "waste.form.photoTooLarge";
    if (error.message === "fileWrongType") return "waste.form.photoInvalid";
    if (error instanceof TypeError) return "waste.form.photoUploadOffline";
  }
  return "waste.form.photoUploadFailed";
}

export function StoragePhoto({
  mediaId,
  alt,
  className,
}: {
  mediaId: string;
  alt?: string;
  className?: string;
}) {
  const t = useT();
  const image = useStorageObjectUrl(mediaId, "thumbnail");
  const [failedImage, setFailedImage] = React.useState<{
    mediaId: string;
    url: string | undefined;
  } | null>(null);
  const renewedId = React.useRef<string | null>(null);
  const imageFailed =
    failedImage?.mediaId === mediaId && failedImage.url === image.url;
  const failed = image.isError || imageFailed;

  return (
    <div className="grid gap-2">
      {image.url && !imageFailed ? (
        <img
          src={image.url}
          alt={alt ?? t("waste.form.photoAlt")}
          className={cn("size-24 rounded-field border object-cover", className)}
          onError={() => {
            setFailedImage({ mediaId, url: image.url });
            // One automatic renewal per object prevents a broken provider
            // response from making an endless signed-URL request loop.
            if (renewedId.current !== mediaId) {
              renewedId.current = mediaId;
              image.onError();
            }
          }}
        />
      ) : (
        <span
          className={cn(
            "grid size-24 place-items-center rounded-field border bg-muted text-muted-foreground",
            className,
          )}
        >
          <ImagePlus className="size-6" aria-hidden="true" />
        </span>
      )}
      {failed ? (
        <div className="grid gap-1">
          <p role="alert" className="text-sm text-danger">
            {t("waste.form.photoReadFailed")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={() => {
              setFailedImage(null);
              renewedId.current = mediaId;
              image.onError();
            }}
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : !image.url ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
    </div>
  );
}

export function PhotoField({
  previewUrl = null,
  mediaId = null,
  isUploading = false,
  disabled = false,
  error,
  onSelect,
  onClear,
  onRetry,
  label,
  hint,
  required = false,
  capture,
  contextLabel,
  chooseRef,
}: {
  /** Overrides the waste-log wording, e.g. where the photo is mandatory. */
  label?: string;
  hint?: string;
  /** Mandatory photo: aria-required on the input and a visible marker. */
  required?: boolean;
  /** Opens the camera directly on phones that support it. */
  capture?: "environment" | "user";
  /** Names the subject in button labels, e.g. "Pilih foto — Lantai bar". */
  contextLabel?: string;
  /** Lets a form move focus to the field, e.g. when the photo is missing. */
  chooseRef?: React.Ref<HTMLButtonElement>;
  previewUrl?: string | null;
  mediaId?: string | null;
  isUploading?: boolean;
  disabled?: boolean;
  error?: string;
  onSelect: (file: File) => void;
  onClear: () => void;
  onRetry?: () => void;
}) {
  const t = useT();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const inputId = React.useId();
  const errorId = `${inputId}-error`;
  const withContext = (text: string) =>
    contextLabel ? `${text} — ${contextLabel}` : text;
  const chooseText =
    mediaId || previewUrl
      ? t("waste.form.photoChange")
      : t("waste.form.photoChoose");
  const removeText = isUploading
    ? t("waste.form.photoCancelUpload")
    : t("waste.form.photoRemove");
  const statusText = isUploading
    ? t("waste.form.photoUploading")
    : mediaId
      ? t("waste.form.photoUploaded")
      : "";
  return (
    <div className="grid gap-2" aria-busy={isUploading}>
      <label htmlFor={inputId} className="text-sm leading-5 font-semibold">
        {label ?? t("waste.form.photo")}
        {required && (
          <span className="font-normal text-muted-foreground">
            {" "}
            ({t("common.required")})
          </span>
        )}
      </label>
      <p className="text-sm leading-5 text-muted-foreground">
        {hint ?? t("waste.form.photoHint")}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {mediaId ? (
          <StoragePhoto mediaId={mediaId} />
        ) : previewUrl ? (
          <img
            src={previewUrl}
            alt={t("waste.form.photoAlt")}
            className="size-24 rounded-field border object-cover"
          />
        ) : (
          <span className="grid size-24 place-items-center rounded-field border bg-muted text-muted-foreground">
            <ImagePlus className="size-6" aria-hidden="true" />
          </span>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept="image/*"
            capture={capture}
            aria-required={required || undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={disabled || isUploading}
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onSelect(file);
              // Let the same file be picked again after an error.
              event.target.value = "";
            }}
          />
          <Button
            ref={chooseRef}
            type="button"
            variant="outline"
            size="sm"
            aria-label={contextLabel ? withContext(chooseText) : undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={disabled || isUploading}
            onClick={() => inputRef.current?.click()}
          >
            <ImagePlus aria-hidden="true" />
            {chooseText}
          </Button>
          {(mediaId || previewUrl || error || isUploading) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={contextLabel ? withContext(removeText) : undefined}
              disabled={disabled}
              onClick={onClear}
            >
              <X aria-hidden="true" />
              {removeText}
            </Button>
          )}
        </div>
      </div>
      <div aria-live="polite" className="text-sm text-muted-foreground">
        {statusText}
      </div>
      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-sm font-medium text-danger"
        >
          {error}
        </p>
      )}
      {error && onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          aria-label={contextLabel ? withContext(t("common.retry")) : undefined}
          disabled={disabled || isUploading}
          onClick={onRetry}
        >
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}
