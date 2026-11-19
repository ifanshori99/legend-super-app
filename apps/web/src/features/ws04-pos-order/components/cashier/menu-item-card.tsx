import { cn } from "cn";
import { Plus } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import type { MenuItem } from "@/features/ws04-pos-order/types";

const CARD =
  "flex min-h-33 min-w-0 flex-col justify-between gap-3 rounded-container border-(length:--border-w) border-border p-3 text-left sm:p-3.5";

function Thumb({ src }: { src: string | null }) {
  return src ? (
    <img
      src={src}
      alt=""
      width={42}
      height={42}
      loading="lazy"
      className="size-[42px] shrink-0 rounded-md object-cover min-[700px]:size-14"
    />
  ) : (
    <span
      aria-hidden="true"
      className="size-[42px] shrink-0 rounded-md bg-shell min-[700px]:size-14"
    />
  );
}

// One menu tile. Available items are one big button (the whole tile is the
// target); a sold-out item is plain content with a visible "Stok habis" badge,
// so there is no dead control to tap.
export function MenuItemCard({
  item,
  onPick,
}: {
  item: MenuItem;
  onPick: (item: MenuItem) => void;
}) {
  const t = useT();
  const top = (
    <span className="flex items-start gap-2.5">
      <Thumb src={item.imageUrl} />
      <span className="min-w-0">
        <span className="block text-base leading-snug font-bold [overflow-wrap:anywhere] min-[700px]:text-[17px]">
          {item.name}
        </span>
        <span className="block text-sm text-muted-foreground">
          {item.categoryName}
        </span>
      </span>
    </span>
  );

  if (item.soldOut) {
    return (
      <div className={cn(CARD, "bg-muted text-muted-foreground")}>
        {top}
        <span className="flex flex-wrap items-center justify-between gap-2">
          <Money amount={item.priceIdr} className="font-bold" />
          <Badge tone="neutral">{t("posOrderCatalog.card.soldOut")}</Badge>
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label={t("posOrderCatalog.card.add", {
        name: item.name,
        price: formatRupiah(item.priceIdr),
      })}
      onClick={() => onPick(item)}
      className={cn(
        CARD,
        // Hover only darkens the border: a grey fill means "Stok habis" here.
        "pressable bg-card shadow-hairline transition-colors hover:border-foreground focus-visible:shadow-focus focus-visible:outline-none",
      )}
    >
      {top}
      <span className="flex items-center justify-between gap-2">
        <Money amount={item.priceIdr} className="font-bold" />
        <Plus className="size-6" aria-hidden="true" />
      </span>
    </button>
  );
}
