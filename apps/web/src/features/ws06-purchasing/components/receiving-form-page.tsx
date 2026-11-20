// Phone-first goods receipt form (PRD v1.7 §16 "penerimaan di ponsel", §3 F18,
// INV-05): pick an approved/sent/partially received PO, then record per line
// the quantity received, the QC-rejected quantity and the reason. Only the
// accepted quantity enters stock, and the cumulative accepted quantity may
// never exceed the ordered quantity (`assertGoodsReceiptMatchesOrder` in the
// contract; the mock and API enforce the same rule).
//
// Photo evidence is uploaded before saving; receipts only receive storage ids.
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, PackageCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { useTenantContext } from "@/lib/tenant-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { formatDecimal4, parseDecimal4 } from "@starter/shared/core";
import type { Decimal4 } from "@starter/shared/core";
import {
  acceptedReceivedQuantity,
  goodsReceiptValueIdr,
} from "@starter/shared/inventory";
import type { PurchaseOrderLine } from "@starter/shared/inventory";
import {
  PhotoField,
  photoUploadErrorKey,
} from "../../ws06-inventory/components/photo-field.tsx";
import { normalizeImageFile } from "../../storage/api.ts";
import { useUploadStorageFile } from "../../storage/hooks.ts";
import { quantityFromInput } from "../../ws06-inventory/lib.ts";
import {
  useAttemptKey,
  useCreateGoodsReceipt,
  useReceiptLinesForOrder,
} from "../receiving-hooks.ts";
import {
  bonusFlagOf,
  formatBusinessDate,
  isZeroPriceLine,
  formatQuantityWithUnit,
  itemNameOf,
  receivingErrorKey,
  rejectedQuantityFromInput,
  remainingQuantity,
  supplierNameOf,
  todayBusinessDate,
  uomCodeOf,
} from "../receiving-lib.ts";
import {
  useInventoryItems,
  usePurchaseOrder,
  usePurchaseOrders,
  useStockLocations,
  useSuppliers,
  useUoms,
} from "../hooks.ts";

const RECEIVABLE_STATUSES = ["approved", "sent", "partially_received"] as const;

type LineDraft = {
  received: string;
  rejected: string;
  reason: string;
  batchCode: string;
  expiresOn: string;
  locationId: string;
  isBonus: boolean;
};

function emptyDraft(locationId: string): LineDraft {
  return {
    received: "",
    rejected: "",
    reason: "",
    batchCode: "",
    expiresOn: "",
    locationId,
    isBonus: false,
  };
}

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh form, so a
 * chosen order or line draft of the previous outlet cannot leak.
 */
export function ReceivingFormPage() {
  const { outlet } = useTenantContext();
  return <ReceivingFormContent key={outlet?.id ?? "none"} />;
}

function ReceivingFormContent() {
  const t = useT();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const outletId = outlet?.id ?? "";
  const toast = useToast();
  const navigate = useNavigate();
  const attempt = useAttemptKey();
  const createReceipt = useCreateGoodsReceipt();
  const uploadPhoto = useUploadStorageFile();

  const orders = usePurchaseOrders(outletId);
  const suppliers = useSuppliers();
  const items = useInventoryItems();
  const locations = useStockLocations(outletId);
  const uoms = useUoms();

  const eligibleOrders = React.useMemo(
    () =>
      (orders.data?.data ?? []).filter((order) =>
        RECEIVABLE_STATUSES.includes(
          order.status as (typeof RECEIVABLE_STATUSES)[number],
        ),
      ),
    [orders.data],
  );
  const [orderChoice, setOrderChoice] = React.useState("");
  const orderId = orderChoice || eligibleOrders[0]?.id || "";
  const order = usePurchaseOrder(orderId);
  const prior = useReceiptLinesForOrder(outletId, orderId);

  const activeLocations = React.useMemo(
    () => (locations.data?.data ?? []).filter((location) => location.isActive),
    [locations.data],
  );
  const defaultLocationId = activeLocations[0]?.id ?? "";
  const [drafts, setDrafts] = React.useState<Record<string, LineDraft>>({});
  const [lineErrors, setLineErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [formError, setFormError] = React.useState<string | undefined>();
  const [photoMediaId, setPhotoMediaId] = React.useState<string | null>(null);
  const [photoFile, setPhotoFile] = React.useState<File | null>(null);
  const [isPhotoUploading, setIsPhotoUploading] = React.useState(false);
  const [photoError, setPhotoError] = React.useState<string | undefined>();
  const photoUploadController = React.useRef<AbortController | null>(null);
  const [receivedOn, setReceivedOn] = React.useState(() => todayBusinessDate());
  const [qcNotes, setQcNotes] = React.useState("");
  const [note, setNote] = React.useState("");

  React.useEffect(() => () => photoUploadController.current?.abort(), []);

  function chooseOrder(value: string) {
    setOrderChoice(value);
    setDrafts({});
    setLineErrors({});
    setFormError(undefined);
  }

  const draftFor = (lineId: string): LineDraft =>
    drafts[lineId] ?? emptyDraft(defaultLocationId);

  function updateDraft(lineId: string, patch: Partial<LineDraft>) {
    setDrafts((current) => ({
      ...current,
      [lineId]: { ...draftFor(lineId), ...patch },
    }));
    setLineErrors((current) => {
      if (!(lineId in current)) return current;
      const next = { ...current };
      delete next[lineId];
      return next;
    });
    setFormError(undefined);
  }

  async function selectPhoto(file: File) {
    if (!outlet) return;
    photoUploadController.current?.abort();
    const controller = new AbortController();
    photoUploadController.current = controller;
    setPhotoFile(file);
    setPhotoMediaId(null);
    setPhotoError(undefined);
    setIsPhotoUploading(true);
    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        throw new ApiError(0, "NETWORK_ERROR", "offline");
      }
      const fileToUpload = await normalizeImageFile(file);
      if (controller.signal.aborted) return;
      const object = await uploadPhoto.mutateAsync({
        purpose: "goods_receipt_photo",
        sourceKind: "goods_receipt",
        outletId: outlet.id,
        file: fileToUpload,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPhotoMediaId(object.id);
    } catch (error) {
      if (!controller.signal.aborted) {
        setPhotoError(t(photoUploadErrorKey(error)));
      }
    } finally {
      if (!controller.signal.aborted) setIsPhotoUploading(false);
    }
  }

  function clearPhoto() {
    photoUploadController.current?.abort();
    setPhotoMediaId(null);
    setPhotoFile(null);
    setPhotoError(undefined);
    setIsPhotoUploading(false);
  }

  const orderLines = React.useMemo(
    () => order.data?.data.lines ?? [],
    [order.data],
  );
  const orderSupplierName = order.data
    ? supplierNameOf(
        suppliers.data?.data ?? [],
        order.data.data.purchaseOrder.supplierId,
      )
    : "—";

  const summary = React.useMemo(() => {
    const parsed: {
      quantityReceived: Decimal4;
      quantityRejected: Decimal4;
      unitCostIdr: Decimal4;
    }[] = [];
    for (const line of orderLines) {
      const draft = drafts[line.id];
      if (!draft || draft.received.trim() === "") continue;
      const received = quantityFromInput(draft.received);
      const rejected = rejectedQuantityFromInput(draft.rejected);
      if (received === null || rejected === null) continue;
      if (parseDecimal4(rejected) > parseDecimal4(received)) continue;
      parsed.push({
        quantityReceived: received,
        quantityRejected: rejected,
        unitCostIdr: line.unitPriceIdr,
      });
    }
    return {
      count: parsed.length,
      valueIdr: goodsReceiptValueIdr(parsed, "half_up"),
    };
  }, [drafts, orderLines]);

  function submit() {
    if (!outletId || isPhotoUploading || photoError || createReceipt.isPending)
      return;
    const errors: Record<string, string> = {};
    const parsedLines: {
      line: PurchaseOrderLine;
      received: Decimal4;
      rejected: Decimal4;
      reason: string;
      batchCode: string | null;
      expiresOn: string | null;
      locationId: string;
      isBonus: boolean;
    }[] = [];
    if (orderId === "") {
      setFormError(t("inventoryReceiving.receiving.form.errorOrder"));
      return;
    }
    for (const line of orderLines) {
      const draft = draftFor(line.id);
      if (draft.received.trim() === "") continue;
      const received = quantityFromInput(draft.received);
      if (received === null) {
        errors[line.id] = t("inventoryReceiving.receiving.form.errorQuantity");
        continue;
      }
      const rejected = rejectedQuantityFromInput(draft.rejected);
      if (rejected === null) {
        errors[line.id] = t("inventoryReceiving.receiving.form.errorQuantity");
        continue;
      }
      if (parseDecimal4(rejected) > parseDecimal4(received)) {
        errors[line.id] = t(
          "inventoryReceiving.receiving.form.errorRejectedOverReceived",
        );
        continue;
      }
      const already = acceptedReceivedQuantity(prior.lines, line.id);
      const remaining = remainingQuantity(line.quantity, already);
      // INV-05 (`assertGoodsReceiptMatchesOrder`): the cap is on the accepted
      // quantity (received − QC-rejected), not on what arrived at the door.
      if (
        parseDecimal4(received) - parseDecimal4(rejected) >
        parseDecimal4(remaining)
      ) {
        errors[line.id] = t(
          "inventoryReceiving.receiving.form.errorOverRemaining",
        );
        continue;
      }
      if (parseDecimal4(rejected) > 0n && draft.reason.trim() === "") {
        errors[line.id] = t("inventoryReceiving.receiving.form.errorReason");
        continue;
      }
      if (draft.expiresOn !== "" && draft.batchCode.trim() === "") {
        errors[line.id] = t("inventoryReceiving.receiving.form.errorExpiry");
        continue;
      }
      if (draft.locationId === "") {
        errors[line.id] = t("inventoryReceiving.common.emptyValue");
        continue;
      }
      if (
        isZeroPriceLine(line) &&
        !draft.isBonus &&
        parseDecimal4(received) > parseDecimal4(rejected)
      ) {
        errors[line.id] = t(
          "inventoryReceiving.receiving.form.errorBonusRequired",
        );
        continue;
      }
      parsedLines.push({
        line,
        received,
        rejected,
        reason: draft.reason.trim(),
        batchCode:
          draft.batchCode.trim() === "" ? null : draft.batchCode.trim(),
        expiresOn: draft.expiresOn === "" ? null : draft.expiresOn,
        locationId: draft.locationId,
        isBonus: draft.isBonus,
      });
    }
    setLineErrors(errors);
    if (Object.keys(errors).length > 0) {
      setFormError(t("inventoryReceiving.errors.invalid"));
      return;
    }
    if (parsedLines.length === 0) {
      setFormError(t("inventoryReceiving.receiving.form.errorNoLines"));
      return;
    }
    const rejectionNotes = parsedLines
      .filter((line) => parseDecimal4(line.rejected) > 0n)
      .map((line) => {
        const item = itemNameOf(
          items.data?.data ?? [],
          line.line.inventoryItemId,
        );
        const unit = uomCodeOf(uoms.data?.data ?? [], line.line.uomId);
        return t("inventoryReceiving.receiving.form.rejectionNote", {
          item,
          quantity: formatQuantityWithUnit(line.rejected, unit),
          reason: line.reason,
        });
      });
    const composedQcNotes = [qcNotes.trim(), ...rejectionNotes]
      .filter((part) => part !== "")
      .join("; ");
    if (composedQcNotes.length > 500) {
      setFormError(t("inventoryReceiving.receiving.form.errorQcNotes"));
      return;
    }
    if (note.trim().length > 300) {
      setFormError(t("inventoryReceiving.receiving.form.errorNote"));
      return;
    }
    setFormError(undefined);
    const payload = {
      outletId,
      purchaseOrderId: orderId,
      receivedOn: receivedOn === "" ? undefined : receivedOn,
      qcNotes: composedQcNotes === "" ? null : composedQcNotes,
      mediaIds: photoMediaId ? [photoMediaId] : [],
      note: note.trim() === "" ? null : note.trim(),
      lines: parsedLines.map((line) => ({
        purchaseOrderLineId: line.line.id,
        locationId: line.locationId,
        quantityReceived: line.received,
        quantityRejected: line.rejected,
        batchCode: line.batchCode,
        expiresOn: line.expiresOn,
        ...bonusFlagOf(line.line, line.isBonus),
      })),
    };
    createReceipt.mutate(
      { ...payload, idempotencyKey: attempt.keyFor(payload) },
      {
        onSuccess: () => {
          attempt.settle();
          toast({
            title: t("inventoryReceiving.receiving.form.created"),
            tone: "success",
          });
          void navigate({ to: "/kelola/pengadaan/penerimaan" });
        },
        onError: (error) => {
          setFormError(
            t(
              receivingErrorKey(
                error instanceof ApiError ? error.code : undefined,
              ),
            ),
          );
        },
      },
    );
  }

  const loading =
    Boolean(outletId) &&
    (orders.isPending ||
      suppliers.isPending ||
      items.isPending ||
      locations.isPending ||
      uoms.isPending ||
      (orderId !== "" && (order.isPending || prior.isPending)));
  const failed =
    orders.isError ||
    suppliers.isError ||
    items.isError ||
    locations.isError ||
    uoms.isError ||
    order.isError ||
    prior.isError;

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
          void locations.refetch();
          void uoms.refetch();
          void order.refetch();
          prior.refetch();
        }}
      />
    );

  if (activeLocations.length === 0)
    return (
      <EmptyState
        title={t("inventoryReceiving.receiving.form.title")}
        description={t("inventoryReceiving.receiving.form.subtitle")}
        action={
          <Button asChild variant="outline">
            <Link to="/kelola/inventori/lokasi">
              {t("inventory.locations.title")}
            </Link>
          </Button>
        }
      />
    );

  return (
    <div className="grid min-w-0 gap-4 pb-2">
      <div className="grid gap-1">
        <Link
          to="/kelola/pengadaan/penerimaan"
          className="inline-flex w-fit items-center gap-1 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("inventoryReceiving.common.back")}
        </Link>
        <h2 className="type-title">
          {t("inventoryReceiving.receiving.form.title")}
        </h2>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("inventoryReceiving.receiving.form.subtitle")}
        </p>
      </div>

      {eligibleOrders.length === 0 ? (
        <div className="rounded-container border bg-card">
          <EmptyState
            icon={PackageCheck}
            title={t("inventoryReceiving.receiving.form.noApprovedOrders")}
            description={t(
              "inventoryReceiving.receiving.form.noApprovedOrdersHint",
            )}
            action={
              <Button asChild variant="outline">
                <Link to="/kelola/pengadaan">{t("purchasing.title")}</Link>
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid min-w-0 gap-4">
          <Card className="gap-4">
            <FormField
              label={t("inventoryReceiving.receiving.form.chooseOrder")}
              required
            >
              <Select value={orderId} onValueChange={chooseOrder}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={t(
                      "inventoryReceiving.receiving.form.chooseOrder",
                    )}
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
            {order.data && (
              <div className="grid gap-2 rounded-container bg-surface-2 p-3 text-sm sm:grid-cols-3">
                <div>
                  <p className="type-eyebrow">
                    {t("inventoryReceiving.common.supplier")}
                  </p>
                  <p className="font-medium">{orderSupplierName}</p>
                </div>
                <div>
                  <p className="type-eyebrow">{t("purchasing.expectedDate")}</p>
                  <p>
                    {formatBusinessDate(
                      order.data.data.purchaseOrder.expectedDate,
                    )}
                  </p>
                </div>
                <div>
                  <p className="type-eyebrow">
                    {t("inventoryReceiving.common.status")}
                  </p>
                  <p>
                    {t(
                      order.data.data.purchaseOrder.status ===
                        "partially_received"
                        ? "purchasing.status.partially_received"
                        : order.data.data.purchaseOrder.status === "sent"
                          ? "purchasing.status.sent"
                          : "purchasing.status.approved",
                    )}
                  </p>
                </div>
              </div>
            )}
            <FormField
              label={t("inventoryReceiving.receiving.form.receivedOn")}
              required
            >
              <Input
                type="date"
                value={receivedOn}
                onChange={(event) => setReceivedOn(event.target.value)}
              />
            </FormField>
          </Card>

          <section className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base leading-6 font-semibold">
                {t("inventoryReceiving.receiving.detailLines")}
              </h3>
              <Badge tone="neutral">
                {t("inventoryReceiving.receiving.form.lineCount", {
                  count: orderLines.length,
                })}
              </Badge>
            </div>
            {orderLines.map((line) => {
              const draft = draftFor(line.id);
              const already = acceptedReceivedQuantity(prior.lines, line.id);
              const remaining = remainingQuantity(line.quantity, already);
              const received = quantityFromInput(draft.received);
              const rejected = rejectedQuantityFromInput(draft.rejected);
              const accepted =
                received !== null &&
                rejected !== null &&
                parseDecimal4(received) >= parseDecimal4(rejected)
                  ? formatDecimal4(
                      parseDecimal4(received) - parseDecimal4(rejected),
                    )
                  : null;
              const unit = uomCodeOf(uoms.data?.data ?? [], line.uomId);
              return (
                <div
                  key={line.id}
                  className="grid gap-3 rounded-container border bg-card p-card shadow-hairline"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {itemNameOf(
                          items.data?.data ?? [],
                          line.inventoryItemId,
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {order.data?.data.purchaseOrder.number ?? ""}
                      </p>
                    </div>
                    <Badge tone="info">
                      {t("inventoryReceiving.receiving.form.remaining")}{" "}
                      {formatQuantityWithUnit(remaining, unit)}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <p className="type-eyebrow">
                        {t("inventoryReceiving.receiving.form.ordered")}
                      </p>
                      <p className="tabular">
                        {formatQuantityWithUnit(line.quantity, unit)}
                      </p>
                    </div>
                    <div>
                      <p className="type-eyebrow">
                        {t("inventoryReceiving.receiving.form.alreadyReceived")}
                      </p>
                      <p className="tabular">
                        {formatQuantityWithUnit(already, unit)}
                      </p>
                    </div>
                    <div>
                      <p className="type-eyebrow">
                        {t("inventoryReceiving.receiving.form.acceptedNow")}
                      </p>
                      <p className="tabular font-semibold">
                        {accepted === null
                          ? "—"
                          : formatQuantityWithUnit(accepted, unit)}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField
                      label={t("inventoryReceiving.receiving.form.receivedNow")}
                      error={lineErrors[line.id]}
                      required
                    >
                      <Input
                        value={draft.received}
                        onChange={(event) =>
                          updateDraft(line.id, {
                            received: event.target.value,
                          })
                        }
                        inputMode="decimal"
                        autoComplete="off"
                      />
                    </FormField>
                    <FormField
                      label={t("inventoryReceiving.receiving.form.rejectedNow")}
                    >
                      <Input
                        value={draft.rejected}
                        onChange={(event) =>
                          updateDraft(line.id, {
                            rejected: event.target.value,
                          })
                        }
                        inputMode="decimal"
                        autoComplete="off"
                      />
                    </FormField>
                  </div>
                  <FormField
                    label={t(
                      "inventoryReceiving.receiving.form.rejectionReason",
                    )}
                    hint={t(
                      "inventoryReceiving.receiving.form.rejectionReasonHint",
                    )}
                  >
                    <Input
                      value={draft.reason}
                      onChange={(event) =>
                        updateDraft(line.id, { reason: event.target.value })
                      }
                      autoComplete="off"
                    />
                  </FormField>
                  {isZeroPriceLine(line) ? (
                    <div className="flex items-start gap-3 rounded-md border p-3">
                      <Checkbox
                        id={`receipt-bonus-${line.id}`}
                        checked={draft.isBonus}
                        onCheckedChange={(checked) =>
                          updateDraft(line.id, { isBonus: checked === true })
                        }
                      />
                      <div className="grid gap-1">
                        <Label htmlFor={`receipt-bonus-${line.id}`}>
                          {t("inventoryReceiving.receiving.form.bonus")}
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          {t("inventoryReceiving.receiving.form.bonusHint")}
                        </p>
                      </div>
                    </div>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-3">
                    <FormField
                      label={t("inventoryReceiving.receiving.form.batchCode")}
                    >
                      <Input
                        value={draft.batchCode}
                        onChange={(event) =>
                          updateDraft(line.id, {
                            batchCode: event.target.value,
                          })
                        }
                        autoComplete="off"
                      />
                    </FormField>
                    <FormField
                      label={t("inventoryReceiving.receiving.form.expiresOn")}
                    >
                      <Input
                        type="date"
                        value={draft.expiresOn}
                        onChange={(event) =>
                          updateDraft(line.id, {
                            expiresOn: event.target.value,
                          })
                        }
                      />
                    </FormField>
                    <FormField
                      label={t("inventoryReceiving.receiving.form.location")}
                      required
                    >
                      <Select
                        value={draft.locationId || defaultLocationId}
                        onValueChange={(value) =>
                          updateDraft(line.id, { locationId: value })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue
                            placeholder={t(
                              "inventoryReceiving.receiving.form.location",
                            )}
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
                  </div>
                </div>
              );
            })}
          </section>

          <Card className="gap-4">
            <PhotoField
              label={t("inventoryReceiving.receiving.form.photoSection")}
              hint={t("inventoryReceiving.receiving.form.photoHint")}
              mediaId={photoMediaId}
              isUploading={isPhotoUploading}
              disabled={createReceipt.isPending}
              error={photoError}
              onSelect={selectPhoto}
              onRetry={
                photoFile && photoError
                  ? () => void selectPhoto(photoFile)
                  : undefined
              }
              onClear={clearPhoto}
            />
            <FormField label={t("inventoryReceiving.receiving.form.qcNotes")}>
              <Textarea
                value={qcNotes}
                onChange={(event) => setQcNotes(event.target.value)}
                rows={2}
              />
            </FormField>
            <FormField label={t("inventoryReceiving.receiving.form.note")}>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
              />
            </FormField>
          </Card>

          {formError && (
            <p role="alert" className="text-sm font-medium text-danger">
              {formError}
            </p>
          )}

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-container border bg-card p-card shadow-card">
            <div className="min-w-0">
              <p className="type-eyebrow">
                {t("inventoryReceiving.receiving.form.summary")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("inventoryReceiving.receiving.form.summaryLines", {
                  count: summary.count,
                })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-right">
                <p className="type-eyebrow">
                  {t("inventoryReceiving.receiving.form.summaryValue")}
                </p>
                <Money amount={summary.valueIdr} size="lg" />
              </div>
              <Button
                type="button"
                loading={createReceipt.isPending}
                disabled={isPhotoUploading || Boolean(photoError)}
                onClick={submit}
              >
                <PackageCheck aria-hidden="true" />
                {t("inventoryReceiving.receiving.form.submit")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
