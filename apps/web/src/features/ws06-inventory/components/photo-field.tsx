// Optional photo evidence for a waste log (PRD §16 "Waste & Spoilage":
// "foto opsional"). The browser picks and previews the file; the media id is
// minted when the log is saved. The real upload transport through WS-00
// storage is still open (bead legend-7nv1), so mock mode stores the id only —
// see the note in waste-form-dialog.tsx.
import * as React from "react";
import { ImagePlus, X } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";

export const WASTE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const WASTE_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function PhotoField({
  previewUrl,
  error,
  onSelect,
  onClear,
}: {
  previewUrl: string | null;
  error?: string;
  onSelect: (file: File) => void;
  onClear: () => void;
}) {
  const t = useT();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const inputId = React.useId();
  return (
    <div className="grid gap-2">
      <p className="text-sm leading-5 font-semibold">{t("waste.form.photo")}</p>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("waste.form.photoHint")}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {previewUrl ? (
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
            accept={WASTE_PHOTO_TYPES.join(",")}
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
            type="button"
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
          >
            <ImagePlus aria-hidden="true" />
            {previewUrl ? t("waste.form.photoChange") : t("waste.form.photoChoose")}
          </Button>
          {previewUrl && (
            <Button type="button" variant="ghost" size="sm" onClick={onClear}>
              <X aria-hidden="true" />
              {t("waste.form.photoRemove")}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
