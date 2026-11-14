// Supplier invoice entry (bead legend-0xnm; PRD v1.7 §3.18, §4 Alur I step 4):
// pick a received PO, copy the supplier's invoice lines, PPN and PPh 23 as
// printed, save once, then read the server's three-way match preview.
//
// Money rule (founder 11 Nov 2026): this screen never computes a total, DPP,
// tax, payable or variance. Before saving it shows only API reference data
// (ordered, accepted, PO price) and what the user typed; every computed figure
// appears in the preview, straight from the API.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  FilePlus2,
  PackageCheck,
  Plus,
  Store,
  Trash2,
} from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { useTenantContext } from "@/lib/tenant-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import type { MessageKey } from "@starter/shared/i18n";
import { acceptedReceivedQuantity } from "@starter/shared/inventory";
import { formatQuantity } from "../../ws06-inventory/lib.ts";
import {
  useAttemptKey,
  useCreateSupplierInvoice,
  useReceiptLinesForOrder,
} from "../receiving-hooks.ts";
import {
  itemNameOf,
  receivingErrorKey,
  supplierNameOf,
  todayBusinessDate,
  uomCodeOf,
} from "../receiving-lib.ts";
import {
  useInventoryItems,
  usePurchaseOrder,
  usePurchaseOrders,
  useSuppliers,
  useUoms,
} from "../hooks.ts";
import {
  addDaysToBusinessDate,
  buildInvoiceInput,
  formatIdrDecimalText,
  goodsDraftsFromOrder,
  invoiceAmountFromInput,
  invoicePriceFromInput,
  invoiceQuantityFromInput,
  newServiceDraft,
  type InvoiceEntryErrorCode,
  type InvoiceEntryErrors,
  type InvoiceLineDraft,
  type InvoiceLineErrors,
} from "../invoice-entry-model.ts";
import { InvoiceMatchPreview } from "./invoice-match-preview.tsx";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

/** A PO can be invoiced once something was received against it. */
const INVOICEABLE_STATUSES = ["partially_received", "received"] as const;

const ERROR_KEY: Record<InvoiceEntryErrorCode, MessageKey> = {
  required: "inventoryInvoiceEntry.errors.required",
  invalidQuantity: "inventoryInvoiceEntry.errors.invalidQuantity",
  invalidPrice: "inventoryInvoiceEntry.errors.invalidPrice",
  invalidAmount: "inventoryInvoiceEntry.errors.invalidAmount",
  dueBeforeInvoice: "inventoryInvoiceEntry.errors.dueBeforeInvoice",
  noLines: "inventoryInvoiceEntry.errors.noLines",
  invalid: "inventoryInvoiceEntry.errors.invalid",
};

/** Keeps a focused field clear of the sticky summary bar. */
const FIELD_CLASS = "scroll-mb-40";

/** Server field names for the two tax inputs (`ppnIdr`, `pph23Idr`). */
const TAX_FIELD = /(^|\.)(ppnIdr|pph23Idr)$/;

type PendingConfirm =
  { kind: "order"; value: string } | { kind: "service"; key: string };

/** Input with the unit of measure beside it; FormField wires props onto it. */
function UnitInput({
  unit,
  className,
  ...props
}: React.ComponentProps<typeof Input> & { unit?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Input className={cn("min-w-0 flex-1", className)} {...props} />
      {unit && (
        <span className="shrink-0 text-sm font-medium text-muted-foreground">
          {unit}
        </span>
      )}
    </div>
  );
}

/**
 * Keyed by outlet and by a counter: switching outlet, or "Catat faktur lain",
 * starts a fresh form (and a fresh idempotency attempt).
 */
export function InvoiceFormPage() {
  const { outlet } = useTenantContext();
  const [epoch, setEpoch] = React.useState(0);
  return (
    <InvoiceFormContent
      key={`${outlet?.id ?? "none"}:${epoch}`}
      onAnother={() => setEpoch((value) => value + 1)}
    />
  );
}

function InvoiceFormContent({ onAnother }: { onAnother: () => void }) {
  const t = useT();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const outletId = outlet?.id ?? "";
  const toast = useToast();
  const attempt = useAttemptKey();
  const createInvoice = useCreateSupplierInvoice();
  const inFlight = React.useRef(false);

  const orders = usePurchaseOrders(outletId);
  const suppliers = useSuppliers();
  const items = useInventoryItems();
  const uoms = useUoms();

  const eligibleOrders = React.useMemo(
    () =>
      (orders.data?.data ?? []).filter((order) =>
        INVOICEABLE_STATUSES.includes(
          order.status as (typeof INVOICEABLE_STATUSES)[number],
        ),
      ),
    [orders.data],
  );
  const [orderChoice, setOrderChoice] = React.useState("");
  const orderId = orderChoice || eligibleOrders[0]?.id || "";
  const order = usePurchaseOrder(orderId);
  const prior = useReceiptLinesForOrder(outletId, orderId);

  const [number, setNumber] = React.useState("");
  const [invoiceDate, setInvoiceDate] = React.useState(() =>
    todayBusinessDate(),
  );
  const [dueInput, setDueInput] = React.useState<string | null>(null);
  const [ppn, setPpn] = React.useState("");
  const [pph23, setPph23] = React.useState("");
  const [overrides, setOverrides] = React.useState<
    Record<string, Partial<InvoiceLineDraft>>
  >({});
  const [serviceLines, setServiceLines] = React.useState<InvoiceLineDraft[]>(
    [],
  );
  const [errors, setErrors] = React.useState<InvoiceEntryErrors>({ lines: {} });
  const [formError, setFormError] = React.useState<string | undefined>();
  const [createdId, setCreatedId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<PendingConfirm | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const savedHeadingRef = React.useRef<HTMLHeadingElement>(null);
  // Bumped when a submit fails: the effect moves focus to the first problem.
  const [focusTick, setFocusTick] = React.useState(0);

  React.useEffect(() => {
    if (focusTick === 0) return;
    rootRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"], [data-form-error]')
      ?.focus();
  }, [focusTick]);

  React.useEffect(() => {
    if (createdId) savedHeadingRef.current?.focus();
  }, [createdId]);

  const orderLines = React.useMemo(
    () => order.data?.data.lines ?? [],
    [order.data],
  );
  const purchaseOrder = order.data?.data.purchaseOrder;
  const supplier = (suppliers.data?.data ?? []).find(
    (candidate) => candidate.id === purchaseOrder?.supplierId,
  );
  const dueDate =
    dueInput ??
    addDaysToBusinessDate(invoiceDate, supplier?.paymentTermsDays ?? 0);

  const goodsDefaults = React.useMemo(
    () =>
      goodsDraftsFromOrder(orderLines, prior.lines, (line) =>
        itemNameOf(items.data?.data ?? [], line.inventoryItemId),
      ),
    [orderLines, prior.lines, items.data],
  );
  const lines = React.useMemo<InvoiceLineDraft[]>(
    () => [
      ...goodsDefaults.map((draft) => ({ ...draft, ...overrides[draft.key] })),
      ...serviceLines,
    ],
    [goodsDefaults, overrides, serviceLines],
  );

  function touch() {
    setFormError(undefined);
  }

  const hasEdits = Object.keys(overrides).length > 0 || serviceLines.length > 0;
  const includedCount = lines.filter((line) => line.included).length;

  function requestOrder(value: string) {
    if (hasEdits) setConfirm({ kind: "order", value });
    else chooseOrder(value);
  }

  function removeService(key: string) {
    setServiceLines((current) =>
      current.filter((candidate) => candidate.key !== key),
    );
    setErrors((current) => {
      if (!(key in current.lines)) return current;
      const next = { ...current.lines };
      delete next[key];
      return { ...current, lines: next };
    });
    touch();
  }

  function requestRemoveService(line: InvoiceLineDraft) {
    if (line.description.trim() !== "" || line.unitPrice.trim() !== "")
      setConfirm({ kind: "service", key: line.key });
    else removeService(line.key);
  }

  function setFieldError(
    field: keyof Omit<InvoiceEntryErrors, "lines">,
    code: InvoiceEntryErrorCode | undefined,
  ) {
    setErrors((current) =>
      current[field] === code ? current : { ...current, [field]: code },
    );
  }

  function setLineFieldError(
    key: string,
    field: keyof InvoiceLineErrors,
    code: InvoiceEntryErrorCode | undefined,
  ) {
    setErrors((current) => {
      const line = current.lines[key] ?? {};
      if (line[field] === code) return current;
      const nextLine = { ...line, [field]: code };
      if (code === undefined) delete nextLine[field];
      const nextLines = { ...current.lines };
      if (Object.keys(nextLine).length > 0) nextLines[key] = nextLine;
      else delete nextLines[key];
      return { ...current, lines: nextLines };
    });
  }

  function chooseOrder(value: string) {
    setOrderChoice(value);
    setOverrides({});
    setServiceLines([]);
    setDueInput(null);
    setErrors({ lines: {} });
    touch();
  }

  function updateLine(key: string, patch: Partial<InvoiceLineDraft>) {
    if (serviceLines.some((line) => line.key === key))
      setServiceLines((current) =>
        current.map((line) =>
          line.key === key ? { ...line, ...patch } : line,
        ),
      );
    else
      setOverrides((current) => ({
        ...current,
        [key]: { ...current[key], ...patch },
      }));
    setErrors((current) => {
      if (!(key in current.lines)) return current;
      const next = { ...current.lines };
      delete next[key];
      return { ...current, lines: next };
    });
    touch();
  }

  function clearError(field: keyof Omit<InvoiceEntryErrors, "lines">) {
    setErrors((current) =>
      current[field] ? { ...current, [field]: undefined } : current,
    );
    touch();
  }

  function submit() {
    if (!outletId || !purchaseOrder || inFlight.current) return;
    const built = buildInvoiceInput(
      {
        outletId,
        supplierId: purchaseOrder.supplierId,
        purchaseOrderId: orderId,
        number,
        invoiceDate,
        dueDate,
        lines,
        ppn,
        pph23,
      },
      newIdempotencyKey(),
    );
    if (!built.ok) {
      setErrors(built.errors);
      setFormError(t("inventoryInvoiceEntry.errors.summary"));
      setFocusTick((value) => value + 1);
      return;
    }
    setErrors({ lines: {} });
    setFormError(undefined);
    // One key per attempt: a retry of the same payload after a network error
    // reuses it, so the API cannot book the invoice twice. The key stays out of
    // the signature; a changed payload gets a new one.
    const idempotencyKey = attempt.keyFor({
      ...built.payload,
      idempotencyKey: undefined,
    });
    inFlight.current = true;
    createInvoice.mutate(
      { ...built.payload, idempotencyKey },
      {
        onSuccess: (response) => {
          attempt.settle();
          toast({
            title: t("inventoryInvoiceEntry.created"),
            tone: "success",
          });
          setCreatedId(response.data.invoice.id);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
            const details = error.details ?? [];
            const detailText =
              details.length > 0
                ? details
                    .map((detail) => `${detail.field}: ${detail.message}`)
                    .join("; ")
                : error.message;
            setFormError(
              [
                t(
                  details.some((detail) => TAX_FIELD.test(detail.field))
                    ? "inventoryInvoiceEntry.errors.serverRejectedTax"
                    : "inventoryInvoiceEntry.errors.serverRejected",
                ),
                detailText,
              ]
                .filter(Boolean)
                .join(" "),
            );
          } else
            setFormError(
              t(
                receivingErrorKey(
                  error instanceof ApiError ? error.code : undefined,
                ),
              ),
            );
          setFocusTick((value) => value + 1);
        },
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  }

  const loading =
    Boolean(outletId) &&
    (orders.isPending ||
      suppliers.isPending ||
      items.isPending ||
      uoms.isPending ||
      (orderId !== "" && (order.isPending || prior.isPending)));
  const failed =
    orders.isError ||
    suppliers.isError ||
    items.isError ||
    uoms.isError ||
    order.isError ||
    prior.isError;

  const backLink = (
    <Link
      to="/kelola/pengadaan/faktur"
      className="inline-flex w-fit items-center gap-1 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {t("inventoryInvoiceEntry.back")}
    </Link>
  );

  if (createdId)
    return (
      <div className="grid min-w-0 gap-4 pb-2">
        <div className="grid gap-1">
          {backLink}
          <h2
            ref={savedHeadingRef}
            tabIndex={-1}
            className="type-title flex items-center gap-2 outline-none"
          >
            <CircleCheck
              className="size-5 shrink-0 text-success"
              aria-hidden="true"
            />
            {t("inventoryInvoiceEntry.next.title")}
          </h2>
          <p role="status" className="sr-only">
            {t("inventoryInvoiceEntry.created")}
          </p>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("inventoryInvoiceEntry.next.description")}
          </p>
        </div>
        <InvoiceMatchPreview invoiceId={createdId} />
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <Link to="/kelola/pengadaan/faktur">
              {t("inventoryInvoiceEntry.next.toList")}
            </Link>
          </Button>
          <Button type="button" variant="outline" onClick={onAnother}>
            <FilePlus2 aria-hidden="true" />
            {t("inventoryInvoiceEntry.next.another")}
          </Button>
        </div>
      </div>
    );

  if (!outletId)
    return (
      <div className="rounded-container border bg-card">
        <EmptyState
          icon={Store}
          title={t("inventoryInvoiceEntry.noOutlet")}
          description={t("inventoryInvoiceEntry.noOutletHint")}
        />
      </div>
    );

  if (loading)
    return (
      <div aria-busy="true" className="grid gap-3">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-row" />
        <Skeleton className="h-48" />
      </div>
    );

  if (failed)
    return (
      <ErrorState
        description={
          typeof navigator !== "undefined" && !navigator.onLine
            ? t("inventoryReceiving.offline")
            : undefined
        }
        onRetry={() => {
          void orders.refetch();
          void suppliers.refetch();
          void items.refetch();
          void uoms.refetch();
          void order.refetch();
          prior.refetch();
        }}
      />
    );

  return (
    <div ref={rootRef} className="grid min-w-0 gap-4 pb-2">
      <div className="grid gap-1">
        {backLink}
        <h2 className="type-title">{t("inventoryInvoiceEntry.title")}</h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("inventoryInvoiceEntry.subtitle")}
        </p>
      </div>

      {eligibleOrders.length === 0 ? (
        <div className="rounded-container border bg-card">
          <EmptyState
            icon={PackageCheck}
            title={t("inventoryInvoiceEntry.noOrders")}
            description={t("inventoryInvoiceEntry.noOrdersHint")}
            action={
              <Button asChild variant="outline">
                <Link to="/kelola/pengadaan/penerimaan">
                  {t("inventoryInvoiceEntry.goToReceiving")}
                </Link>
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid min-w-0 gap-4">
          <Card className="gap-4">
            <FormField label={t("inventoryInvoiceEntry.header.order")} required>
              <Select value={orderId} onValueChange={requestOrder}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("inventoryInvoiceEntry.header.order")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {eligibleOrders.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {`${candidate.number} · ${supplierNameOf(
                        suppliers.data?.data ?? [],
                        candidate.supplierId,
                      )}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <div className="grid gap-1 rounded-container bg-surface-2 p-3 text-sm">
              <p className="type-eyebrow">
                {t("inventoryInvoiceEntry.header.supplier")}
              </p>
              <p className="font-medium">
                {supplierNameOf(
                  suppliers.data?.data ?? [],
                  purchaseOrder?.supplierId ?? "",
                )}
              </p>
            </div>
            <FormField
              label={t("inventoryInvoiceEntry.header.number")}
              error={
                errors.number
                  ? t(
                      errors.number === "required"
                        ? "inventoryInvoiceEntry.errors.numberRequired"
                        : ERROR_KEY[errors.number],
                    )
                  : undefined
              }
              required
            >
              <Input
                name="invoiceNumber"
                className={FIELD_CLASS}
                value={number}
                onChange={(event) => {
                  setNumber(event.target.value);
                  clearError("number");
                }}
                onBlur={(event) =>
                  setFieldError(
                    "number",
                    event.target.value.trim() === "" ? "required" : undefined,
                  )
                }
                maxLength={60}
                autoComplete="off"
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label={t("inventoryInvoiceEntry.header.invoiceDate")}
                error={
                  errors.invoiceDate
                    ? t(ERROR_KEY[errors.invoiceDate])
                    : undefined
                }
                required
              >
                <Input
                  type="date"
                  name="invoiceDate"
                  className={FIELD_CLASS}
                  value={invoiceDate}
                  onChange={(event) => {
                    setInvoiceDate(event.target.value);
                    clearError("invoiceDate");
                  }}
                  onBlur={(event) =>
                    setFieldError(
                      "invoiceDate",
                      event.target.value === "" ? "required" : undefined,
                    )
                  }
                />
              </FormField>
              <FormField
                label={t("inventoryInvoiceEntry.header.dueDate")}
                hint={t("inventoryInvoiceEntry.header.dueHint")}
                error={
                  errors.dueDate ? t(ERROR_KEY[errors.dueDate]) : undefined
                }
                required
              >
                <Input
                  type="date"
                  name="dueDate"
                  className={FIELD_CLASS}
                  value={dueDate}
                  onChange={(event) => {
                    setDueInput(event.target.value);
                    clearError("dueDate");
                  }}
                  onBlur={(event) =>
                    setFieldError(
                      "dueDate",
                      event.target.value === ""
                        ? "required"
                        : invoiceDate !== "" && event.target.value < invoiceDate
                          ? "dueBeforeInvoice"
                          : undefined,
                    )
                  }
                />
              </FormField>
            </div>
          </Card>

          <section className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base leading-6 font-semibold">
                {t("inventoryInvoiceEntry.lines.title")}
              </h3>
              <Badge tone="neutral">
                {t("inventoryInvoiceEntry.lines.count", {
                  count: includedCount,
                })}
              </Badge>
            </div>
            {errors.form && (
              <p
                role="alert"
                tabIndex={-1}
                data-form-error
                className="flex items-start gap-1.5 text-sm font-medium text-danger outline-none"
              >
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {t(ERROR_KEY[errors.form])}
              </p>
            )}
            {lines.map((line) => {
              const lineErrors = errors.lines[line.key] ?? {};
              const orderLine = orderLines.find(
                (candidate) => candidate.id === line.purchaseOrderLineId,
              );
              const unit = orderLine
                ? uomCodeOf(uoms.data?.data ?? [], orderLine.uomId)
                : "";
              const checkId = `invoice-line-${line.key}`;
              return (
                <div
                  key={line.key}
                  className="grid gap-3 rounded-container border bg-card p-card shadow-hairline"
                >
                  {orderLine ? (
                    <>
                      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1">
                        <Label
                          htmlFor={checkId}
                          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 font-semibold"
                        >
                          <Checkbox
                            id={checkId}
                            name={`lines.${line.key}.included`}
                            className={FIELD_CLASS}
                            checked={line.included}
                            onCheckedChange={(checked) =>
                              updateLine(line.key, {
                                included: checked === true,
                              })
                            }
                          />
                          {itemNameOf(
                            items.data?.data ?? [],
                            orderLine.inventoryItemId,
                          )}
                        </Label>
                        {!line.included && (
                          <span className="text-sm text-muted-foreground">
                            {t("inventoryInvoiceEntry.lines.exclude")}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-sm">
                        <div>
                          <p className="type-eyebrow">
                            {t("inventoryInvoiceEntry.lines.ordered")}
                          </p>
                          <p className="tabular">
                            {`${formatQuantity(orderLine.quantity)} ${unit}`}
                          </p>
                        </div>
                        <div>
                          <p className="type-eyebrow">
                            {t("inventoryInvoiceEntry.lines.accepted")}
                          </p>
                          <p className="tabular">
                            {`${formatQuantity(
                              acceptedReceivedQuantity(
                                prior.lines,
                                orderLine.id,
                              ),
                            )} ${unit}`}
                          </p>
                        </div>
                        <div>
                          <p className="type-eyebrow">
                            {t("inventoryInvoiceEntry.lines.poPrice")}
                          </p>
                          <p className="tabular">
                            {formatIdrDecimalText(orderLine.unitPriceIdr)}
                          </p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold">
                        {t("inventoryInvoiceEntry.lines.serviceTitle")}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t(
                          "inventoryInvoiceEntry.lines.removeServiceLabel",
                          {
                            index:
                              serviceLines.findIndex(
                                (candidate) => candidate.key === line.key,
                              ) + 1,
                          },
                        )}
                        onClick={() => requestRemoveService(line)}
                      >
                        <Trash2 aria-hidden="true" />
                        {t("inventoryInvoiceEntry.lines.removeService")}
                      </Button>
                    </div>
                  )}
                  {line.included && (
                    <>
                      <FormField
                        label={t("inventoryInvoiceEntry.lines.description")}
                        error={
                          lineErrors.description
                            ? t(ERROR_KEY[lineErrors.description])
                            : undefined
                        }
                        required
                      >
                        <Input
                          name={`lines.${line.key}.description`}
                          className={FIELD_CLASS}
                          value={line.description}
                          onChange={(event) =>
                            updateLine(line.key, {
                              description: event.target.value,
                            })
                          }
                          onBlur={(event) =>
                            setLineFieldError(
                              line.key,
                              "description",
                              event.target.value.trim() === ""
                                ? "required"
                                : undefined,
                            )
                          }
                          maxLength={200}
                          autoComplete="off"
                        />
                      </FormField>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <FormField
                          label={t("inventoryInvoiceEntry.lines.quantity")}
                          hint={t("inventoryInvoiceEntry.lines.quantityHint")}
                          error={
                            lineErrors.quantity
                              ? t(ERROR_KEY[lineErrors.quantity])
                              : undefined
                          }
                          required
                        >
                          <UnitInput
                            name={`lines.${line.key}.quantity`}
                            className={FIELD_CLASS}
                            unit={unit}
                            value={line.quantity}
                            onChange={(event) =>
                              updateLine(line.key, {
                                quantity: event.target.value,
                              })
                            }
                            onBlur={(event) =>
                              setLineFieldError(
                                line.key,
                                "quantity",
                                invoiceQuantityFromInput(event.target.value) ===
                                  null
                                  ? "invalidQuantity"
                                  : undefined,
                              )
                            }
                            inputMode="decimal"
                            autoComplete="off"
                          />
                        </FormField>
                        <FormField
                          label={t("inventoryInvoiceEntry.lines.unitPrice")}
                          hint={t("inventoryInvoiceEntry.lines.unitPriceHint")}
                          error={
                            lineErrors.unitPrice
                              ? t(ERROR_KEY[lineErrors.unitPrice])
                              : undefined
                          }
                          required
                        >
                          <Input
                            name={`lines.${line.key}.unitPrice`}
                            className={FIELD_CLASS}
                            value={line.unitPrice}
                            onChange={(event) =>
                              updateLine(line.key, {
                                unitPrice: event.target.value,
                              })
                            }
                            onBlur={(event) =>
                              setLineFieldError(
                                line.key,
                                "unitPrice",
                                invoicePriceFromInput(event.target.value) ===
                                  null
                                  ? "invalidPrice"
                                  : undefined,
                              )
                            }
                            inputMode="decimal"
                            autoComplete="off"
                          />
                        </FormField>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            <div className="grid gap-1">
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                onClick={() => {
                  setServiceLines((current) => [
                    ...current,
                    newServiceDraft(newIdempotencyKey()),
                  ]);
                  touch();
                }}
              >
                <Plus aria-hidden="true" />
                {t("inventoryInvoiceEntry.lines.addService")}
              </Button>
              <p className="text-sm text-muted-foreground">
                {t("inventoryInvoiceEntry.lines.serviceHint")}
              </p>
            </div>
          </section>

          <Card className="gap-4">
            <h3 className="text-base leading-6 font-semibold">
              {t("inventoryInvoiceEntry.tax.title")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("inventoryInvoiceEntry.tax.hint")}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label={t("inventoryInvoiceEntry.tax.ppn")}
                hint={t("inventoryInvoiceEntry.tax.ppnHint")}
                error={errors.ppn ? t(ERROR_KEY[errors.ppn]) : undefined}
              >
                <Input
                  name="ppnIdr"
                  className={FIELD_CLASS}
                  value={ppn}
                  onChange={(event) => {
                    setPpn(event.target.value);
                    clearError("ppn");
                  }}
                  onBlur={(event) =>
                    setFieldError(
                      "ppn",
                      invoiceAmountFromInput(event.target.value) === null
                        ? "invalidAmount"
                        : undefined,
                    )
                  }
                  inputMode="numeric"
                  autoComplete="off"
                />
              </FormField>
              <FormField
                label={t("inventoryInvoiceEntry.tax.pph23")}
                hint={t("inventoryInvoiceEntry.tax.pph23Hint")}
                error={errors.pph23 ? t(ERROR_KEY[errors.pph23]) : undefined}
              >
                <Input
                  name="pph23Idr"
                  className={FIELD_CLASS}
                  value={pph23}
                  onChange={(event) => {
                    setPph23(event.target.value);
                    clearError("pph23");
                  }}
                  onBlur={(event) =>
                    setFieldError(
                      "pph23",
                      invoiceAmountFromInput(event.target.value) === null
                        ? "invalidAmount"
                        : undefined,
                    )
                  }
                  inputMode="numeric"
                  autoComplete="off"
                />
              </FormField>
            </div>
          </Card>

          {formError && (
            <p
              role="alert"
              tabIndex={-1}
              data-form-error
              className="flex items-start gap-1.5 text-sm font-medium text-danger outline-none"
            >
              <CircleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {formError}
            </p>
          )}

          <div
            data-slot="invoice-summary-bar"
            className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-container border bg-card p-card pb-[max(var(--card-pad),env(safe-area-inset-bottom))] shadow-card"
          >
            <div className="min-w-0">
              <p className="type-eyebrow">
                {t("inventoryInvoiceEntry.summary.title")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("inventoryInvoiceEntry.summary.lines", {
                  count: includedCount,
                })}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("inventoryInvoiceEntry.summary.note")}
              </p>
            </div>
            <Button
              type="button"
              loading={createInvoice.isPending}
              onClick={submit}
            >
              <FilePlus2 aria-hidden="true" />
              {t("inventoryInvoiceEntry.submit")}
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                confirm?.kind === "service"
                  ? "inventoryInvoiceEntry.confirm.serviceTitle"
                  : "inventoryInvoiceEntry.confirm.orderTitle",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                confirm?.kind === "service"
                  ? "inventoryInvoiceEntry.confirm.serviceDescription"
                  : "inventoryInvoiceEntry.confirm.orderDescription",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirm(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (confirm?.kind === "order") chooseOrder(confirm.value);
                else if (confirm?.kind === "service")
                  removeService(confirm.key);
                setConfirm(null);
              }}
            >
              {t(
                confirm?.kind === "service"
                  ? "inventoryInvoiceEntry.confirm.serviceAction"
                  : "inventoryInvoiceEntry.confirm.orderAction",
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
