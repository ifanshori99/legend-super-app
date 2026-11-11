// Menu photo field (PRD §8 "Konten Menu": foto). The browser resizes to at
// most 1200px and re-encodes to JPEG before upload, so a phone photo stays
// under the contract's 600 KB body limit; the API answers mediaId + URL.
import * as React from "react";
import { CircleAlert, Trash2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { MediaPlate } from "@/components/ui/media-plate";
import { useUploadMenuImage } from "../hooks";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_EDGE = 1200;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

export type MenuImageValue = { mediaId: string; mediaUrl: string };

type Resized = {
  dataBase64: string;
  contentType: "image/jpeg";
  width: number;
  height: number;
};

/** Downscales and re-encodes in the browser; pure DOM helper (no state). */
async function resizeImage(file: File): Promise<Resized> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  let quality = 0.85;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  // 600 KB decoded ≈ 820k base64 characters.
  while (dataUrl.length > 820_000 && quality > 0.4) {
    quality -= 0.15;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  return {
    dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    contentType: "image/jpeg",
    width,
    height,
  };
}

export function ImageField({
  value,
  onChange,
  requiredNote,
}: {
  value: MenuImageValue | null;
  onChange: (value: MenuImageValue | null) => void;
  /**
   * Why the photo is needed. `blocking` makes it a field error (danger text,
   * aria-invalid on the file input); otherwise it is a warning.
   */
  requiredNote?: { text: string; blocking: boolean };
}) {
  const t = useT();
  const upload = useUploadMenuImage();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [error, setError] = React.useState<string | undefined>();
  const fieldId = React.useId();
  const errorId = `${fieldId}-error`;
  const noteTextId = `${fieldId}-note`;
  const invalid = Boolean(requiredNote?.blocking);
  const describedBy =
    [requiredNote && noteTextId, error && errorId].filter(Boolean).join(" ") ||
    undefined;

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(undefined);
    if (!ACCEPTED.includes(file.type)) {
      setError(t("menu.editor.photoWrongType"));
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError(t("menu.editor.photoTooLarge"));
      return;
    }
    try {
      const resized = await resizeImage(file);
      const result = await upload.mutateAsync({
        fileName: file.name,
        contentType: resized.contentType,
        dataBase64: resized.dataBase64,
        width: resized.width,
        height: resized.height,
      });
      onChange(result.data);
    } catch {
      setError(t("menu.editor.photoUploadFailed"));
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3">
        {/* Q23: a menu item cannot be published without a photo, so the empty
            state is the back-office "Foto wajib" plate (DESIGN.md §4 Media). */}
        <MediaPlate
          src={value?.mediaUrl ?? null}
          alt={t("menu.editor.fields.photo")}
          ratio="thumb"
          missing="required"
          className="w-24 shrink-0"
        />
        <div className="grid gap-1.5">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={upload.isPending}
              aria-busy={upload.isPending || undefined}
              onClick={() => inputRef.current?.click()}
            >
              {value
                ? t("menu.editor.photoChange")
                : t("menu.editor.photoChoose")}
            </Button>
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(null)}
              >
                <Trash2 aria-hidden="true" />
                {t("menu.editor.photoRemove")}
              </Button>
            )}
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {upload.isPending
              ? t("menu.editor.photoUploading")
              : t("menu.editor.photoHint")}
          </p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        aria-label={t("menu.editor.fields.photo")}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        accept={ACCEPTED.join(",")}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {error && (
        <p
          id={errorId}
          className="text-sm leading-5 font-medium text-danger"
          role="alert"
        >
          {error}
        </p>
      )}
      {requiredNote && (
        <p
          id={noteTextId}
          role={invalid ? "alert" : undefined}
          className={
            invalid
              ? "flex items-start gap-1.5 text-sm leading-5 font-medium text-danger"
              : "flex items-start gap-1.5 text-sm leading-5 text-warning"
          }
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{requiredNote.text}</span>
        </p>
      )}
    </div>
  );
}
