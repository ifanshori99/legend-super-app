import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useTicketProducts } from "../../ticket/hooks";
import type { TicketProduct } from "../../ticket/types";
import { Notice, PosPanel } from "../shared";
import { TicketError } from "./ticket-error";

// Step 1: the products the server lists. The price shown is the product's
// price as configured; nothing here adds or discounts it.
export function ProductPicker({
  selectedId,
  disabled,
  onSelect,
}: {
  selectedId: string | null;
  disabled?: boolean;
  onSelect: (product: TicketProduct) => void;
}) {
  const t = useT();
  const products = useTicketProducts();
  const list = products.data ?? [];

  return (
    <PosPanel title={t("posKasirTicket.product.title")}>
      {products.isLoading ? (
        <div role="status" aria-busy="true" className="grid gap-3">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : products.isError ? (
        <TicketError
          error={products.error}
          title={t("posKasirTicket.product.errorTitle")}
          onRetry={() => void products.refetch()}
        />
      ) : list.length === 0 ? (
        <Notice tone="info" title={t("posKasirTicket.product.empty")}>
          {t("posKasirTicket.product.emptyHint")}
        </Notice>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((product) => {
            const selected = product.id === selectedId;
            return (
              <li key={product.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  disabled={disabled}
                  onClick={() => onSelect(product)}
                  className={cn(
                    "grid min-h-20 w-full gap-1 rounded-container border-(length:--border-w) p-4 text-left transition-colors focus-visible:shadow-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
                    selected
                      ? "border-primary bg-surface-2"
                      : "border-border bg-card hover:bg-surface-2",
                  )}
                >
                  <span className="text-(length:--density-text) font-semibold">
                    {product.name}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t("posKasirTicket.product.meta", {
                      facility: product.facilityName,
                      sessions: product.sessions,
                    })}
                  </span>
                  <Money amount={product.priceIdr} className="font-bold" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </PosPanel>
  );
}
