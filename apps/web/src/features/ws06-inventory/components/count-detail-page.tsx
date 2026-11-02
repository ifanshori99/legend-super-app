// One stock-count session (PRD §16 "Stok Opname", Alur J, INV-03): the blind
// count on a phone, the variance review in rupiah, approval by a different
// person, then posting the adjustment. The contract owns the state machine;
// this screen only offers the actions it allows (opname-lib.ts).
import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  CircleCheck,
  ClipboardList,
  EyeOff,
  Info,
  Search,
  TriangleAlert,
} from "lucide-react";
import type {
  StockCountAction,
  StockCountLine,
} from "@starter/shared/inventory";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useInventoryItems, useStockLocations, useUnits } from "../hooks";
import {
  useCountTransition,
  useSaveCountLine,
  useStockCount,
} from "../opname-hooks";
import { formatQuantity, LIST_LIMIT } from "../lib";
import { formatBusinessDate, formatDateTime, shortId } from "../stock-lib";
import {
  allowedCountActions,
  canApproveCount,
  countProgress,
  hidesSystemQty,
  lineDelta,
  varianceLineCount,
  varianceTotalIdr,
  typeLabelKey,
} from "../opname-lib";
import { CountStatusBadge } from "./count-status";

type DialogAction = "start" | "approve" | "reject" | "post" | "cancel";

const DIALOG_ACTION: Record<
  DialogAction,
  {
    title: MessageKey;
    description: MessageKey;
    confirm: MessageKey;
    destructive?: boolean;
  }
> = {
  start: {
    title: "opname.detail.dialogs.start.title",
    description: "opname.detail.dialogs.start.description",
    confirm: "opname.detail.dialogs.start.confirm",
  },
  approve: {
    title: "opname.detail.dialogs.approve.title",
    description: "opname.detail.dialogs.approve.description",
    confirm: "opname.detail.dialogs.approve.confirm",
  },
  reject: {
    title: "opname.detail.dialogs.reject.title",
    description: "opname.detail.dialogs.reject.description",
    confirm: "opname.detail.dialogs.reject.confirm",
  },
  post: {
    title: "opname.detail.dialogs.post.title",
    description: "opname.detail.dialogs.post.description",
    confirm: "opname.detail.dialogs.post.confirm",
  },
  cancel: {
    title: "opname.detail.dialogs.cancel.title",
    description: "opname.detail.dialogs.cancel.description",
    confirm: "opname.detail.dialogs.cancel.confirm",
    destructive: true,
  },
};

const TOAST_KEY: Record<StockCountAction, MessageKey> = {
  start: "opname.detail.toasts.started",
  submit: "opname.detail.toasts.submitted",
  approve: "opname.detail.toasts.approved",
  reject: "opname.detail.toasts.rejected",
  post: "opname.detail.toasts.posted",
  cancel: "opname.detail.toasts.cancelled",
};

const NOTICE_KEY: Record<
  | "draft"
  | "counting"
  | "pending_approval"
  | "approved"
  | "posted"
  | "cancelled",
  MessageKey
> = {
  draft: "opname.detail.notice.draft",
  counting: "opname.detail.notice.counting",
  pending_approval: "opname.detail.notice.pending",
  approved: "opname.detail.notice.approved",
  posted: "opname.detail.notice.posted",
  cancelled: "opname.detail.notice.cancelled",
};

const NOTICE_TONE: Record<
  | "draft"
  | "counting"
  | "pending_approval"
  | "approved"
  | "posted"
  | "cancelled",
  "info" | "warning" | "success" | "neutral"
> = {
  draft: "neutral",
  counting: "info",
  pending_approval: "warning",
  approved: "info",
  posted: "success",
  cancelled: "neutral",
};

const QTY_PATTERN = /^\d{1,10}(\.\d{1,4})?$/;

function normalizeQty(value: string): string {
  return value.trim().replace(",", ".");
}

function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="min-w-0 truncate text-sm">{children}</dd>
    </div>
  );
}

function Progress({ counted, total }: { counted: number; total: number }) {
  const t = useT();
  const percent = total === 0 ? 0 : Math.round((counted / total) * 100);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">
          {t("opname.detail.progressTitle")}
        </p>
        <p className="text-sm tabular text-muted-foreground">
          {t("opname.detail.progress", { counted, total })}
        </p>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={counted}
        aria-label={t("opname.detail.progressTitle")}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-(--duration-slow)"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function CountLineRow({
  line,
  name,
  unit,
  showSystem,
  canCount,
  value,
  saving,
  saveError,
  onChange,
  onCommit,
}: {
  line: StockCountLine;
  name: string;
  unit: string;
  showSystem: boolean;
  canCount: boolean;
  value: string;
  saving: boolean;
  saveError: string | undefined;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  const t = useT();
  const inputId = React.useId();
  const delta = lineDelta(line);
  return (
    <li className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-center">
      <div className="grid min-w-0 gap-1">
        <p className="truncate text-(length:--density-text) font-medium">
          {name}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{t("opname.detail.line.unit", { unit })}</span>
          {showSystem && (
            <span>
              {t("opname.detail.line.system")}:{" "}
              <span className="tabular">{formatQuantity(line.systemQty)}</span>
            </span>
          )}
          {showSystem && delta !== null && (
            <span>
              {t("opname.detail.line.difference")}:{" "}
              <span className="tabular">{delta}</span>
            </span>
          )}
        </div>
      </div>
      <div className="grid gap-1">
        {canCount ? (
          <>
            <label
              htmlFor={inputId}
              className="text-xs font-medium text-muted-foreground"
            >
              {t("opname.detail.line.counted")}
            </label>
            <Input
              id={inputId}
              inputMode="decimal"
              autoComplete="off"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onBlur={onCommit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              aria-invalid={saveError ? true : undefined}
              aria-label={t("opname.detail.line.countLabel", { name })}
              className="h-control-sm text-right tabular"
            />
          </>
        ) : (
          <span className="text-sm tabular sm:text-right">
            {line.countedQty === null
              ? t("opname.detail.line.notCounted")
              : formatQuantity(line.countedQty)}
          </span>
        )}
        {saveError ? (
          <p role="alert" className="text-xs font-medium text-danger">
            {saveError}
          </p>
        ) : saving ? (
          <p className="text-xs text-muted-foreground">
            {t("opname.detail.actions.saving")}
          </p>
        ) : line.countedQty !== null ? (
          <p className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
            <Check className="size-3.5 text-success" aria-hidden="true" />
            {t("opname.detail.line.saved")}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function VarianceList({
  lines,
  nameOf,
  unitOf,
}: {
  lines: readonly StockCountLine[];
  nameOf: (line: StockCountLine) => string;
  unitOf: (line: StockCountLine) => string;
}) {
  const t = useT();
  return (
    <div>
      <div className="hidden grid-cols-[minmax(0,1fr)_repeat(3,6rem)_8rem] gap-2 border-b px-4 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase sm:grid">
        <span>{t("opname.detail.line.item")}</span>
        <span className="text-right">{t("opname.detail.line.system")}</span>
        <span className="text-right">{t("opname.detail.line.counted")}</span>
        <span className="text-right">{t("opname.detail.line.difference")}</span>
        <span className="text-right">{t("opname.detail.line.value")}</span>
      </div>
      <ul className="divide-y">
        {lines.map((line) => {
          const variance = line.varianceIdr;
          const delta = lineDelta(line);
          return (
            <li
              key={line.id}
              className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_repeat(3,6rem)_8rem] sm:items-center"
            >
              <div className="min-w-0">
                <p className="truncate text-(length:--density-text) font-medium">
                  {nameOf(line)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("opname.detail.line.unit", { unit: unitOf(line) })}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-x-4 text-sm sm:contents">
                <div className="sm:text-right">
                  <span className="text-xs text-muted-foreground sm:hidden">
                    {t("opname.detail.line.system")}{" "}
                  </span>
                  <span className="tabular">
                    {formatQuantity(line.systemQty)}
                  </span>
                </div>
                <div className="sm:text-right">
                  <span className="text-xs text-muted-foreground sm:hidden">
                    {t("opname.detail.line.counted")}{" "}
                  </span>
                  <span className="tabular">
                    {line.countedQty === null
                      ? "—"
                      : formatQuantity(line.countedQty)}
                  </span>
                </div>
                <div className="sm:text-right">
                  <span className="text-xs text-muted-foreground sm:hidden">
                    {t("opname.detail.line.difference")}{" "}
                  </span>
                  <span className="tabular">{delta ?? "—"}</span>
                </div>
              </div>
              <div className="flex items-baseline justify-between text-sm sm:block sm:text-right">
                <span className="text-xs text-muted-foreground sm:hidden">
                  {t("opname.detail.line.value")}
                </span>
                {variance === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <Money amount={variance} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CountDetailPage({
  stockCountId,
  canCount,
  canApprove,
  actorId,
}: {
  stockCountId: string;
  canCount: boolean;
  canApprove: boolean;
  actorId: string | undefined;
}) {
  const t = useT();
  const toast = useToast();
  const detailQuery = useStockCount(stockCountId);
  const itemsQuery = useInventoryItems({ limit: LIST_LIMIT });
  const unitsQuery = useUnits({ limit: LIST_LIMIT });
  const locationsQuery = useStockLocations();
  const saveLine = useSaveCountLine();
  const transition = useCountTransition();

  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [lineErrors, setLineErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [search, setSearch] = React.useState("");
  const [dialog, setDialog] = React.useState<DialogAction | null>(null);
  const [actionError, setActionError] = React.useState<string>();
  const idempotencyKey = React.useRef(crypto.randomUUID());

  const itemById = React.useMemo(() => {
    const map = new Map<string, { name: string; unit: string }>();
    const unitCode = new Map<string, string>();
    for (const unit of unitsQuery.data?.data ?? [])
      unitCode.set(unit.id, unit.code);
    for (const item of itemsQuery.data?.data ?? [])
      map.set(item.id, {
        name: item.name,
        unit: unitCode.get(item.baseUomId) ?? "",
      });
    return map;
  }, [itemsQuery.data, unitsQuery.data]);

  const locationName = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const location of locationsQuery.data?.data ?? [])
      map.set(location.id, location.name);
    return map;
  }, [locationsQuery.data]);

  const detail = detailQuery.data;
  const lines = React.useMemo(() => detail?.lines ?? [], [detail]);
  const count = detail?.count;
  const progress = countProgress(lines);
  const showSystem = count ? !hidesSystemQty(count, canApprove) : false;
  const nameOf = (line: StockCountLine) =>
    itemById.get(line.inventoryItemId)?.name ??
    line.inventoryItemId.slice(0, 8);
  const unitOf = (line: StockCountLine) =>
    itemById.get(line.inventoryItemId)?.unit ?? "";

  const filteredLines = React.useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("id-ID");
    if (needle === "") return lines;
    return lines.filter((line) => {
      const name =
        itemById.get(line.inventoryItemId)?.name ??
        line.inventoryItemId.slice(0, 8);
      return name.toLocaleLowerCase("id-ID").includes(needle);
    });
  }, [lines, search, itemById]);

  const actions = count
    ? allowedCountActions(count, lines, actorId, { canCount, canApprove })
    : [];

  function openDialog(action: DialogAction) {
    idempotencyKey.current = crypto.randomUUID();
    setActionError(undefined);
    setDialog(action);
  }

  function runTransition(
    action: StockCountAction,
    options?: { closeDialog?: boolean },
  ) {
    setActionError(undefined);
    transition.mutate(
      {
        stockCountId,
        action,
        idempotencyKey: idempotencyKey.current,
      },
      {
        onSuccess: () => {
          toast({ title: t(TOAST_KEY[action]), tone: "success" });
          if (options?.closeDialog) setDialog(null);
        },
        onError: (error) =>
          setActionError(
            error instanceof ApiError
              ? error.message
              : t("opname.create.errorSubmit"),
          ),
      },
    );
  }

  function commitLine(line: StockCountLine) {
    const raw = drafts[line.id];
    if (raw === undefined) return;
    const normalized = normalizeQty(raw);
    if (normalized === "") {
      if (line.countedQty !== null)
        setLineErrors((current) => ({
          ...current,
          [line.id]: t("opname.detail.line.saveError"),
        }));
      return;
    }
    if (!QTY_PATTERN.test(normalized)) {
      setLineErrors((current) => ({
        ...current,
        [line.id]: t("opname.detail.line.saveError"),
      }));
      return;
    }
    if (normalized === line.countedQty) {
      setLineErrors((current) => {
        const next = { ...current };
        delete next[line.id];
        return next;
      });
      return;
    }
    setLineErrors((current) => {
      const next = { ...current };
      delete next[line.id];
      return next;
    });
    saveLine.mutate(
      { stockCountId, lineId: line.id, countedQty: normalized },
      {
        onError: () =>
          setLineErrors((current) => ({
            ...current,
            [line.id]: t("opname.detail.line.saveError"),
          })),
      },
    );
  }

  /**
   * Saves every input that differs from the server before submitting, so a
   * value typed and not blurred is never lost. Returns false when a row is
   * empty or malformed.
   */
  async function flushLines(): Promise<boolean> {
    const pending = lines
      .map((line) => {
        const raw = drafts[line.id];
        if (raw === undefined) return null;
        const normalized = normalizeQty(raw);
        if (normalized === (line.countedQty ?? "")) return null;
        return { line, normalized };
      })
      .filter(
        (entry): entry is { line: StockCountLine; normalized: string } =>
          entry !== null,
      );
    for (const entry of pending) {
      if (!QTY_PATTERN.test(entry.normalized)) {
        setLineErrors((current) => ({
          ...current,
          [entry.line.id]: t("opname.detail.line.saveError"),
        }));
        return false;
      }
    }
    for (const entry of pending) {
      await saveLine.mutateAsync({
        stockCountId,
        lineId: entry.line.id,
        countedQty: entry.normalized,
      });
    }
    return true;
  }

  async function submitCount() {
    if (!count) return;
    setActionError(undefined);
    const filled = lines.every((line) => {
      const raw = drafts[line.id];
      const normalized =
        raw === undefined ? (line.countedQty ?? "") : normalizeQty(raw);
      return QTY_PATTERN.test(normalized);
    });
    if (!filled) {
      setActionError(t("opname.detail.actions.submitBlocked"));
      return;
    }
    try {
      const flushed = await flushLines();
      if (!flushed) return;
      // Every user intent gets its own key: reusing the start key would make
      // the API (and the mock) replay the earlier transition idempotently.
      idempotencyKey.current = crypto.randomUUID();
      runTransition("submit");
    } catch {
      setActionError(t("opname.detail.line.saveError"));
    }
  }

  if (detailQuery.isPending) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (detailQuery.isError) {
    const notFound =
      detailQuery.error instanceof ApiError && detailQuery.error.status === 404;
    if (notFound) {
      return (
        <EmptyState
          icon={ClipboardList}
          title={t("opname.detail.notFoundTitle")}
          description={t("opname.detail.notFoundHint")}
          action={
            <Button asChild variant="outline">
              <Link to="/kelola/inventori/opname">
                <ArrowLeft aria-hidden="true" />
                {t("opname.detail.back")}
              </Link>
            </Button>
          }
        />
      );
    }
    return (
      <ErrorState
        onRetry={() => {
          void detailQuery.refetch();
        }}
      />
    );
  }

  if (!count) return null;

  const counting = count.status === "counting";
  const reviewable =
    ["pending_approval", "approved", "posted"].includes(count.status) &&
    !hidesSystemQty(count, canApprove);
  const totalVariance = varianceTotalIdr(lines);
  const differingLines = varianceLineCount(lines);
  const noticeTone = NOTICE_TONE[count.status];
  const NoticeIcon =
    noticeTone === "success"
      ? CircleCheck
      : noticeTone === "warning"
        ? TriangleAlert
        : Info;
  const primaryAction = actions.find((action) =>
    ["start", "submit", "approve", "post"].includes(action),
  );
  const secondaryActions = actions.filter((action) =>
    ["reject", "cancel"].includes(action),
  );
  const dialogConfig = dialog ? DIALOG_ACTION[dialog] : null;

  return (
    <div className="grid min-w-0 gap-4">
      <div>
        <Link
          to="/kelola/inventori/opname"
          className="inline-flex min-h-control-sm items-center gap-1.5 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("opname.detail.back")}
        </Link>
      </div>

      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg leading-7 font-semibold">
            {t(typeLabelKey(count.type))} ·{" "}
            {locationName.get(count.locationId) ?? ""}
          </h2>
          <CountStatusBadge status={count.status} />
          {count.blind && (
            <Badge tone="neutral">
              <EyeOff aria-hidden="true" />
              {t("opname.list.blind")}
            </Badge>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border p-4 lg:grid-cols-4">
          <MetaItem label={t("opname.detail.meta.location")}>
            {locationName.get(count.locationId) ?? "—"}
          </MetaItem>
          <MetaItem label={t("opname.detail.meta.businessDate")}>
            <span className="tabular">
              {formatBusinessDate(count.businessDate)}
            </span>
          </MetaItem>
          <MetaItem label={t("opname.detail.meta.counter")}>
            <span className="tabular" title={count.countedBy}>
              {shortId(count.countedBy)}
            </span>
          </MetaItem>
          <MetaItem label={t("opname.detail.meta.approver")}>
            {count.approvedBy ? (
              <span className="tabular" title={count.approvedBy}>
                {shortId(count.approvedBy)}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {t("opname.detail.meta.notApproved")}
              </span>
            )}
          </MetaItem>
          {count.countedAt && (
            <MetaItem label={t("opname.detail.meta.countedAt")}>
              <span className="tabular">{formatDateTime(count.countedAt)}</span>
            </MetaItem>
          )}
          {count.approvedAt && (
            <MetaItem label={t("opname.detail.meta.approvedAt")}>
              <span className="tabular">
                {formatDateTime(count.approvedAt)}
              </span>
            </MetaItem>
          )}
        </dl>
        {count.note && (
          <p className="text-sm text-muted-foreground">{count.note}</p>
        )}
      </header>

      <div
        className={
          noticeTone === "warning"
            ? "flex gap-2 rounded-xl bg-warning-subtle p-3 text-sm text-warning"
            : noticeTone === "success"
              ? "flex gap-2 rounded-xl bg-success-subtle p-3 text-sm text-success"
              : noticeTone === "info"
                ? "flex gap-2 rounded-xl bg-info-subtle p-3 text-sm text-info"
                : "flex gap-2 rounded-xl bg-muted p-3 text-sm text-foreground"
        }
        role="status"
      >
        <NoticeIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="grid gap-0.5">
          <p className="font-medium">{t(NOTICE_KEY[count.status])}</p>
          {count.blind && hidesSystemQty(count, canApprove) && (
            <>
              <p className="font-medium">{t("opname.detail.blindNotice")}</p>
              <p>{t("opname.detail.blindNoticeHint")}</p>
            </>
          )}
          {count.status === "pending_approval" &&
            (canApprove ? (
              !canApproveCount(count, actorId) && (
                <p>{t("opname.detail.actions.selfApproval")}</p>
              )
            ) : (
              <p>{t("opname.detail.actions.waitingApproval")}</p>
            ))}
        </div>
      </div>

      {(counting || count.status === "draft") && (
        <Progress counted={progress.counted} total={progress.total} />
      )}

      {reviewable && (
        <section className="grid gap-3 rounded-xl border">
          <header className="grid gap-1 border-b p-4">
            <h3 className="text-base leading-6 font-semibold">
              {t("opname.detail.summary.title")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("opname.detail.summary.description")}
            </p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-sm text-muted-foreground">
                {t("opname.detail.summary.total")}
              </span>
              <Money amount={totalVariance} size="lg" />
              <span className="text-sm tabular text-muted-foreground">
                {differingLines === 0
                  ? t("opname.detail.summary.noVariance")
                  : t("opname.detail.summary.lines", {
                      count: differingLines,
                    })}
              </span>
            </div>
          </header>
          <VarianceList lines={lines} nameOf={nameOf} unitOf={unitOf} />
          <div className="border-t p-4">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("opname.detail.summary.note")}
            </p>
            <p className="text-sm">
              {count.note ?? t("opname.detail.summary.noNote")}
            </p>
          </div>
        </section>
      )}

      {(counting || count.status === "draft") && (
        <section className="grid gap-3">
          <div className="grid gap-1">
            <h3 className="text-base leading-6 font-semibold">
              {t("opname.detail.linesTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("opname.detail.linesDescription")}
            </p>
          </div>
          <div className="relative sm:max-w-sm">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-icon -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("opname.detail.searchPlaceholder")}
              aria-label={t("opname.detail.searchPlaceholder")}
              className="h-control-sm pl-10"
            />
          </div>
          <ul className="divide-y rounded-xl border">
            {filteredLines.map((line) => (
              <CountLineRow
                key={line.id}
                line={line}
                name={nameOf(line)}
                unit={unitOf(line)}
                showSystem={showSystem}
                canCount={canCount && counting}
                value={
                  drafts[line.id] ??
                  (line.countedQty === null
                    ? ""
                    : formatQuantity(line.countedQty))
                }
                saving={
                  saveLine.isPending && saveLine.variables?.lineId === line.id
                }
                saveError={lineErrors[line.id]}
                onChange={(value) => {
                  setDrafts((current) => ({ ...current, [line.id]: value }));
                  setLineErrors((current) => {
                    if (!(line.id in current)) return current;
                    const next = { ...current };
                    delete next[line.id];
                    return next;
                  });
                }}
                onCommit={() => commitLine(line)}
              />
            ))}
          </ul>
          {filteredLines.length === 0 && (
            <EmptyState
              title={t("opname.detail.noResults")}
              description={t("opname.detail.noResultsHint")}
            />
          )}
        </section>
      )}

      <div
        data-slot="count-action-bar"
        className="sticky bottom-0 z-10 -mx-4 grid gap-2 border-t bg-background px-4 py-3 sm:static sm:mx-0 sm:flex sm:items-center sm:justify-between sm:rounded-xl sm:border sm:px-4"
      >
        <div className="grid gap-0.5 text-sm text-muted-foreground">
          {count.status === "pending_approval" && !canApprove && (
            <span>{t("opname.detail.actions.waitingApproval")}</span>
          )}
          {counting && !progress.complete && canCount && (
            <span>{t("opname.detail.actions.submitBlocked")}</span>
          )}
          {actionError && (
            <span role="alert" className="font-medium text-danger">
              {actionError}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {secondaryActions.includes("reject") && (
            <Button
              variant="outline"
              onClick={() => openDialog("reject")}
              disabled={transition.isPending}
            >
              {t("opname.detail.actions.reject")}
            </Button>
          )}
          {secondaryActions.includes("cancel") && (
            <Button
              variant="ghost"
              className="text-danger"
              onClick={() => openDialog("cancel")}
              disabled={transition.isPending}
            >
              {t("opname.detail.actions.cancel")}
            </Button>
          )}
          {primaryAction === "start" && (
            <Button onClick={() => openDialog("start")}>
              {t("opname.detail.actions.start")}
            </Button>
          )}
          {primaryAction === "submit" && (
            <Button
              onClick={() => void submitCount()}
              loading={transition.isPending || saveLine.isPending}
            >
              {t("opname.detail.actions.submit")}
            </Button>
          )}
          {primaryAction === "approve" && (
            <Button onClick={() => openDialog("approve")}>
              {t("opname.detail.actions.approve")}
            </Button>
          )}
          {primaryAction === "post" && (
            <Button onClick={() => openDialog("post")}>
              {t("opname.detail.actions.post")}
            </Button>
          )}
          {!primaryAction && counting && canCount && !progress.complete && (
            <Button disabled>{t("opname.detail.actions.submit")}</Button>
          )}
        </div>
      </div>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setActionError(undefined);
          }
        }}
      >
        <DialogContent>
          {dialogConfig && (
            <>
              <DialogHeader>
                <DialogTitle>{t(dialogConfig.title)}</DialogTitle>
                <DialogDescription>
                  {t(dialogConfig.description)}
                </DialogDescription>
              </DialogHeader>
              {actionError && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {actionError}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDialog(null)}
                  disabled={transition.isPending}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  variant={dialogConfig.destructive ? "destructive" : "default"}
                  loading={transition.isPending}
                  onClick={() => {
                    if (dialog) runTransition(dialog, { closeDialog: true });
                  }}
                >
                  {t(dialogConfig.confirm)}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
