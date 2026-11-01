// 1-5 rating as a radio group of five labelled buttons (arrow keys move and
// select, one tab stop). The chosen value is also written as text, so the
// stars are never the only signal.
import { cn } from "cn";
import { Star } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { useT } from "@/components/i18n";

const STARS = [1, 2, 3, 4, 5] as const;

type StarRatingProps = {
  value: number | null;
  onValueChange: (value: number) => void;
  disabled?: boolean;
  describedBy?: string;
};

export function StarRating({
  value,
  onValueChange,
  disabled,
  describedBy,
}: StarRatingProps) {
  const t = useT();
  return (
    <div className="grid gap-2">
      <RadioGroup.Root
        value={value === null ? "" : String(value)}
        onValueChange={(next) => onValueChange(Number(next))}
        aria-label={t("qrRecovery.review.rating.label")}
        aria-describedby={describedBy}
        orientation="horizontal"
        disabled={disabled}
        className="flex flex-wrap gap-1"
      >
        {STARS.map((star) => (
          <RadioGroup.Item
            key={star}
            value={String(star)}
            aria-label={t("qrRecovery.review.rating.star", { value: star })}
            className="grid size-12 place-items-center rounded-control text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent disabled:opacity-50"
          >
            <Star
              aria-hidden="true"
              className={cn(
                "size-8",
                value !== null && star <= value && "fill-current text-primary",
              )}
            />
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      <p aria-live="polite" className="text-sm font-medium tabular">
        {value === null
          ? t("qrRecovery.review.rating.none")
          : t("qrRecovery.review.rating.chosen", { value })}
      </p>
    </div>
  );
}
