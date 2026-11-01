// Purchase suggestions (PRD §16 "Par Level & Saran Pembelian", AI-08): the
// par-level basis, the selection, and the draft purchase request that starts
// the PR → approval → PO flow (PRD §4 Alur I). Approval screens belong to
// legend-1j7; this screen only creates the draft.
import * as React from "react";
import { useRouteContext } from "@tanstack/react-router";
import { CheckCircle2, ListChecks, PackageCheck, X } from "lucide-react";
import type { PurchaseRequestDetail } from "@starter/shared/inventory";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  useCreatePurchaseRequest,
  useInventoryItems,
  useParLevels,
  useStockBalances,
  useStockLocations,
  useUnits,
} from "../hooks";
import {
  STOCK_LIST_LIMIT,
  addDays,
  businessDateToday,
  formatBusinessDate,
  formatQuantity,
  parRows,
  purchaseSuggestions,
  shortId,
  type PurchaseSuggestion,
} from "../lib";
import { INVENTORY_OUTLET_ID } from "../outlet";

export function SuggestionsPage() {
  const t = useT();
  const toast = useToast();
  const { access } = useRouteContext({ strict: false }) as {
    access: AreaAccess;
  };
  const canCreate = holdsAny(access, ["purchasing.request.create"]);

  const parLevelsQuery = useParLevels();
  const balancesQuery = useStockBalances();
  const itemsQuery = useInventoryItems({ limit: STOCK_LIST_LIMIT });
  const locationsQuery = useStockLocations();
  const unitsQuery = useUnits({ limit: STOCK_LIST_LIMIT });
  const mutation = useCreatePurchaseRequest();

  const suggestions = React.useMemo(
    () =>
      purchaseSuggestions(
        parRows({
          parLevels: parLevelsQuery.data?.data ?? [],
          balances: balancesQuery.data?.data ?? [],
          items: itemsQuery.data?.data ?? [],
          locations: locationsQuery.data?.data ?? [],
          uoms: unitsQuery.data?.data ?? [],
        }),
      ),
    [
      parLevelsQuery.data,
      balancesQuery.data,
      itemsQuery.data,
      locationsQuery.data,
      unitsQuery.data,
    ],
  );

  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [neededBy, setNeededBy] = React.useState(() =>
    addDays(businessDateToday(), 3),
  );
  const [note, setNote] = React.useState("");
  const [dateError, setDateError] = React.useState<string | undefined>();
  const [created, setCreated] = React.useState<PurchaseRequestDetail | null>(
    null,
  );

  const selectedSuggestions = suggestions.filter((row) =>
    selected.has(row.key),
  );

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const pending =
    parLevelsQuery.isPending ||
    balancesQuery.isPending ||
    itemsQuery.isPending ||
    locationsQuery.isPending ||
    unitsQuery.isPending;
  const failed =
    parLevelsQuery.isError ||
    balancesQuery.isError ||
    itemsQuery.isError ||
    locationsQuery.isError ||
    unitsQuery.isError;
  const error =
    parLevelsQuery.error ??
    balancesQuery.error ??
    itemsQuery.error ??
    locationsQuery.error ??
    unitsQuery.error;
  const offline = error instanceof ApiError && error.code === "NETWORK_ERROR";

  const retry = () => {
    void parLevelsQuery.refetch();
    void balancesQuery.refetch();
    void itemsQuery.refetch();
    void locationsQuery.refetch();
    void unitsQuery.refetch();
  };

  const submit = () => {
    if (!neededBy) {
      setDateError(t("inventoryStock.suggestions.dialog.requiredDate"));
      return;
    }
    setDateError(undefined);
    mutation.mutate(
      {
        outletId: INVENTORY_OUTLET_ID,
        neededBy,
        lines: selectedSuggestions.map((row) => ({
          inventoryItemId: row.item.id,
          quantity: row.suggestedQty,
          uomId: row.item.baseUomId,
        })),
        note: note.trim() === "" ? null : note.trim(),
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: (result) => {
          setCreated(result.data);
          setSelected(new Set());
          setNote("");
          setDialogOpen(false);
          toast({
            title: t("inventoryStock.suggestions.toast"),
            tone: "success",
          });
        },
      },
    );
  };

  return (
    <div className="grid min-w-0 gap-4">
      <header className="grid gap-1">
        <h2 className="text-lg leading-7 font-semibold">
          {t("inventoryStock.suggestions.title")}
        </h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("inventoryStock.suggestions.description")}
        </p>
      </header>

      {created && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2
                className="size-5 text-success"
                aria-hidden="true"
              />
              {t("inventoryStock.suggestions.createdTitle")}
            </CardTitle>
            <CardDescription>
              {t("inventoryStock.suggestions.createdHint")}
            </CardDescription>
          </CardHeader>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-0.5">
              <dt className="text-sm text-muted-foreground">
                {t("inventoryStock.suggestions.createdId")}
              </dt>
              <dd className="font-mono text-sm">
                {shortId(created.request.id)}
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-sm text-muted-foreground">
                {t("inventoryStock.suggestions.dialog.linesTitle")}
              </dt>
              <dd className="tabular">
                {t("inventoryStock.suggestions.createdLines", {
                  count: created.lines.length,
                })}
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-sm text-muted-foreground">
                {t("inventoryStock.suggestions.dialog.neededBy")}
              </dt>
              <dd className="tabular">
                {formatBusinessDate(created.request.neededBy)}
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-sm text-muted-foreground">
                {t("inventoryStock.columns.status")}
              </dt>
              <dd>
                <StatusPill status="info">
                  {t("inventoryStock.suggestions.createdStatus")}
                </StatusPill>
              </dd>
            </div>
          </dl>
        </Card>
      )}

      {pending ? (
        <div
          aria-busy="true"
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          <span className="sr-only">{t("common.loading")}</span>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : failed ? (
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <ErrorState
            title={t("inventoryStock.errors.load")}
            description={
              offline
                ? t("inventoryStock.errors.offline")
                : t("inventoryStock.errors.loadHint")
            }
            onRetry={retry}
          />
        </div>
      ) : suggestions.length === 0 ? (
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <EmptyState
            icon={PackageCheck}
            title={t("inventoryStock.suggestions.emptyTitle")}
            description={t("inventoryStock.suggestions.emptyHint")}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setSelected(new Set(suggestions.map((row) => row.key)))
                }
              >
                <ListChecks aria-hidden="true" />
                {t("inventoryStock.suggestions.selectAll")}
              </Button>
              {selected.size > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                >
                  <X aria-hidden="true" />
                  {t("inventoryStock.suggestions.clearSelection")}
                </Button>
              )}
              <span className="text-sm text-muted-foreground tabular">
                {t("inventoryStock.suggestions.selectedCount", {
                  count: selected.size,
                })}
              </span>
            </div>
            {canCreate ? (
              <Button
                type="button"
                onClick={() => setDialogOpen(true)}
                disabled={selected.size === 0}
              >
                {t("inventoryStock.suggestions.createDraft")}
              </Button>
            ) : (
              <p className="max-w-sm text-sm leading-5 text-muted-foreground">
                {t("inventoryStock.suggestions.notAllowed")}
              </p>
            )}
          </div>

          <ul className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {suggestions.map((suggestion) => (
              <SuggestionCard
                key={suggestion.key}
                suggestion={suggestion}
                checked={selected.has(suggestion.key)}
                onToggle={() => toggle(suggestion.key)}
              />
            ))}
          </ul>
        </>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setDateError(undefined);
            mutation.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("inventoryStock.suggestions.dialog.title")}
            </DialogTitle>
            <DialogDescription>
              {t("inventoryStock.suggestions.dialog.description", {
                count: selectedSuggestions.length,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <FormField
              label={t("inventoryStock.suggestions.dialog.neededBy")}
              required
              error={dateError}
              hint={t("inventoryStock.suggestions.dialog.neededByHint")}
            >
              <Input
                type="date"
                value={neededBy}
                min={businessDateToday()}
                onChange={(event) => {
                  setNeededBy(event.target.value);
                  setDateError(undefined);
                }}
              />
            </FormField>
            <FormField
              label={t("inventoryStock.suggestions.dialog.note")}
              hint={t("inventoryStock.suggestions.dialog.noteHint")}
            >
              <Textarea
                value={note}
                maxLength={300}
                rows={3}
                onChange={(event) => setNote(event.target.value)}
              />
            </FormField>
            <div className="grid gap-1">
              <p className="text-sm font-semibold">
                {t("inventoryStock.suggestions.dialog.linesTitle")}
              </p>
              <ul className="grid gap-1 text-sm text-muted-foreground">
                {selectedSuggestions.map((row) => (
                  <li key={row.key} className="tabular">
                    {t("inventoryStock.suggestions.dialog.line", {
                      item: row.item.name,
                      quantity: formatQuantity(row.suggestedQty),
                      unit: row.unit,
                    })}
                  </li>
                ))}
              </ul>
            </div>
            {mutation.isError && (
              <p
                role="alert"
                className="text-sm leading-5 font-medium text-danger"
              >
                {mutation.error instanceof ApiError &&
                mutation.error.message.length > 0
                  ? mutation.error.message
                  : t("inventoryStock.suggestions.errorSave")}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
            >
              {t("inventoryStock.suggestions.dialog.cancel")}
            </Button>
            <Button type="button" loading={mutation.isPending} onClick={submit}>
              {t("inventoryStock.suggestions.dialog.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  checked,
  onToggle,
}: {
  suggestion: PurchaseSuggestion;
  checked: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const id = React.useId();
  return (
    <li>
      <Card className="h-full gap-3">
        <div className="flex items-start gap-3">
          <Checkbox
            id={id}
            checked={checked}
            onCheckedChange={onToggle}
            className="mt-1"
          />
          <div className="min-w-0 flex-1">
            <Label
              htmlFor={id}
              className="cursor-pointer text-base leading-6 font-semibold"
            >
              {suggestion.item.name}
            </Label>
            <p className="text-sm leading-5 text-muted-foreground">
              {suggestion.location?.name ?? "—"} · {suggestion.item.category}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryStock.suggestions.suggestedQty")}
            </p>
            <p className="text-2xl leading-8 font-semibold tracking-tight tabular">
              {formatQuantity(suggestion.suggestedQty)}{" "}
              <span className="text-base font-normal text-muted-foreground">
                {suggestion.unit}
              </span>
            </p>
          </div>
          <StatusPill status="danger">
            {t("inventoryStock.parStatus.below_min")}
          </StatusPill>
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("inventoryStock.suggestions.basis", {
            onHand: formatQuantity(suggestion.onHand),
            unit: suggestion.unit,
            min: formatQuantity(suggestion.parMin),
            max: formatQuantity(suggestion.parMax),
          })}
        </p>
      </Card>
    </li>
  );
}
