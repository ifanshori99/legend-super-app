// Prep labels (PRD v1.7 §3 F41 "Label Prep", OPS-03): an expiry alert list
// first, the create form with a use-by suggested from the batch expiry, and a
// printable label preview. Printing records `printedAt` through
// `printPrepLabel`; the print stylesheet limits the sheet to 90 × 60 mm on A4.
import * as React from "react";
import { cn } from "cn";
import { Printer } from "lucide-react";
import {
  inventoryItemIdSchema,
  type InventoryItem,
  type StockBatch,
} from "@starter/shared/inventory";
import {
  expiredPrepLabels,
  isPrepLabelExpired,
  type PrepLabel,
} from "@starter/shared/operations";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";
import {
  useCreatePrepLabel,
  useInventoryItems,
  usePrepLabels,
  usePrintPrepLabel,
  useStockBatches,
} from "../hooks.ts";
import {
  formatBusinessDate,
  formatDateTime,
  fromDateTimeLocalValue,
  personName,
  shortId,
  suggestUseBy,
  toDateTimeLocalValue,
} from "../logic.ts";
import { FOOD_SAFETY_LIST_LIMIT } from "../outlet.ts";
import { useMinuteClock } from "../use-minute-clock.ts";

// Hide every shell part when printing; the physical label is 90 × 60 mm on
// an A4 sheet and always uses the light palette (ThemeScope mode="light").
const LABEL_PRINT_STYLE = `@page { size: A4; margin: 10mm; }
@media print {
  body { background: transparent !important; }
  body * { visibility: hidden; }
  .label-print-sheet, .label-print-sheet * { visibility: visible; }
  .label-print-sheet {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    width: 90mm;
    height: 60mm;
    margin: 0;
    padding: 6mm;
    box-shadow: none !important;
  }
  .label-print-sheet * { box-shadow: none !important; }
  .print-controls { display: none !important; }
}`;

function PrepLabelsScreenContent({
  responsibleName,
}: {
  /** The signed-in staff member the label is printed for. */
  responsibleName: string;
}) {
  const t = useT();
  const toast = useToast();
  const { clock } = useOutletClock();
  const { outlet, brandName } = useTenantContext();
  const now = useMinuteClock();

  const labelsResult = usePrepLabels(outlet?.id, {
    limit: FOOD_SAFETY_LIST_LIMIT,
  });
  const itemsResult = useInventoryItems({ limit: FOOD_SAFETY_LIST_LIMIT });
  const batchesResult = useStockBatches(outlet?.id, {
    limit: FOOD_SAFETY_LIST_LIMIT,
  });
  const createLabel = useCreatePrepLabel();
  const printLabel = usePrintPrepLabel();

  const labels = React.useMemo(
    () =>
      [...(labelsResult.data?.data ?? [])].sort(
        (a, b) => Date.parse(b.producedAt) - Date.parse(a.producedAt),
      ),
    [labelsResult.data],
  );
  const items = React.useMemo(
    () =>
      (itemsResult.data?.data ?? [])
        .filter((item) => item.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
    [itemsResult.data],
  );
  const batches = React.useMemo(
    () =>
      [...(batchesResult.data?.data ?? [])].sort((a, b) =>
        a.batchCode.localeCompare(b.batchCode, "id-ID"),
      ),
    [batchesResult.data],
  );
  const itemById = React.useMemo(() => {
    const map = new Map<string, InventoryItem>();
    for (const item of itemsResult.data?.data ?? []) map.set(item.id, item);
    return map;
  }, [itemsResult.data]);
  const batchById = React.useMemo(() => {
    const map = new Map<string, StockBatch>();
    for (const batch of batchesResult.data?.data ?? [])
      map.set(batch.id, batch);
    return map;
  }, [batchesResult.data]);

  const expired = React.useMemo(
    () =>
      expiredPrepLabels(labels, now).sort(
        (a, b) => Date.parse(a.useBy) - Date.parse(b.useBy),
      ),
    [labels, now],
  );

  // ---- Create form -------------------------------------------------------
  const [itemId, setItemId] = React.useState("");
  const [batchId, setBatchId] = React.useState("");
  const [producedAt, setProducedAt] = React.useState(() =>
    toDateTimeLocalValue(new Date(), clock.timeZone),
  );
  const [useByInput, setUseByInput] = React.useState("");
  const [useByTouched, setUseByTouched] = React.useState(false);
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string>();
  const [selectedLabelId, setSelectedLabelId] = React.useState<string | null>(
    null,
  );

  const itemBatches = React.useMemo(
    () => batches.filter((batch) => batch.inventoryItemId === itemId),
    [batches, itemId],
  );
  const selectedBatch = batches.find((batch) => batch.id === batchId) ?? null;

  // OPS-03: suggest the use-by from the batch expiry (never later than the
  // batch) until the staff member edits the field themselves. Derived during
  // render, so changing the batch or produced time updates the suggestion
  // without a state-syncing effect.
  const suggestedUseBy = React.useMemo(() => {
    if (selectedBatch === null || producedAt === "") return "";
    const producedIso = fromDateTimeLocalValue(producedAt, clock.timeZone);
    if (producedIso === null) return "";
    const suggestion = suggestUseBy(
      producedIso,
      selectedBatch.expiresOn,
      clock.timeZone,
    );
    return suggestion === null
      ? ""
      : toDateTimeLocalValue(new Date(suggestion), clock.timeZone);
  }, [clock.timeZone, producedAt, selectedBatch]);
  const useBy = useByTouched ? useByInput : suggestedUseBy;

  function resetForm() {
    setBatchId("");
    setUseByInput("");
    setUseByTouched(false);
    setErrors({});
    setFormError(undefined);
    setProducedAt(toDateTimeLocalValue(new Date(), clock.timeZone));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string | undefined> = {};
    if (itemId === "")
      nextErrors.item = t("opsFoodSafety.prepLabels.form.errors.item");
    if (selectedBatch === null || selectedBatch.inventoryItemId !== itemId)
      nextErrors.batch = t("opsFoodSafety.prepLabels.form.errors.batch");
    const producedIso = fromDateTimeLocalValue(producedAt, clock.timeZone);
    if (producedIso === null)
      nextErrors.producedAt = t(
        "opsFoodSafety.prepLabels.form.errors.producedAt",
      );
    const useByIso = fromDateTimeLocalValue(useBy, clock.timeZone);
    if (useByIso === null)
      nextErrors.useBy = t("opsFoodSafety.prepLabels.form.errors.useBy");
    else if (
      producedIso !== null &&
      Date.parse(useByIso) <= Date.parse(producedIso)
    )
      nextErrors.useBy = t("opsFoodSafety.prepLabels.form.errors.useByOrder");

    setErrors(nextErrors);
    setFormError(undefined);
    if (Object.values(nextErrors).some(Boolean)) return;
    if (
      outlet === null ||
      producedIso === null ||
      useByIso === null ||
      selectedBatch === null
    )
      return;

    createLabel.mutate(
      {
        outletId: outlet.id,
        inventoryItemId: inventoryItemIdSchema.parse(itemId),
        batchId: selectedBatch.id,
        producedAt: producedIso,
        useBy: useByIso,
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: (result) => {
          toast({
            title: t("opsFoodSafety.prepLabels.form.saved"),
            tone: "success",
          });
          setSelectedLabelId(result.data.id);
          resetForm();
        },
        onError: (error) => {
          if (error instanceof ApiError) {
            const details: Record<string, string> = {};
            for (const detail of error.details ?? [])
              details[detail.field] ??= detail.message;
            setErrors({
              item: details["inventoryItemId"],
              batch: details["batchId"],
              producedAt: details["producedAt"],
              useBy: details["useBy"],
            });
          }
          setFormError(t("opsFoodSafety.prepLabels.form.saveFailed"));
        },
      },
    );
  }

  function printNow(label: PrepLabel) {
    printLabel.mutate(
      {
        params: { labelId: label.id },
        body: { idempotencyKey: newIdempotencyKey() },
      },
      {
        onSuccess: (result) => {
          setSelectedLabelId(result.data.id);
          window.setTimeout(() => window.print(), 0);
        },
        onError: () => {
          toast({
            title: t("opsFoodSafety.prepLabels.preview.printFailed"),
            tone: "danger",
          });
        },
      },
    );
  }

  // Show the newest label until the user picks one, so the preview card is
  // useful on first load (and a new label becomes selected after its create).
  const selectedLabel =
    labels.find((label) => label.id === selectedLabelId) ?? labels[0] ?? null;
  const selectedItem = selectedLabel
    ? itemById.get(selectedLabel.inventoryItemId)
    : null;
  const selectedBatchForPreview = selectedLabel
    ? batchById.get(selectedLabel.batchId)
    : null;

  const pending =
    outlet !== null &&
    (labelsResult.isPending ||
      itemsResult.isPending ||
      batchesResult.isPending);
  const failed =
    labelsResult.isError || itemsResult.isError || batchesResult.isError;
  const firstError =
    labelsResult.error ?? itemsResult.error ?? batchesResult.error;
  const offline =
    firstError instanceof ApiError && firstError.code === "NETWORK_ERROR";
  const retry = () => {
    void labelsResult.refetch();
    void itemsResult.refetch();
    void batchesResult.refetch();
  };
  const responsible =
    responsibleName || t("opsFoodSafety.common.unknownEmployee");

  return (
    <div
      data-slot="food-safety-prep-labels"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4"
    >
      <style>{LABEL_PRINT_STYLE}</style>
      <header className="grid gap-1">
        <h1 className="type-display">{t("opsFoodSafety.prepLabels.title")}</h1>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("opsFoodSafety.prepLabels.subtitle")}
        </p>
      </header>

      {pending && (
        <Card aria-busy="true">
          <span className="sr-only">
            {t("opsFoodSafety.prepLabels.loading")}
          </span>
          <Skeleton className="h-20" />
          <Skeleton className="h-56" />
        </Card>
      )}

      {!pending && failed && (
        <Card>
          <ErrorState
            error={firstError}
            title={t("opsFoodSafety.prepLabels.errorTitle")}
            description={
              offline
                ? t("opsFoodSafety.prepLabels.offline")
                : t("opsFoodSafety.prepLabels.errorHint")
            }
            onRetry={retry}
          />
        </Card>
      )}

      {!pending && !failed && (
        <>
          <Card
            data-slot="prep-label-expired"
            role="region"
            aria-label={t("opsFoodSafety.prepLabels.expired.title")}
            className={cn(
              "gap-3",
              expired.length > 0 && "border-2 border-danger",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="type-title">
                {t("opsFoodSafety.prepLabels.expired.title")}
              </h2>
              {expired.length > 0 ? (
                <StatusPill status="danger" solid>
                  {t("opsFoodSafety.prepLabels.expired.count", {
                    count: expired.length,
                  })}
                </StatusPill>
              ) : (
                <StatusPill status="success">
                  {t("opsFoodSafety.prepLabels.expired.none")}
                </StatusPill>
              )}
            </div>
            <p className="text-sm leading-5 text-muted-foreground">
              {expired.length > 0
                ? t("opsFoodSafety.prepLabels.expired.hint")
                : t("opsFoodSafety.prepLabels.expired.noneHint")}
            </p>
            {expired.length > 0 && (
              <ul className="grid gap-2">
                {expired.map((label) => {
                  const item = itemById.get(label.inventoryItemId);
                  const batch = batchById.get(label.batchId);
                  return (
                    <li
                      key={label.id}
                      data-slot="prep-label-expired-row"
                      className="relative min-w-0 overflow-hidden rounded-container border-2 border-danger bg-background p-3"
                    >
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-0 start-0 w-1.5 bg-danger"
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold">
                          {item?.name ?? t("opsFoodSafety.common.unknownItem")}
                        </span>
                        <StatusPill status="danger" solid>
                          {t("opsFoodSafety.prepLabels.list.expired")}
                        </StatusPill>
                      </div>
                      <p className="text-sm font-medium text-danger tabular">
                        {t("opsFoodSafety.prepLabels.expired.useBy", {
                          time: formatDateTime(label.useBy, clock.timeZone),
                        })}
                      </p>
                      <dl className="mt-1 grid gap-0.5 text-sm">
                        <div className="flex min-w-0 flex-wrap gap-1">
                          <dt className="text-muted-foreground">
                            {t("opsFoodSafety.prepLabels.list.batch")}
                          </dt>
                          <dd
                            data-slot="prep-label-batch"
                            className="font-mono"
                          >
                            {batch?.batchCode ??
                              t("opsFoodSafety.common.unknownBatch")}
                          </dd>
                        </div>
                        <div className="flex min-w-0 flex-wrap gap-1">
                          <dt className="text-muted-foreground">
                            {t("opsFoodSafety.prepLabels.list.responsible")}
                          </dt>
                          <dd>
                            {personName(label.producedBy) ??
                              shortId(label.producedBy)}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div className="grid min-w-0 gap-4">
              <Card
                data-slot="prep-label-form"
                role="region"
                aria-label={t("opsFoodSafety.prepLabels.form.title")}
              >
                <CardHeader>
                  <CardTitle>
                    {t("opsFoodSafety.prepLabels.form.title")}
                  </CardTitle>
                  <CardDescription>
                    {t("opsFoodSafety.prepLabels.form.hint")}
                  </CardDescription>
                </CardHeader>
                <form className="grid gap-4" noValidate onSubmit={submit}>
                  <FormField
                    label={t("opsFoodSafety.prepLabels.form.item")}
                    id="prep-label-item"
                    required
                    error={errors.item}
                  >
                    <Select
                      value={itemId}
                      onValueChange={(value) => {
                        setItemId(value);
                        setBatchId("");
                        setUseByTouched(false);
                        setUseByInput("");
                        setErrors((current) => ({
                          ...current,
                          item: undefined,
                          batch: undefined,
                        }));
                      }}
                    >
                      <SelectTrigger id="prep-label-item">
                        <SelectValue
                          placeholder={t(
                            "opsFoodSafety.prepLabels.form.itemPlaceholder",
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
                    label={t("opsFoodSafety.prepLabels.form.batch")}
                    id="prep-label-batch"
                    required
                    hint={t("opsFoodSafety.prepLabels.form.batchHint")}
                    error={errors.batch}
                  >
                    <Select
                      value={batchId}
                      onValueChange={(value) => {
                        setBatchId(value);
                        setErrors((current) => ({
                          ...current,
                          batch: undefined,
                        }));
                      }}
                      disabled={itemId === "" || itemBatches.length === 0}
                    >
                      <SelectTrigger id="prep-label-batch">
                        <SelectValue
                          placeholder={
                            itemId !== "" && itemBatches.length === 0
                              ? t("opsFoodSafety.prepLabels.form.batchEmpty")
                              : t(
                                  "opsFoodSafety.prepLabels.form.batchPlaceholder",
                                )
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {itemBatches.map((batch) => (
                          <SelectItem key={batch.id} value={batch.id}>
                            {batch.batchCode}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>

                  <FormField
                    label={t("opsFoodSafety.prepLabels.form.producedAt")}
                    required
                    error={errors.producedAt}
                  >
                    <Input
                      type="datetime-local"
                      value={producedAt}
                      onChange={(event) => {
                        setProducedAt(event.target.value);
                        setUseByTouched(false);
                      }}
                    />
                  </FormField>

                  <FormField
                    label={t("opsFoodSafety.prepLabels.form.useBy")}
                    required
                    hint={
                      useByTouched
                        ? t("opsFoodSafety.prepLabels.form.useByHint")
                        : selectedBatch?.expiresOn
                          ? t("opsFoodSafety.prepLabels.form.useBySuggested", {
                              date: formatBusinessDate(selectedBatch.expiresOn),
                            })
                          : t("opsFoodSafety.prepLabels.form.useByHint")
                    }
                    error={errors.useBy}
                  >
                    <Input
                      type="datetime-local"
                      value={useBy}
                      onChange={(event) => {
                        setUseByInput(event.target.value);
                        setUseByTouched(true);
                      }}
                    />
                  </FormField>

                  <div className="grid gap-1">
                    <p className="text-sm font-semibold">
                      {t("opsFoodSafety.prepLabels.form.responsible")}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {responsible}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {t("opsFoodSafety.prepLabels.form.responsibleHint")}
                    </p>
                  </div>

                  {formError && (
                    <p
                      role="alert"
                      className="text-sm leading-5 font-medium text-danger"
                    >
                      {formError}
                    </p>
                  )}

                  <div className="flex justify-end">
                    <Button type="submit" loading={createLabel.isPending}>
                      {t("opsFoodSafety.prepLabels.form.save")}
                    </Button>
                  </div>
                </form>
              </Card>

              <Card
                data-slot="prep-label-list"
                role="region"
                aria-label={t("opsFoodSafety.prepLabels.list.title")}
              >
                <CardHeader>
                  <CardTitle>
                    {t("opsFoodSafety.prepLabels.list.title")}
                  </CardTitle>
                  <CardDescription>
                    {t("opsFoodSafety.prepLabels.list.hint")}
                  </CardDescription>
                </CardHeader>
                {labels.length === 0 ? (
                  <EmptyState
                    icon={Printer}
                    title={t("opsFoodSafety.prepLabels.list.emptyTitle")}
                    description={t("opsFoodSafety.prepLabels.list.emptyHint")}
                  />
                ) : (
                  <ul className="grid gap-2">
                    {labels.map((label) => {
                      const item = itemById.get(label.inventoryItemId);
                      const batch = batchById.get(label.batchId);
                      const expiredLabel = isPrepLabelExpired(label, now);
                      const name =
                        item?.name ?? t("opsFoodSafety.common.unknownItem");
                      return (
                        <li key={label.id} data-slot="prep-label">
                          <button
                            type="button"
                            aria-label={t(
                              "opsFoodSafety.prepLabels.list.select",
                              { item: name },
                            )}
                            aria-pressed={
                              label.id === (selectedLabelId ?? labels[0]?.id)
                            }
                            onClick={() => setSelectedLabelId(label.id)}
                            className={cn(
                              "grid w-full min-w-0 gap-2 rounded-container border-(length:--border-w) bg-background p-3 text-left pressable",
                              label.id === (selectedLabelId ?? labels[0]?.id)
                                ? "border-primary bg-primary-tint"
                                : "hover:bg-surface-2",
                            )}
                          >
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold">{name}</span>
                              {expiredLabel && (
                                <StatusPill status="danger">
                                  {t("opsFoodSafety.prepLabels.list.expired")}
                                </StatusPill>
                              )}
                              <Badge
                                tone={label.printedAt ? "success" : "warning"}
                              >
                                {label.printedAt
                                  ? t("opsFoodSafety.prepLabels.list.printed", {
                                      time: formatDateTime(
                                        label.printedAt,
                                        clock.timeZone,
                                      ),
                                    })
                                  : t(
                                      "opsFoodSafety.prepLabels.list.notPrinted",
                                    )}
                              </Badge>
                            </span>
                            <span className="grid min-w-0 gap-1 text-sm sm:grid-cols-2">
                              <span className="flex min-w-0 flex-wrap gap-1">
                                <span className="text-muted-foreground">
                                  {t(
                                    "opsFoodSafety.prepLabels.list.producedAt",
                                  )}
                                </span>
                                <span className="font-semibold tabular">
                                  {formatDateTime(
                                    label.producedAt,
                                    clock.timeZone,
                                  )}
                                </span>
                              </span>
                              <span className="flex min-w-0 flex-wrap gap-1">
                                <span className="text-muted-foreground">
                                  {t("opsFoodSafety.prepLabels.list.useBy")}
                                </span>
                                <span
                                  data-slot="prep-label-use-by"
                                  className={cn(
                                    "font-semibold tabular",
                                    expiredLabel && "text-danger",
                                  )}
                                >
                                  {formatDateTime(label.useBy, clock.timeZone)}
                                </span>
                              </span>
                              <span className="flex min-w-0 flex-wrap gap-1">
                                <span className="text-muted-foreground">
                                  {t(
                                    "opsFoodSafety.prepLabels.list.responsible",
                                  )}
                                </span>
                                <span>
                                  {personName(label.producedBy) ??
                                    shortId(label.producedBy)}
                                </span>
                              </span>
                              <span className="flex min-w-0 flex-wrap gap-1">
                                <span className="text-muted-foreground">
                                  {t("opsFoodSafety.prepLabels.list.batch")}
                                </span>
                                <span
                                  data-slot="prep-label-batch"
                                  className="font-mono"
                                >
                                  {batch?.batchCode ??
                                    t("opsFoodSafety.common.unknownBatch")}
                                </span>
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </div>

            <Card
              data-slot="prep-label-preview"
              role="region"
              aria-label={t("opsFoodSafety.prepLabels.preview.title")}
              className="h-fit lg:sticky lg:top-4"
            >
              <CardHeader>
                <CardTitle>
                  {t("opsFoodSafety.prepLabels.preview.title")}
                </CardTitle>
                <CardDescription>
                  {t("opsFoodSafety.prepLabels.preview.hint")}
                </CardDescription>
              </CardHeader>
              {selectedLabel === null ? (
                <EmptyState
                  icon={Printer}
                  title={t("opsFoodSafety.prepLabels.preview.emptyTitle")}
                  description={t("opsFoodSafety.prepLabels.preview.emptyHint")}
                />
              ) : (
                <>
                  <ThemeScope
                    mode="light"
                    density="kontras"
                    className="rounded-container p-3"
                  >
                    <article
                      data-slot="prep-label-sheet"
                      className="label-print-sheet mx-auto grid w-full max-w-[90mm] gap-2 rounded-container border-2 border-border bg-background p-4 text-foreground"
                    >
                      <p className="type-eyebrow">
                        {t("opsFoodSafety.prepLabels.preview.labelTitle")}
                      </p>
                      <h3 className="type-title break-words">
                        {selectedItem?.name ??
                          t("opsFoodSafety.common.unknownItem")}
                      </h3>
                      <dl className="grid gap-1.5 text-sm">
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-muted-foreground">
                            {t("opsFoodSafety.prepLabels.preview.produced")}
                          </dt>
                          <dd className="text-right font-semibold tabular">
                            {formatDateTime(
                              selectedLabel.producedAt,
                              clock.timeZone,
                            )}
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3 border-t pt-1.5">
                          <dt className="text-muted-foreground">
                            {t("opsFoodSafety.prepLabels.preview.useBy")}
                          </dt>
                          <dd
                            data-slot="prep-label-use-by"
                            className="text-right font-bold tabular"
                          >
                            {formatDateTime(
                              selectedLabel.useBy,
                              clock.timeZone,
                            )}
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-muted-foreground">
                            {t("opsFoodSafety.prepLabels.preview.responsible")}
                          </dt>
                          <dd className="text-right">
                            {personName(selectedLabel.producedBy) ??
                              shortId(selectedLabel.producedBy)}
                          </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-muted-foreground">
                            {t("opsFoodSafety.prepLabels.preview.batch")}
                          </dt>
                          <dd
                            data-slot="prep-label-batch"
                            className="text-right font-mono"
                          >
                            {selectedBatchForPreview?.batchCode ??
                              t("opsFoodSafety.common.unknownBatch")}
                          </dd>
                        </div>
                      </dl>
                      <p className="mt-1 border-t pt-2 text-xs text-muted-foreground">
                        {outlet?.name ?? brandName}
                      </p>
                    </article>
                  </ThemeScope>
                  <div className="print-controls flex flex-wrap items-center justify-between gap-2">
                    <Badge
                      tone={selectedLabel.printedAt ? "success" : "warning"}
                    >
                      {selectedLabel.printedAt
                        ? t("opsFoodSafety.prepLabels.preview.printed", {
                            time: formatDateTime(
                              selectedLabel.printedAt,
                              clock.timeZone,
                            ),
                          })
                        : t("opsFoodSafety.prepLabels.preview.notPrinted")}
                    </Badge>
                    <Button
                      type="button"
                      variant="outline"
                      loading={printLabel.isPending}
                      onClick={() => printNow(selectedLabel)}
                      data-slot="prep-label-print"
                    >
                      <Printer aria-hidden="true" />
                      {t("opsFoodSafety.prepLabels.preview.print")}
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("opsFoodSafety.prepLabels.preview.printHint")}
                  </p>
                </>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Keyed by outlet: switching outlet in the shell resets the form and
 * selections, so nothing typed for the previous outlet carries over.
 */
export function PrepLabelsScreen(props: { responsibleName: string }) {
  const { outlet } = useTenantContext();
  return <PrepLabelsScreenContent key={outlet?.id ?? "none"} {...props} />;
}
