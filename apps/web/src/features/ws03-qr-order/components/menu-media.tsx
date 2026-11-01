// Photo of a menu item. The outlet uploads photos to the media library; until
// one exists the tile shows the item's initial instead of a stock picture, so
// nothing on screen pretends to be the dish.
import { cn } from "cn";

export function MenuMedia({
  name,
  photoUrl,
  className,
}: {
  name: string;
  photoUrl: string | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-xl bg-muted",
        className,
      )}
    >
      {photoUrl ? (
        <img
          src={photoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="font-brand text-3xl font-bold text-muted-foreground"
        >
          {name.trim().charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}
