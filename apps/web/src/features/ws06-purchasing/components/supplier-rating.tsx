// Manual 1-5 supplier rating. The text label carries the meaning and the icon
// pill only supports it (DESIGN.md §4 StatusPill: never colour alone); the
// contract has no average, so the screen never invents one.
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { ratingLabelKey, ratingTone } from "../supplier-lib";

export function SupplierRating({ rating }: { rating: number | null }) {
  const t = useT();
  if (rating === null)
    return (
      <span className="text-sm leading-5 text-muted-foreground">
        {t("inventorySuppliers.rating.none")}
      </span>
    );
  return (
    <StatusPill status={ratingTone(rating)}>
      {t("inventorySuppliers.rating.value", {
        label: t(ratingLabelKey(rating)),
        rating,
      })}
    </StatusPill>
  );
}

/** Active/inactive master-data state, always in words. */
export function SupplierActiveState({ active }: { active: boolean }) {
  const t = useT();
  if (active)
    return (
      <StatusPill status="success">
        {t("inventorySuppliers.status.active")}
      </StatusPill>
    );
  return (
    <Badge tone="neutral">{t("inventorySuppliers.status.inactive")}</Badge>
  );
}
