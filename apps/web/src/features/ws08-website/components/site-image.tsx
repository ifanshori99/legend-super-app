// Photo slot for the brand site. Fixtures carry illustrative image hosts, so a
// missing photo must not render a broken-image icon on the live page: when the
// URL fails (or is null) the slot shows the alt text on a quiet brand surface.
// The alt text is never optional (contract: an image without it fails review).
import { useState } from "react";
import { cn } from "cn";
import { ImageOff } from "lucide-react";
import { useT } from "@/components/i18n";

export function SiteImage({
  src,
  alt,
  className,
  priority = false,
}: {
  src: string | null;
  alt: string;
  /** Sizing and aspect ratio, e.g. "aspect-[4/3]". */
  className?: string;
  /** Above-the-fold hero: load eagerly instead of lazily. */
  priority?: boolean;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const showImage = src !== null && !failed;
  return (
    <div
      data-slot="site-image"
      className={cn(
        "relative overflow-hidden rounded-2xl border-(length:--border-w) bg-brand-subtle",
        className,
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center">
          <ImageOff
            className="size-6 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="text-sm leading-5 font-medium text-foreground">{alt}</p>
          <p className="text-xs text-muted-foreground">
            {t("website.common.photoUnavailable")}
          </p>
        </div>
      )}
    </div>
  );
}
