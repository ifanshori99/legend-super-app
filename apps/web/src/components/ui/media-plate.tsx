// Photo-first media plate (DESIGN.md v2 §4 "Media"). Locks the aspect ratio,
// clips to rounded-media, and renders a warm tonal plate with a category
// glyph when there is no photo — never a letter tile. Overlay slots sit on
// the photo: a status badge top-left, one action top-right/bottom-right.
import * as React from "react";
import { cn } from "cn";
import { UtensilsCrossed, type LucideIcon } from "lucide-react";

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
  /** Glyph for the warm placeholder, e.g. the item's category icon. */
  placeholderIcon?: LucideIcon;
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
  placeholderIcon: Icon = UtensilsCrossed,
  muted = false,
  topStart,
  topEnd,
  bottomEnd,
  scrim = false,
  className,
  children,
  ...props
}: MediaPlateProps) {
  return (
    <div
      data-slot="media-plate"
      className={cn(
        "relative isolate overflow-hidden rounded-media bg-primary-tint-strong",
        RATIO[ratio],
        className,
      )}
      {...props}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className={cn(
            "absolute inset-0 size-full object-cover",
            muted && "opacity-55 grayscale",
          )}
        />
      ) : (
        <span
          role={alt ? "img" : undefined}
          aria-label={alt || undefined}
          className="absolute inset-0 grid place-items-center text-primary"
        >
          <Icon className="size-1/4 max-h-14 max-w-14" aria-hidden="true" />
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
