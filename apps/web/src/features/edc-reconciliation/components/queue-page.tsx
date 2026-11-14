// EDC reconciliation (bead legend-khi8n): the list of flagged EDC sales and,
// for the selected one, the evidence + resolve panel (./detail). The filters
// and the selected sale live in the URL (tx, outletId, status, q) so a link
// reproduces the view. Below md the list gives way to the detail, with a
// button back. Resolving never books a payment; the cashier tender stays the
// only record (explained in the confirm dialog).
import * as React from "react";
import { ArrowLeft, RotateCw } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { API_MOCK } from "@/lib/api/mock-flag";
import type { EdcReconciliationQueueItem } from "@starter/shared/payment/admin";
import { useEdcReconciliationQueue } from "../hooks";
import { EdcReconciliationDetail } from "./detail";
import { EdcReconciliationQueueList } from "./queue-list";

const ALL = "all";
export const QUEUE_STATUS_FILTERS = [
  "unknown",
  "approved",
  "declined",
] as const;
const SEARCH_DEBOUNCE_MS = 300;
const NOW_REFRESH_MS = 30_000;

type QueueSearch = {
  tx?: string;
  outletId?: string;
  status?: (typeof QUEUE_STATUS_FILTERS)[number];
  q?: string;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, 100)
    : undefined;
}

function readSearch(raw: Record<string, unknown>): QueueSearch {
  const status = QUEUE_STATUS_FILTERS.find((s) => s === raw.status);
  return {
    tx: text(raw.tx),
    outletId: text(raw.outletId),
    status,
    q: text(raw.q),
  };
}

function useQueueSearch(): [
  QueueSearch,
  (patch: Partial<Record<keyof QueueSearch, string | undefined>>) => void,
] {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate() as unknown as (options: {
    to: string;
    search: (previous: Record<string, unknown>) => Record<string, unknown>;
    replace: boolean;
  }) => void;
  const update = React.useCallback(
    (patch: Partial<Record<keyof QueueSearch, string | undefined>>) => {
      navigate({
        to: ".",
        replace: true,
        search: (previous) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          for (const key of Object.keys(next))
            if (next[key] === undefined) delete next[key];
          return next;
        },
      });
    },
    [navigate],
  );
  return [readSearch(raw), update];
}

/** Client clock for ages; null on the server render so hydration matches. */
function useNowMs(): number | null {
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, NOW_REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  return now;
}

/** Outlets seen so far, so narrowing to one outlet keeps the others pickable. */
function useKnownOutlets(items: readonly EdcReconciliationQueueItem[]) {
  const [known, setKnown] = React.useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  // Derived while rendering (React docs: storing information from previous
  // renders); only sets state when a new outlet shows up, so it cannot loop.
  let next: Map<string, string> | undefined;
  for (const item of items) {
    if (known.get(item.transaction.outletId) !== item.outletName) {
      next ??= new Map(known);
      next.set(item.transaction.outletId, item.outletName);
    }
  }
  if (next) setKnown(next);
  return next ?? known;
}

export function EdcReconciliationPage() {
  const t = useT();
  const [search, update] = useQueueSearch();
  const nowMs = useNowMs();
  const queue = useEdcReconciliationQueue({
    outletId: search.outletId,
    status: search.status,
    q: search.q,
  });

  const items = React.useMemo(
    () =>
      [...(queue.data?.data ?? [])].sort(
        (a, b) =>
          Date.parse(a.transaction.createdAt) -
          Date.parse(b.transaction.createdAt),
      ),
    [queue.data],
  );
  const outlets = useKnownOutlets(items);
  // A resolve invalidates the queue and the sale drops out of `items`. Keep the
  // last item seen for this tx so the detail (and its success dialog) stays
  // mounted until onResolved clears `tx`.
  const found = items.find((item) => item.transaction.id === search.tx);
  const [lastSelected, setLastSelected] = React.useState(found);
  if (found && found !== lastSelected) setLastSelected(found);
  const kept =
    lastSelected?.transaction.id === search.tx ? lastSelected : undefined;
  const selected = found ?? kept;

  // The search box types freely; the URL (and so the query) follows after a
  // short pause instead of on every keystroke.
  const [draft, setDraft] = React.useState(search.q ?? "");
  // Back/forward changes `q` in the URL: pull the box along, but leave what
  // the visitor is typing alone when the URL only caught up with it.
  const [seenQ, setSeenQ] = React.useState(search.q);
  if (search.q !== seenQ) {
    setSeenQ(search.q);
    if ((draft.trim() === "" ? undefined : draft.trim()) !== search.q)
      setDraft(search.q ?? "");
  }
  React.useEffect(() => {
    const next = draft.trim() === "" ? undefined : draft.trim();
    if (next === search.q) return;
    const timer = window.setTimeout(
      () => update({ q: next }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [draft, search.q, update]);

  // Bring the detail into view when a sale is picked after the page opened.
  const detailRef = React.useRef<HTMLDivElement>(null);
  // After a resolve the detail unmounts; focus the page title so keyboard
  // focus does not fall back to <body>.
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const focusTitleAfterResolve = React.useRef(false);
  const lastTx = React.useRef(search.tx);
  React.useEffect(() => {
    if (search.tx && search.tx !== lastTx.current) {
      detailRef.current?.scrollIntoView({ block: "start" });
      detailRef.current?.focus({ preventScroll: true });
    }
    if (!search.tx && focusTitleAfterResolve.current) {
      focusTitleAfterResolve.current = false;
      titleRef.current?.focus();
    }
    lastTx.current = search.tx;
  }, [search.tx]);

  // A failed refetch keeps the last list on screen (with a banner); only a
  // failure with nothing to show becomes the full error state.
  const staleError = queue.isError && queue.data !== undefined;
  const state = queue.isPending
    ? "loading"
    : queue.isError && !staleError
      ? "error"
      : items.length === 0
        ? "empty"
        : "ready";
  const reload = () => {
    if (!queue.isFetching) void queue.refetch();
  };
  const showDetail = search.tx !== undefined;

  return (
    <section
      aria-labelledby="edc-recon-title"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
    >
      <nav
        aria-label={t("edcRecon.queue.breadcrumbLabel")}
        className="text-sm text-muted-foreground"
      >
        <ol className="flex flex-wrap items-center gap-x-1.5">
          <li>{t("edcRecon.queue.breadcrumbPayments")}</li>
          <li aria-hidden="true">/</li>
          <li>{t("edcRecon.queue.breadcrumbEdc")}</li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">{t("edcRecon.queue.breadcrumbCurrent")}</li>
        </ol>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="type-eyebrow text-muted-foreground">
            {t("edcRecon.queue.eyebrow")}
          </p>
          <h2
            id="edc-recon-title"
            ref={titleRef}
            tabIndex={-1}
            className="type-display outline-none"
          >
            {t("edcRecon.queue.title")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("edcRecon.queue.subtitle")}
          </p>
        </div>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </header>

      <p
        role="note"
        className="rounded-container border-(length:--border-w) bg-info-subtle px-4 py-3 text-sm leading-5 text-info"
      >
        {t("edcRecon.queue.accessBand")}
      </p>

      {/* The list gives way to the detail below md once a sale is picked. */}
      <div className={showDetail ? "hidden md:contents" : "contents"}>
        <div
          role="search"
          aria-label={t("edcRecon.queue.filters.label")}
          className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_minmax(0,12rem)_auto] md:items-end"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="edc-recon-search">
              {t("edcRecon.queue.filters.searchLabel")}
            </Label>
            <Input
              id="edc-recon-search"
              type="search"
              value={draft}
              maxLength={100}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("edcRecon.queue.filters.searchPlaceholder")}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label id="edc-recon-outlet-label" htmlFor="edc-recon-outlet">
              {t("edcRecon.queue.filters.outletLabel")}
            </Label>
            <Select
              value={search.outletId ?? ALL}
              onValueChange={(value) =>
                update({ outletId: value === ALL ? undefined : value })
              }
            >
              <SelectTrigger
                id="edc-recon-outlet"
                aria-labelledby="edc-recon-outlet-label"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("edcRecon.queue.filters.allOutlets")}
                </SelectItem>
                {[...outlets].map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label id="edc-recon-status-label" htmlFor="edc-recon-status">
              {t("edcRecon.queue.filters.statusLabel")}
            </Label>
            <Select
              value={search.status ?? ALL}
              onValueChange={(value) =>
                update({ status: value === ALL ? undefined : value })
              }
            >
              <SelectTrigger
                id="edc-recon-status"
                aria-labelledby="edc-recon-status-label"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t("edcRecon.queue.filters.allStatuses")}
                </SelectItem>
                {QUEUE_STATUS_FILTERS.map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(`edcRecon.queue.status.${status}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={reload}
            aria-busy={queue.isFetching || undefined}
          >
            <RotateCw
              aria-hidden="true"
              className={queue.isFetching ? "animate-spin" : undefined}
            />
            {queue.isFetching
              ? t("edcRecon.queue.filters.reloading")
              : t("edcRecon.queue.filters.reload")}
          </Button>
        </div>

        {staleError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-container border-(length:--border-w) bg-warning-subtle px-4 py-3 text-sm leading-5 text-warning"
          >
            <p className="min-w-0">{t("edcRecon.queue.error.stale")}</p>
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              {t("common.retry")}
            </Button>
          </div>
        )}

        <DataTableShell
          title={t("edcRecon.queue.card.title")}
          description={
            state === "ready" || state === "empty"
              ? t("edcRecon.queue.card.count", { count: items.length })
              : undefined
          }
          state={state}
          rowCount={items.length}
          loadingRows={4}
          error={queue.error}
          onRetry={reload}
          errorCopy={{
            title: t("edcRecon.queue.error.title"),
            description: t("edcRecon.queue.error.hint"),
          }}
          empty={{
            title: t("edcRecon.queue.empty.title"),
            description: t("edcRecon.queue.empty.hint"),
            action: (
              <Button type="button" variant="outline" onClick={reload}>
                {t("edcRecon.queue.empty.reload")}
              </Button>
            ),
          }}
        >
          <EdcReconciliationQueueList
            items={items}
            nowMs={nowMs}
            selectedId={search.tx}
            onSelect={(id) => update({ tx: id })}
          />
          <p className="border-t px-4 py-3 text-sm text-muted-foreground">
            {t("edcRecon.queue.card.ageNote")}
            {API_MOCK ? ` ${t("edcRecon.queue.card.sampleNote")}` : ""}
          </p>
        </DataTableShell>
      </div>

      {showDetail && (
        <div
          ref={detailRef}
          tabIndex={-1}
          className="grid min-w-0 gap-3 outline-none"
        >
          <div className="md:hidden">
            <Button
              type="button"
              variant="outline"
              onClick={() => update({ tx: undefined })}
            >
              <ArrowLeft aria-hidden="true" />
              {t("edcRecon.queue.backToList")}
            </Button>
          </div>
          {selected ? (
            <EdcReconciliationDetail
              key={selected.transaction.id}
              item={selected}
              onResolved={() => {
                focusTitleAfterResolve.current = true;
                update({ tx: undefined });
              }}
            />
          ) : queue.data !== undefined ? (
            <EmptyState
              title={t("edcRecon.queue.detailMissingTitle")}
              description={t("edcRecon.queue.detailMissingHint")}
            />
          ) : (
            // Below md the list is hidden, so a deep link shows the load or
            // failure here; from md up the list beside it already does.
            <div className="md:hidden">
              {queue.isError ? (
                <ErrorState
                  error={queue.error}
                  onRetry={reload}
                  title={t("edcRecon.queue.error.title")}
                  description={t("edcRecon.queue.error.hint")}
                />
              ) : (
                <div className="grid gap-2" aria-busy="true">
                  <span className="sr-only">{t("edcRecon.queue.loading")}</span>
                  <Skeleton className="h-row" />
                  <Skeleton className="h-row" />
                  <Skeleton className="h-row" />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
