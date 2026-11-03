// Tenant logo picker (PRD v1.7 §3 F4 "Whitelabel": logo). The file goes to the
// media upload endpoint as-is (PNG keeps its transparency), within the 600 KB
// request limit the media contract sets; the API answers a media id.
import * as React from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { MENU_IMAGE_MAX_BYTES } from "@starter/shared/menu";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { settingsErrorMessage } from "../errors";
import { useUploadLogo } from "../hooks";

const ACCEPTED = ["image/png", "image/jpeg", "image/webp"] as const;
type Accepted = (typeof ACCEPTED)[number];

function isAccepted(type: string): type is Accepted {
  return (ACCEPTED as readonly string[]).includes(type);
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const text = String(reader.result);
      resolve(text.slice(text.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export type LogoValue = { mediaId: string; url: string | null };

export function LogoField({
  value,
  onChange,
}: {
  value: LogoValue | null;
  onChange: (value: LogoValue | null) => void;
}) {
  const t = useT();
  const upload = useUploadLogo();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [error, setError] = React.useState<string | undefined>();

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(undefined);
    if (!isAccepted(file.type)) {
      setError(t("tenantSettings.theme.logoWrongType"));
      return;
    }
    if (file.size > MENU_IMAGE_MAX_BYTES) {
      setError(t("tenantSettings.theme.logoTooLarge"));
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      const result = await upload.mutateAsync({
        fileName: file.name.slice(0, 120),
        contentType: file.type,
        dataBase64: await readBase64(file),
        width,
        height,
      });
      onChange({ mediaId: result.mediaId, url: result.mediaUrl });
    } catch (failure) {
      setError(settingsErrorMessage(failure, t));
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-container border-(length:--border-w) bg-surface-2">
          {value?.url ? (
            <img
              src={value.url}
              alt={t("tenantSettings.theme.logoAlt")}
              className="size-full object-contain"
            />
          ) : (
            <ImagePlus
              className="size-6 text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </div>
        <div className="grid gap-1.5">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={upload.isPending}
              onClick={() => inputRef.current?.click()}
            >
              {value
                ? t("tenantSettings.theme.logoChange")
                : t("tenantSettings.theme.logoChoose")}
            </Button>
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(null)}
              >
                <Trash2 aria-hidden="true" />
                {t("tenantSettings.theme.logoRemove")}
              </Button>
            )}
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {value && !value.url
              ? t("tenantSettings.theme.logoSet")
              : t("tenantSettings.theme.logoHint")}
          </p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-label={t("tenantSettings.theme.logoChoose")}
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {error && (
        <p className="text-sm leading-5 font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
