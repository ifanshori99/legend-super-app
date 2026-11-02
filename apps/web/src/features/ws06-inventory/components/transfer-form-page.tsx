// New internal transfer (PRD §16 "transfer antarlokasi"): pick the source and
// destination location of this outlet, list items and quantities, and save.
// The balances pane shows what the source location holds right now; the API
// writes one document and two ledger rows per line.
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import {
  useCreateStockTransfer,
  useInventoryItems,
  useStockBalances,
  useStockLocations,
  useUnits,
} from "../hooks";
import {
  formatQuantity,
  formatWithUnit,
  LIST_LIMIT,
  quantityFromInput,
} from "../lib";
import { INVENTORY_OUTLET_ID } from "../outlet";

type Line = { key: string; inventoryItemId: string; quantity: string };

export function TransferFormPage() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const locationsQuery = useStockLocations();
  const itemsQuery = useInventoryItems({ limit: LIST_LIMIT });
  const balancesQuery = useStockBalances();
  const unitsQuery = useUnits({ limit: LIST_LIMIT });
  const createTransfer = useCreateStockTransfer();

  const locations = React.useMemo(
    () => locationsQuery.data?.data ?? [],
    [locationsQuery.data],
  );
  const activeLocations = React.useMemo(
    () => locations.filter((location) => location.isActive),
    [locations],
  );
  const items = React.useMemo(
    () => (itemsQuery.data?.data ?? []).filter((item) => item.isActive),
    [itemsQuery.data],
  );
  const balances = React.useMemo(
    () => balancesQuery.data?.data ?? [],
    [balancesQuery.data],
  );
  const units = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );

  const [fromId, setFromId] = React.useState("");
  const [toId, setToId] = React.useState("");
  const [lines, setLines] = React.useState<Line[]>([]);
  const [itemId, setItemId] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [note, setNote] = React.useState("");
  const [lineError, setLineError] = React.useState<string | undefined>();
  const [formError, setFormError] = React.useState<string | undefined>();
  // One idempotency key per draft: a retry after a timeout or network error
  // reuses it, so the API cannot book the same stock move twice. Any edit to
  // the draft starts a new key (the body changed, so it is a new request).
  const draftKey = React.useRef<string | null>(null);

  const remainingItems = React.useMemo(
    () =>
      items.filter(
        (item) => !lines.some((line) => line.inventoryItemId === item.id),
      ),
    [items, lines],
  );

  // Defaults are derived, not stored: the route remounts once after hydration,
  // so state-only defaults would be lost. Until the user picks, the first two
  // active locations and the first unused item apply.
  const fromValue = fromId || activeLocations[0]?.id || "";
  const toValue =
    toId ||
    activeLocations.find((location) => location.id !== fromValue)?.id ||
    activeLocations[1]?.id ||
    "";
  const pendingItemId = remainingItems.some((item) => item.id === itemId)
    ? itemId
    : (remainingItems[0]?.id ?? "");

  const itemOf = (id: string) => items.find((item) => item.id === id);
  const unitOf = (id: string) => {
    const item = itemOf(id);
    return units.find((unit) => unit.id === item?.baseUomId)?.code ?? "—";
  };
  React.useEffect(() => {
    draftKey.current = null;
  }, [fromValue, toValue, lines, note]);

  const pendingItem = itemOf(pendingItemId);
  const available = balances.find(
    (balance) =>
      balance.locationId === fromValue &&
      balance.inventoryItemId === pendingItem?.id,
  );

  function addLine() {
    const parsed = quantityFromInput(quantity);
    if (!pendingItemId) {
      setLineError(t("inventory.transfers.form.noItems"));
      return;
    }
    if (parsed === null) {
      setLineError(t("inventory.transfers.form.invalidQuantity"));
      return;
    }
    if (lines.some((line) => line.inventoryItemId === pendingItemId)) {
      setLineError(t("inventory.transfers.form.duplicateItem"));
      return;
    }
    setLines((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        inventoryItemId: pendingItemId,
        quantity: parsed,
      },
    ]);
    setQuantity("");
    setLineError(undefined);
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((line) => line.key !== key));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (fromValue === toValue) {
      setFormError(t("inventory.transfers.form.sameLocation"));
      return;
    }
    if (lines.length === 0) {
      setFormError(t("inventory.transfers.form.emptyLines"));
      return;
    }
    const parsedNote = z
      .string()
      .trim()
      .max(300, t("inventory.errors.tooLong", { max: 300 }))
      .safeParse(note);
    if (!parsedNote.success) {
      setFormError(t("form.errorSummary", { count: 1 }));
      return;
    }
    setFormError(undefined);
    draftKey.current ??= crypto.randomUUID();
    createTransfer.mutate(
      {
        outletId: INVENTORY_OUTLET_ID,
        fromLocationId: fromValue,
        toLocationId: toValue,
        lines: lines.map((line) => ({
          inventoryItemId: line.inventoryItemId,
          quantity: line.quantity,
        })),
        note: parsedNote.data === "" ? null : parsedNote.data,
        idempotencyKey: draftKey.current,
      },
      {
        onSuccess: () => {
          toast({
            title: t("inventory.transfers.form.created"),
            tone: "success",
          });
          void navigate({ to: "/kelola/inventori/transfer" });
        },
        onError: (error) =>
          setFormError(
            error instanceof ApiError
              ? error.message
              : t("inventory.errors.saveFailed"),
          ),
      },
    );
  }

  const loading =
    locationsQuery.isPending ||
    itemsQuery.isPending ||
    balancesQuery.isPending ||
    unitsQuery.isPending;
  const failed =
    locationsQuery.isError ||
    itemsQuery.isError ||
    balancesQuery.isError ||
    unitsQuery.isError;

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-1">
        <Link
          to="/kelola/inventori/transfer"
          className="inline-flex w-fit items-center gap-1 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("inventory.transfers.form.back")}
        </Link>
        <h2 className="type-title">{t("inventory.transfers.form.title")}</h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("inventory.transfers.form.subtitle")}
        </p>
      </div>

      {loading ? (
        <div className="grid gap-3 rounded-container border bg-card p-card shadow-hairline">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
        </div>
      ) : failed ? (
        <div className="rounded-container border bg-card">
          <ErrorState
            onRetry={() => {
              void locationsQuery.refetch();
              void itemsQuery.refetch();
              void balancesQuery.refetch();
              void unitsQuery.refetch();
            }}
          />
        </div>
      ) : activeLocations.length < 2 ? (
        <div className="rounded-container border bg-card">
          <EmptyState
            title={t("inventory.transfers.form.noLocations")}
            description={t("inventory.transfers.form.noLocationsHint")}
            action={
              <Button asChild variant="outline">
                <Link to="/kelola/inventori/lokasi">
                  {t("inventory.locations.title")}
                </Link>
              </Button>
            }
          />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-container border bg-card">
          <EmptyState
            title={t("inventory.transfers.form.noItems")}
            description={t("inventory.transfers.form.noItemsHint")}
            action={
              <Button asChild variant="outline">
                <Link to="/kelola/inventori">{t("inventory.list.title")}</Link>
              </Button>
            }
          />
        </div>
      ) : (
        <form className="grid min-w-0 gap-4" onSubmit={submit} noValidate>
          <section className="grid gap-4 rounded-container border bg-card p-card shadow-hairline sm:grid-cols-2">
            <FormField label={t("inventory.transfers.form.from")} required>
              <Select value={fromValue} onValueChange={setFromId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("inventory.transfers.form.from")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {activeLocations.map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t("inventory.transfers.form.to")} required>
              <Select value={toValue} onValueChange={setToId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("inventory.transfers.form.to")} />
                </SelectTrigger>
                <SelectContent>
                  {activeLocations.map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </section>

          <section className="grid gap-4 rounded-container border bg-card p-card shadow-hairline">
            <h3 className="text-base leading-6 font-semibold">
              {t("inventory.transfers.form.linesTitle")}
            </h3>
            <div className="grid gap-3 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
              <FormField label={t("inventory.transfers.form.item")} required>
                <Select value={pendingItemId} onValueChange={setItemId}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t("inventory.transfers.form.item")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {remainingItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                label={t("inventory.transfers.form.quantity")}
                hint={
                  pendingItem && fromValue
                    ? t("inventory.transfers.form.available", {
                        quantity: formatQuantity(
                          available?.quantity ?? "0.0000",
                        ),
                        unit: unitOf(pendingItem.id),
                      })
                    : undefined
                }
                error={lineError}
                required
              >
                <Input
                  value={quantity}
                  onChange={(event) => {
                    setQuantity(event.target.value);
                    setLineError(undefined);
                  }}
                  inputMode="decimal"
                  autoComplete="off"
                />
              </FormField>
              <Button type="button" variant="outline" onClick={addLine}>
                <Plus aria-hidden="true" />
                {t("inventory.transfers.form.addLine")}
              </Button>
            </div>

            {lines.length > 0 && (
              <div className="overflow-hidden rounded-container border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {t("inventory.transfers.columns.lines")}
                      </TableHead>
                      <TableHead numeric>
                        {t("inventory.transfers.columns.quantity")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("inventory.list.columns.actions")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((line) => (
                      <TableRow key={line.key}>
                        <TableCell className="font-medium">
                          {itemOf(line.inventoryItemId)?.name ?? "—"}
                        </TableCell>
                        <TableCell numeric>
                          {formatWithUnit(
                            line.quantity,
                            unitOf(line.inventoryItemId),
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t(
                                "inventory.transfers.form.removeLine",
                                {
                                  item:
                                    itemOf(line.inventoryItemId)?.name ?? "",
                                },
                              )}
                              onClick={() => removeLine(line.key)}
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <FormField
              label={t("inventory.transfers.form.note")}
              hint={t("inventory.transfers.form.noteHint")}
            >
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
              />
            </FormField>
          </section>

          {formError && (
            <p
              role="alert"
              className="rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
            >
              {formError}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              loading={createTransfer.isPending}
              disabled={lines.length === 0}
            >
              {t("inventory.transfers.form.submit")}
            </Button>
            <Button asChild variant="outline">
              <Link to="/kelola/inventori/transfer">
                {t("inventory.transfers.form.back")}
              </Link>
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
