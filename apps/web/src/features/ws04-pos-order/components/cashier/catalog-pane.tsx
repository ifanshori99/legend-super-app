import { useMemo, useState } from "react";
import { cn } from "cn";
import { Search } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isContractPending,
  useOrderingConnectivity,
  usePosCatalog,
} from "@/features/ws04-pos-order/hooks";
import type { Catalog, MenuItem } from "@/features/ws04-pos-order/types";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import { MenuItemCard } from "./menu-item-card";

const GRID = "grid grid-cols-2 gap-2 min-[700px]:grid-cols-3 min-[700px]:gap-3";

const TIME = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
});

function formatClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : TIME.format(date);
}

function CatalogSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only" role="status">
        {t("posOrderCatalog.loading")}
      </span>
      <Skeleton className="h-15 w-full rounded-field" />
      <div className="flex gap-2 overflow-hidden">
        {[28, 24, 24, 24].map((w, index) => (
          <Skeleton
            key={index}
            className="h-control shrink-0 rounded-control"
            style={{ width: `${w * 4}px` }}
          />
        ))}
      </div>
      <div className={GRID}>
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-33 rounded-container" />
        ))}
      </div>
    </div>
  );
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("id-ID");
}

// The cashier's menu grid: search (or scan a code + Enter), category tabs and
// the item tiles. Owns its own data so the screen only reacts to onPick.
export function CatalogPane({
  onPick,
  offlineCatalog,
  hasKit = true,
}: {
  onPick: (item: MenuItem) => void;
  /**
   * O4: offline, the menu comes from the tablet's kit (list prices of the
   * chosen service type); the screen's offline banner explains it.
   */
  offlineCatalog?: Catalog | null;
  /**
   * O4: the old "catalog not updated" notice is shown only when the tablet has
   * an offline kit; without one the O4 banner says sales are not possible.
   */
  hasKit?: boolean;
}) {
  const t = useT();
  const catalog = usePosCatalog();
  const connectivity = useOrderingConnectivity();
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const data = offlineCatalog ?? catalog.data;
  const items = useMemo(() => {
    if (!data) return [];
    const needle = normalize(query);
    return data.items.filter(
      (item) =>
        (categoryId === null || item.categoryId === categoryId) &&
        (needle === "" ||
          normalize(item.name).includes(needle) ||
          (item.code !== null && normalize(item.code).includes(needle))),
    );
  }, [data, query, categoryId]);

  if (!offlineCatalog && catalog.isPending) return <CatalogSkeleton />;

  if (!data) {
    const pending = isContractPending(catalog.error);
    return (
      <ErrorState
        title={
          pending
            ? t("posOrderCatalog.error.pendingTitle")
            : t("posOrderCatalog.error.title")
        }
        description={
          pending
            ? t("posOrderCatalog.error.pendingBody")
            : t("posOrderCatalog.error.description")
        }
        onRetry={pending ? undefined : () => void catalog.refetch()}
        error={catalog.error}
      />
    );
  }

  if (data.items.length === 0) {
    return (
      <EmptyState
        title={t("posOrderCatalog.empty.title")}
        description={t("posOrderCatalog.empty.description")}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void catalog.refetch()}
          >
            {t("common.retry")}
          </Button>
        }
      />
    );
  }

  const offline =
    hasKit &&
    !offlineCatalog &&
    (connectivity.mode === "edge_only" || data.source === "cached");
  const since = formatClock(data.updatedAt);

  function scan() {
    const code = normalize(query);
    if (code === "") return;
    const match = data?.items.find(
      (item) => item.code !== null && normalize(item.code) === code,
    );
    if (!match) {
      setScanMessage(
        t("posOrderCatalog.scan.notFound", { code: query.trim() }),
      );
    } else if (match.soldOut) {
      setScanMessage(t("posOrderCatalog.scan.soldOut", { name: match.name }));
    } else {
      onPick(match);
      setQuery("");
      setScanMessage(null);
    }
  }

  return (
    <div className="grid min-w-0 gap-3">
      {catalog.isError && !offlineCatalog && (
        <Notice
          tone="warning"
          title={t("posOrderCatalog.error.refreshFailed")}
        />
      )}
      {offline && (
        <Notice
          tone="warning"
          title={
            since
              ? t("posOrderCatalog.offline.title", { time: since })
              : t("posOrderCatalog.offline.titleUnknown")
          }
        >
          {t("posOrderCatalog.offline.body")}
        </Notice>
      )}

      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          inputMode="search"
          enterKeyHint="search"
          name="menu-search"
          autoComplete="off"
          spellCheck={false}
          aria-label={t("posOrderCatalog.search.label")}
          placeholder={t("posOrderCatalog.search.placeholder")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setScanMessage(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              scan();
            }
          }}
          className="h-15 pl-12 text-lg"
        />
      </div>
      <p
        role="status"
        className="-mt-1 text-base font-semibold text-foreground empty:hidden"
      >
        {scanMessage}
      </p>
      {/* Quiet live region: the filtered count is announced, never shown twice. */}
      <p role="status" aria-live="polite" className="sr-only">
        {query.trim() === "" && categoryId === null
          ? ""
          : items.length === 0
            ? t("posOrderCatalog.noResults.title")
            : t("posOrderCatalog.search.resultCount", { count: items.length })}
      </p>

      <nav
        aria-label={t("posOrderCatalog.categories.label")}
        className="-mb-1 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
      >
        <CategoryButton
          selected={categoryId === null}
          onClick={() => setCategoryId(null)}
        >
          {t("posOrderCatalog.categories.all")}
        </CategoryButton>
        {data.categories.map((category) => (
          <CategoryButton
            key={category.id}
            selected={categoryId === category.id}
            onClick={() => setCategoryId(category.id)}
          >
            {category.name}
          </CategoryButton>
        ))}
      </nav>
      <p className="-mt-1 text-sm text-muted-foreground min-[700px]:hidden">
        {t("posOrderCatalog.categories.scrollHint")}
      </p>

      {items.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("posOrderCatalog.noResults.title")}
          description={t("posOrderCatalog.noResults.description")}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setCategoryId(null);
              }}
            >
              {t("posOrderCatalog.noResults.clear")}
            </Button>
          }
        />
      ) : (
        <div className={GRID}>
          {items.map((item) => (
            <MenuItemCard key={item.id} item={item} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "shrink-0 font-bold",
        selected && "border-foreground bg-secondary hover:bg-secondary",
      )}
    >
      {children}
    </Button>
  );
}
