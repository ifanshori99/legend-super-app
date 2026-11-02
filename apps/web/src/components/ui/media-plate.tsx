// Photo-first media plate (DESIGN.md v2 §4 "Media"). Every menu item has a
// photo (owner Q23; publishing without one is refused by the menu contract),
// so there is no decorative placeholder and never a letter tile. The plate
// locks the aspect ratio, clips to rounded-media, and shows a skeleton until
// the image has loaded. When a photo is missing anyway:
//   missing="required"  back office: a dashed "Foto wajib" state to fix it
//   missing="quiet"     customer: a neutral plate, no label (default)
// Overlay slots sit on the photo: a status badge top-left, one action
// top-right or bottom-right.
import * as React from "react";
import { cn } from "cn";
import { ImageOff, ImagePlus } from "lucide-react";
import { useT } from "@/components/i18n";

type Ratio = "card" | "hero" | "thumb";
const RATIO: Record<Ratio, string> = {
  card: "aspect-card",
  hero: "aspect-hero",
  thumb: "aspect-thumb",
};

type MediaPlateProps = Omit<React.ComponentProps<"div">, "children"> & {
  src?: string | null;
  /** Describes the photo; empty string when the name is printed next to it. */
  alt: string;
  ratio?: Ratio;
  /** What a missing photo looks like (see the file comment). */
  missing?: "quiet" | "required";
  /** Greys the photo for unavailable items (always pair with a badge). */
  muted?: boolean;
  topStart?: React.ReactNode;
  topEnd?: React.ReactNode;
  bottomEnd?: React.ReactNode;
  /** Dark scrim at the bottom for text placed on the photo. */
  scrim?: boolean;
  children?: React.ReactNode;
};

function MediaPlate({
  src,
  alt,
  ratio = "card",
  missing = "quiet",
  muted = false,
  topStart,
  topEnd,
  bottomEnd,
  scrim = false,
  className,
  children,
  ...props
}: MediaPlateProps) {
  const t = useT();
  const [loaded, setLoaded] = React.useState(false);
  const imgRef = React.useRef<HTMLImageElement>(null);
  // A cached image can finish before hydration attaches onLoad.
  React.useEffect(() => {
    setLoaded(Boolean(imgRef.current?.complete));
  }, [src]);
  const required = !src && missing === "required";
  return (
    <div
      data-slot="media-plate"
      data-missing={src ? undefined : missing}
      className={cn(
        "relative isolate overflow-hidden rounded-media bg-surface-3",
        required &&
          "border-(length:--border-w) border-dashed border-input bg-surface-2",
        RATIO[ratio],
        className,
      )}
      {...props}
    >
      {src ? (
        <>
          {!loaded && (
            <span
              aria-hidden="true"
              className="absolute inset-0 animate-pulse bg-surface-3"
            />
          )}
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            className={cn(
              "absolute inset-0 size-full object-cover transition-opacity duration-(--duration-base)",
              loaded ? "opacity-100" : "opacity-0",
              muted && loaded && "opacity-55 grayscale",
            )}
          />
        </>
      ) : required ? (
        <span className="absolute inset-0 grid place-content-center justify-items-center gap-1.5 p-3 text-center">
          <ImagePlus
            className="size-6 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="text-sm leading-5 font-semibold text-foreground">
            {t("media.photoRequired")}
          </span>
        </span>
      ) : (
        <span
          role="img"
          aria-label={alt || t("media.photoMissing")}
          className="absolute inset-0 grid place-items-center text-muted-foreground"
        >
          <ImageOff className="size-6" aria-hidden="true" />
        </span>
      )}
      {scrim && (
        <span
          aria-hidden="true"
          className="absolute inset-0 bg-(image:--scrim-media)"
        />
      )}
      {topStart && <div className="absolute start-2.5 top-2.5">{topStart}</div>}
      {topEnd && <div className="absolute end-2.5 top-2.5">{topEnd}</div>}
      {bottomEnd && (
        <div className="absolute end-2.5 bottom-2.5">{bottomEnd}</div>
      )}
      {children}
    </div>
  );
}

export { MediaPlate, type MediaPlateProps };
