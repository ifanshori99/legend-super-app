// Printable menu (bead legend-b6r; PRD v1.7 §3 F8, §8 "Menu Cetak Otomatis"):
// guest-visible items only (Q23: active with a photo), grouped by category,
// priced from the outlet's dine-in list, with a small photo per item and a
// large-print scale. Prices exclude tax and service charge (tenant default
// `prices_include_tax = false`), and the sheet says so. "Cetak / Simpan PDF" opens
// the browser's print dialog — there is no server PDF. Print CSS copies the
// approach from features/ws06-purchasing/components/purchase-order-print-page.tsx.
import * as React from "react";
import { Printer, RefreshCw } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useOnline } from "@/lib/use-online";
import {
  useAllCategories,
  useAllItems,
  useAllPriceLists,
  usePriceListItems,
} from "../hooks";
import { printableSections } from "../import-lib";
import {
  businessDateToday,
  DEFAULT_OUTLET_TIME_ZONE,
  effectivePriceList,
  formatBusinessDate,
} from "../lib";

type PrintSize = "normal" | "large";

/** Deterministic clock text in the outlet time zone (SSR and hydration match). */
function formatGeneratedAt(instant: Date): string {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: DEFAULT_OUTLET_TIME_ZONE,
  }).format(instant);
}

// Hide the management shell when printing. In dark mode the print swaps to
// dark ink on transparent paper (no accent-filled page background).
const PRINT_STYLE = `@page { margin: 12mm; }
@media print {
  body { background: transparent !important; }
  body * { visibility: hidden; }
  .menu-print-sheet, .menu-print-sheet * { visibility: visible; }
  .menu-print-sheet { position: absolute; inset: 0; width: 100%; max-width: none; margin: 0; padding: 0; }
  .dark .menu-print-sheet { --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground); --border: var(--primary-foreground); --background: transparent; --surface-3: transparent; color: var(--foreground); background: var(--background); }
  .menu-print-sheet .print-controls { display: none; }
}`;

export function MenuPrintPage() {
  const t = useT();
  const online = useOnline();
  const itemsQuery = useAllItems({ limit: 100 });
  const categoriesQuery = useAllCategories({ limit: 100 });
  const priceListsQuery = useAllPriceLists({ limit: 100 });
  const [size, setSize] = React.useState<PrintSize>("normal");
  const [refreshing, setRefreshing] = React.useState(false);

  const priceLists = React.useMemo(
    () => priceListsQuery.data?.data ?? [],
    [priceListsQuery.data],
  );
  const activePriceList = effectivePriceList(
    priceLists,
    "dine_in",
    businessDateToday(),
  );
  const priceItemsQuery = usePriceListItems(activePriceList?.id);

  const sections = React.useMemo(
    () =>
      printableSections({
        items: itemsQuery.data?.data ?? [],
        categories: categoriesQuery.data?.data ?? [],
        priceItems: priceItemsQuery.data?.data ?? [],
      }),
    [itemsQuery.data, categoriesQuery.data, priceItemsQuery.data],
  );

  const loading =
    itemsQuery.isPending ||
    categoriesQuery.isPending ||
    priceListsQuery.isPending ||
    (activePriceList !== undefined && priceItemsQuery.isPending);
  const failed =
    itemsQuery.isError ||
    categoriesQuery.isError ||
    priceListsQuery.isError ||
    (activePriceList !== undefined && priceItemsQuery.isError);

  const generatedAtMs = Math.max(
    itemsQuery.dataUpdatedAt,
    categoriesQuery.dataUpdatedAt,
    priceListsQuery.dataUpdatedAt,
    priceItemsQuery.dataUpdatedAt,
  );
  const generatedAt = generatedAtMs > 0 ? new Date(generatedAtMs) : null;
  const generatedLabel = generatedAt
    ? t("menuImport.print.generatedAt", {
        time: formatGeneratedAt(generatedAt),
      })
    : t("menuImport.print.generatedNever");

  async function regenerate() {
    setRefreshing(true);
    try {
      // A disabled price-items query (no price list yet) must not be forced;
      // refetching it would request `""` and surface a false 404. The results
      // have different shapes, so the list is typed by what we await: they all
      // settle.
      const requests: Promise<unknown>[] = [
        itemsQuery.refetch(),
        categoriesQuery.refetch(),
        priceListsQuery.refetch(),
      ];
      if (activePriceList) requests.push(priceItemsQuery.refetch());
      await Promise.all(requests);
    } finally {
      setRefreshing(false);
    }
  }

  const large = size === "large";
  const ready = !loading && !failed && sections.length > 0;

  return (
    <div className="menu-print-sheet mx-auto grid w-full max-w-4xl gap-6 p-4 sm:p-6 [&_button]:min-h-11">
      <style>{PRINT_STYLE}</style>
      <div className="print-controls grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="type-display">{t("menuImport.print.title")}</h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("menuImport.print.description")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              loading={refreshing}
              disabled={!online}
              onClick={() => void regenerate()}
            >
              <RefreshCw aria-hidden="true" />
              {t("menuImport.print.regenerate")}
            </Button>
            <Button
              type="button"
              disabled={!ready}
              onClick={() => window.print()}
            >
              <Printer aria-hidden="true" />
              {t("menuImport.print.action")}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            value={size}
            onValueChange={(value) => setSize(value)}
            label={t("menuImport.print.sizeLabel")}
            options={[
              { value: "normal", label: t("menuImport.print.sizeNormal") },
              { value: "large", label: t("menuImport.print.sizeLarge") },
            ]}
          />
          <p
            className="text-sm text-muted-foreground tabular"
            aria-live="polite"
          >
            {generatedLabel}
          </p>
        </div>
        {activePriceList && (
          <p className="text-sm text-muted-foreground">
            {t("menuImport.print.priceListContext", {
              channel: t(`menu.prices.channels.${activePriceList.channel}`),
              date: formatBusinessDate(activePriceList.effectiveFrom),
            })}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {t("menuImport.print.actionHint")}
        </p>
        {!online && (
          <p className="text-sm font-medium text-warning" role="status">
            {t("menuImport.print.offline")}
          </p>
        )}
      </div>

      {loading ? (
        <div className="grid gap-3" aria-busy="true">
          <span className="sr-only" role="status">
            {t("menuImport.print.loading")}
          </span>
          <Skeleton className="h-16" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : failed ? (
        <ErrorState
          description={!online ? t("menuImport.print.offline") : undefined}
          onRetry={() => void regenerate()}
        />
      ) : sections.length === 0 ? (
        <EmptyState
          title={t("menuImport.print.emptyTitle")}
          description={t("menuImport.print.emptyHint")}
        />
      ) : (
        <article
          data-print-size={size}
          className={cn(
            "grid gap-8 bg-background text-foreground",
            large && "text-lg",
          )}
        >
          <header className="grid gap-1 border-b pb-4">
            <h2 className={large ? "type-display-xl" : "type-display"}>
              {t("menuImport.print.sheetTitle")}
            </h2>
            <p className="font-medium">{t("app.defaultBrand")}</p>
            {activePriceList && (
              <p className="text-sm text-muted-foreground">
                {t("menuImport.print.priceListContext", {
                  channel: t(`menu.prices.channels.${activePriceList.channel}`),
                  date: formatBusinessDate(activePriceList.effectiveFrom),
                })}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {t("menuImport.print.taxNote")}
            </p>
            <p className="text-sm text-muted-foreground tabular">
              {generatedLabel}
            </p>
          </header>
          {sections.map((section) => (
            <section
              key={section.categoryId}
              className="grid gap-2 break-inside-avoid"
            >
              <h3 className={large ? "type-display" : "type-title"}>
                {section.categoryName}
              </h3>
              <ul className="divide-y border-t">
                {section.rows.map(({ item, priceIdr }) => (
                  <li
                    key={item.id}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-4 py-2"
                  >
                    <MediaPlate
                      src={item.mediaUrl}
                      alt=""
                      ratio="thumb"
                      className={large ? "w-20" : "w-14"}
                    />
                    <div className="min-w-0">
                      <p
                        className={cn(
                          "font-semibold",
                          large && "text-xl leading-7",
                        )}
                      >
                        {item.name}
                      </p>
                      {item.description && (
                        <p
                          className={cn(
                            "text-sm text-muted-foreground",
                            large && "text-base leading-6",
                          )}
                        >
                          {item.description}
                        </p>
                      )}
                    </div>
                    {priceIdr === undefined ? (
                      <span className="text-sm text-muted-foreground">
                        {t("menuImport.print.noPrice")}
                      </span>
                    ) : (
                      <Money amount={priceIdr} size={large ? "lg" : "md"} />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </article>
      )}
    </div>
  );
}
