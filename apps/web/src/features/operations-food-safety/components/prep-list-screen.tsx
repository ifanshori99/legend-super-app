// Daily prep list (PRD v1.7 §3 F41 "Daftar Prep Harian"): the morning list of
// semi-finished items, its planned quantities, the production batch once it is
// recorded, and the pending → in_progress → completed transition. The contract
// has no station or due-time field on a prep line, so the screen does not
// invent one (follow-up: WS-14 prep schedule contract).
import * as React from "react";
import { ClipboardList, Plus, Trash2 } from "lucide-react";
import {
  businessDateOf,
  businessDateSchema,
  type Decimal4,
} from "@starter/shared/core";
import {
  inventoryItemIdSchema,
  type InventoryItem,
  type InventoryItemId,
} from "@starter/shared/inventory";
import type { PrepList, PrepListStatus } from "@starter/shared/operations";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useOutletClock } from "@/lib/tenant-context";
import {
  useCreatePrepList,
  useInventoryItems,
  usePrepLists,
  useTransitionPrepList,
  useUnits,
} from "../hooks.ts";
import {
  formatBusinessDate,
  formatDateTime,
  formatQuantity,
  isPositiveQuantity,
  normalizeReadingInput,
  shortId,
} from "../logic.ts";
import { FOOD_SAFETY_LIST_LIMIT, FOOD_SAFETY_OUTLET_ID } from "../outlet.ts";
import { useMinuteClock } from "../use-minute-clock.ts";

type LineDraft = { key: string; itemId: string; quantity: string };

const STATUS: Record<
  PrepListStatus,
  {
    pill: "info" | "warning" | "success";
    label:
      | "opsFoodSafety.prepList.status.pending"
      | "opsFoodSafety.prepList.status.in_progress"
      | "opsFoodSafety.prepList.status.completed";
  }
> = {
  pending: { pill: "info", label: "opsFoodSafety.prepList.status.pending" },
  in_progress: {
    pill: "warning",
    label: "opsFoodSafety.prepList.status.in_progress",
  },
  completed: {
    pill: "success",
    label: "opsFoodSafety.prepList.status.completed",
  },
};

export function PrepListScreen() {
  const t = useT();
  const toast = useToast();
  const { clock } = useOutletClock();
  const now = useMinuteClock();

  const listsResult = usePrepLists({
    outletId: FOOD_SAFETY_OUTLET_ID,
    limit: FOOD_SAFETY_LIST_LIMIT,
  });
  const itemsResult = useInventoryItems({ limit: FOOD_SAFETY_LIST_LIMIT });
  const unitsResult = useUnits({ limit: FOOD_SAFETY_LIST_LIMIT });
  const createList = useCreatePrepList();
  const transitionList = useTransitionPrepList();

  const items = React.useMemo(
    () =>
      (itemsResult.data?.data ?? [])
        .filter((item) => item.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
    [itemsResult.data],
  );
  const itemById = React.useMemo(() => {
    const map = new Map<string, InventoryItem>();
    for (const item of itemsResult.data?.data ?? []) map.set(item.id, item);
    return map;
  }, [itemsResult.data]);
  const unitCodeById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const unit of unitsResult.data?.data ?? [])
      map.set(unit.id, unit.code);
    return map;
  }, [unitsResult.data]);
  const lists = React.useMemo(
    () =>
      [...(listsResult.data?.data ?? [])].sort(
        (a, b) =>
          b.prepDate.localeCompare(a.prepDate) ||
          Date.parse(b.generatedAt) - Date.parse(a.generatedAt),
      ),
    [listsResult.data],
  );

  // ---- Create dialog -----------------------------------------------------
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [prepDate, setPrepDate] = React.useState("");
  const [lines, setLines] = React.useState<LineDraft[]>([]);
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string>();
  const nextLineKey = React.useRef(0);
  const today = businessDateOf(now, clock);

  function newLine(): LineDraft {
    nextLineKey.current += 1;
    return { key: `line-${nextLineKey.current}`, itemId: "", quantity: "" };
  }

  function openDialog() {
    setPrepDate(today);
    setLines([newLine()]);
    setErrors({});
    setFormError(undefined);
    setDialogOpen(true);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string | undefined> = {};
    const parsedDate = businessDateSchema.safeParse(prepDate);
    if (!parsedDate.success)
      nextErrors.date = t("opsFoodSafety.prepList.form.errors.date");
    if (lines.length === 0)
      nextErrors.lines = t("opsFoodSafety.prepList.form.errors.lines");
    const seen = new Set<string>();
    const payload: {
      inventoryItemId: InventoryItemId;
      plannedQuantity: Decimal4;
    }[] = [];
    for (const line of lines) {
      if (line.itemId === "") {
        nextErrors[`${line.key}-item`] = t(
          "opsFoodSafety.prepList.form.errors.item",
        );
        continue;
      }
      if (seen.has(line.itemId)) {
        nextErrors[`${line.key}-item`] = t(
          "opsFoodSafety.prepList.form.errors.duplicate",
        );
        continue;
      }
      seen.add(line.itemId);
      const quantity = normalizeReadingInput(line.quantity);
      if (quantity === null || !isPositiveQuantity(quantity)) {
        nextErrors[`${line.key}-quantity`] = t(
          "opsFoodSafety.prepList.form.errors.quantity",
        );
        continue;
      }
      payload.push({
        inventoryItemId: inventoryItemIdSchema.parse(line.itemId),
        plannedQuantity: quantity,
      });
    }
    setErrors(nextErrors);
    setFormError(undefined);
    if (Object.values(nextErrors).some(Boolean) || !parsedDate.success) return;
    if (payload.length !== lines.length) return;

    createList.mutate(
      {
        outletId: FOOD_SAFETY_OUTLET_ID,
        prepDate: parsedDate.data,
        lines: payload,
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: () => {
          toast({
            title: t("opsFoodSafety.prepList.form.saved"),
            tone: "success",
          });
          setDialogOpen(false);
          setLines([]);
        },
        onError: (error) => {
          if (error instanceof ApiError) {
            const details: Record<string, string> = {};
            for (const detail of error.details ?? [])
              details[detail.field] ??= detail.message;
            setErrors({
              date: details["prepDate"],
              lines: details["lines"],
            });
          }
          setFormError(t("opsFoodSafety.prepList.form.saveFailed"));
        },
      },
    );
  }

  // ---- Transitions -------------------------------------------------------
  const [transitioningId, setTransitioningId] = React.useState<string | null>(
    null,
  );

  function advance(list: PrepList) {
    const action = list.status === "pending" ? "start" : "complete";
    setTransitioningId(list.id);
    transitionList.mutate(
      {
        params: { prepListId: list.id },
        body: { action, idempotencyKey: newIdempotencyKey() },
      },
      {
        onSuccess: () => {
          toast({
            title: t(
              action === "start"
                ? "opsFoodSafety.prepList.card.startToast"
                : "opsFoodSafety.prepList.card.completeToast",
            ),
            tone: "success",
          });
        },
        onError: () => {
          toast({
            title: t("opsFoodSafety.prepList.card.transitionFailed"),
            tone: "danger",
          });
        },
        onSettled: () => setTransitioningId(null),
      },
    );
  }

  const pending =
    listsResult.isPending || itemsResult.isPending || unitsResult.isPending;
  const failed =
    listsResult.isError || itemsResult.isError || unitsResult.isError;
  const firstError =
    listsResult.error ?? itemsResult.error ?? unitsResult.error;
  const offline =
    firstError instanceof ApiError && firstError.code === "NETWORK_ERROR";
  const retry = () => {
    void listsResult.refetch();
    void itemsResult.refetch();
    void unitsResult.refetch();
  };

  return (
    <div
      data-slot="food-safety-prep-list"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4"
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <h1 className="type-display">{t("opsFoodSafety.prepList.title")}</h1>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("opsFoodSafety.prepList.subtitle")}
          </p>
        </div>
        <Button type="button" onClick={openDialog} data-slot="prep-list-create">
          <Plus aria-hidden="true" />
          {t("opsFoodSafety.prepList.actionNew")}
        </Button>
      </header>

      {pending && (
        <Card aria-busy="true">
          <span className="sr-only">{t("opsFoodSafety.prepList.loading")}</span>
          <Skeleton className="h-24" />
          <Skeleton className="h-44" />
        </Card>
      )}

      {!pending && failed && (
        <Card>
          <ErrorState
            title={t("opsFoodSafety.prepList.errorTitle")}
            description={
              offline
                ? t("opsFoodSafety.prepList.offline")
                : t("opsFoodSafety.prepList.errorHint")
            }
            onRetry={retry}
          />
        </Card>
      )}

      {!pending && !failed && lists.length === 0 && (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title={t("opsFoodSafety.prepList.emptyTitle")}
            description={t("opsFoodSafety.prepList.emptyHint")}
          />
        </Card>
      )}

      {!pending && !failed && lists.length > 0 && (
        <div className="grid gap-4">
          {lists.map((list) => {
            const status = STATUS[list.status];
            const canAdvance =
              list.status === "pending" || list.status === "in_progress";
            return (
              <Card
                key={list.id}
                data-slot="prep-list"
                data-status={list.status}
              >
                <CardHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle>
                      {t("opsFoodSafety.prepList.card.title", {
                        date: formatBusinessDate(list.prepDate),
                      })}
                    </CardTitle>
                    <StatusPill status={status.pill}>
                      {t(status.label)}
                    </StatusPill>
                    {list.generatedFromForecastId && (
                      <Badge tone="info">
                        {t("opsFoodSafety.prepList.card.forecast")}
                      </Badge>
                    )}
                  </div>
                  <CardDescription className="tabular">
                    {t("opsFoodSafety.prepList.card.generatedAt", {
                      time: formatDateTime(list.generatedAt, clock.timeZone),
                    })}
                  </CardDescription>
                </CardHeader>

                {list.lines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("opsFoodSafety.prepList.card.emptyLines")}
                  </p>
                ) : (
                  <ul className="grid gap-2">
                    {list.lines.map((line) => {
                      const item = itemById.get(line.inventoryItemId);
                      const unit =
                        item === undefined
                          ? undefined
                          : unitCodeById.get(item.baseUomId);
                      return (
                        <li
                          key={line.id}
                          data-slot="prep-list-line"
                          className="grid min-w-0 gap-2 rounded-container border-(length:--border-w) bg-background p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-semibold">
                              {item?.name ??
                                t("opsFoodSafety.common.unknownItem")}
                            </p>
                            <p className="flex flex-wrap items-baseline gap-1 text-sm text-muted-foreground tabular">
                              <span>
                                {t("opsFoodSafety.prepList.card.planned")}
                              </span>
                              <span className="font-semibold text-foreground">
                                {formatQuantity(line.plannedQuantity)}
                                {unit ? ` ${unit}` : null}
                              </span>
                            </p>
                          </div>
                          <div className="min-w-0 text-sm sm:text-right">
                            <p className="text-muted-foreground">
                              {t("opsFoodSafety.prepList.card.batch")}
                            </p>
                            <p
                              data-slot="prep-list-batch"
                              className="font-mono"
                            >
                              {line.productionOrderId
                                ? t("opsFoodSafety.prepList.card.batchValue", {
                                    id: shortId(line.productionOrderId),
                                  })
                                : t("opsFoodSafety.prepList.card.batchPending")}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground tabular">
                    {t("opsFoodSafety.prepList.card.lines", {
                      count: list.lines.length,
                    })}
                  </p>
                  {canAdvance && (
                    <Button
                      type="button"
                      variant="outline"
                      loading={
                        transitionList.isPending && transitioningId === list.id
                      }
                      disabled={
                        transitionList.isPending && transitioningId !== list.id
                      }
                      onClick={() => advance(list)}
                    >
                      {list.status === "pending"
                        ? t("opsFoodSafety.prepList.card.start")
                        : t("opsFoodSafety.prepList.card.complete")}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("opsFoodSafety.prepList.form.title")}</DialogTitle>
            <DialogDescription>
              {t("opsFoodSafety.prepList.form.hint")}
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" noValidate onSubmit={submit}>
            <FormField
              label={t("opsFoodSafety.prepList.form.date")}
              required
              error={errors.date}
            >
              <Input
                type="date"
                value={prepDate}
                onChange={(event) => setPrepDate(event.target.value)}
              />
            </FormField>

            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold">
                  {t("opsFoodSafety.prepList.form.lines")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLines((current) => [...current, newLine()])}
                >
                  <Plus aria-hidden="true" />
                  {t("opsFoodSafety.prepList.form.add")}
                </Button>
              </div>
              {errors.lines && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {errors.lines}
                </p>
              )}
              <ul className="grid gap-2">
                {lines.map((line) => (
                  <li
                    key={line.key}
                    data-slot="prep-list-line-draft"
                    className="grid min-w-0 gap-2 rounded-container border-(length:--border-w) bg-background p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)_auto] sm:items-start"
                  >
                    <FormField
                      label={t("opsFoodSafety.prepList.form.item")}
                      id={`${line.key}-item-field`}
                      required
                      error={errors[`${line.key}-item`]}
                    >
                      <Select
                        value={line.itemId}
                        onValueChange={(value) =>
                          setLines((current) =>
                            current.map((row) =>
                              row.key === line.key
                                ? { ...row, itemId: value }
                                : row,
                            ),
                          )
                        }
                      >
                        <SelectTrigger id={`${line.key}-item-field`}>
                          <SelectValue
                            placeholder={t(
                              "opsFoodSafety.prepList.form.itemPlaceholder",
                            )}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {items.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField
                      label={t("opsFoodSafety.prepList.form.quantity")}
                      required
                      error={errors[`${line.key}-quantity`]}
                      hint={t("opsFoodSafety.prepList.form.quantityHint")}
                    >
                      <Input
                        inputMode="decimal"
                        autoComplete="off"
                        value={line.quantity}
                        onChange={(event) =>
                          setLines((current) =>
                            current.map((row) =>
                              row.key === line.key
                                ? { ...row, quantity: event.target.value }
                                : row,
                            ),
                          )
                        }
                      />
                    </FormField>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="self-end"
                      aria-label={t("opsFoodSafety.prepList.form.remove")}
                      disabled={lines.length === 1}
                      onClick={() =>
                        setLines((current) =>
                          current.filter((row) => row.key !== line.key),
                        )
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>

            {formError && (
              <p role="alert" className="text-sm font-medium text-danger">
                {formError}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDialogOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={createList.isPending}>
                {t("opsFoodSafety.prepList.form.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
