// Record a waste/spoilage entry (PRD §16 "Waste & Spoilage", §6.E): target
// (ingredient or menu portion), quantity, standard reason, optional photo.
// The loss value is never typed by the user: the server values it from the
// moving-average cost (INV: "nilai kerugian").
import * as React from "react";
import { parseDecimal4 } from "@starter/shared/core";
import type { WasteReason, WasteTargetType } from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { normalizeImageFile, uploadStorageFile } from "@/features/storage/api";
import { useTenantContext } from "@/lib/tenant-context";
import { useInventoryItems, useStockLocations, useUnits } from "../hooks";
import { useCreateWasteLog, useMenuItems } from "../opname-hooks";
import { LIST_LIMIT } from "../lib";
import { WASTE_REASONS, wasteReasonKey } from "../opname-lib";
import { PhotoField, photoUploadErrorKey } from "./photo-field";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

const QTY_PATTERN = /^\d{1,10}(\.\d{1,4})?$/;

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function WasteFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const { outlet } = useTenantContext();
  const items = useInventoryItems({ limit: LIST_LIMIT });
  const menu = useMenuItems();
  const units = useUnits({ limit: LIST_LIMIT });
  const locations = useStockLocations(outlet?.id);
  const createWaste = useCreateWasteLog();

  const [targetType, setTargetType] =
    React.useState<WasteTargetType>("inventory_item");
  const [targetId, setTargetId] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [locationId, setLocationId] = React.useState("");
  const [reason, setReason] = React.useState<WasteReason | "">("");
  const [note, setNote] = React.useState("");
  const [photo, setPhoto] = React.useState<File | null>(null);
  const [mediaId, setMediaId] = React.useState<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const uploadController = React.useRef<AbortController | null>(null);
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string>();
  const idempotencyKey = React.useRef(newIdempotencyKey());

  const activeItems = React.useMemo(
    () =>
      (items.data?.data ?? [])
        .filter((item) => item.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
    [items.data],
  );
  const menuItems = React.useMemo(
    () =>
      [...(menu.data?.data ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, "id-ID"),
      ),
    [menu.data],
  );
  const unitCode = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const unit of units.data?.data ?? []) map.set(unit.id, unit.code);
    return map;
  }, [units.data]);
  const locationRows = React.useMemo(
    () => locations.data?.data ?? [],
    [locations.data],
  );

  const effectiveLocationId =
    locationId !== "" ? locationId : (locationRows[0]?.id ?? "");
  const selectedItem = activeItems.find((item) => item.id === targetId);
  const unit =
    targetType === "inventory_item"
      ? selectedItem
        ? unitCode.get(selectedItem.baseUomId)
        : undefined
      : t("waste.unit.portion");

  React.useEffect(() => {
    if (!open) {
      uploadController.current?.abort();
      uploadController.current = null;
      setIsUploading(false);
      return;
    }
    idempotencyKey.current = newIdempotencyKey();
  }, [open]);

  React.useEffect(() => () => uploadController.current?.abort(), []);

  function resetForm() {
    setTargetType("inventory_item");
    setTargetId("");
    setQuantity("");
    setReason("");
    setNote("");
    uploadController.current?.abort();
    uploadController.current = null;
    setPhoto(null);
    setMediaId(null);
    setIsUploading(false);
    setErrors({});
    setFormError(undefined);
  }

  function close() {
    resetForm();
    onOpenChange(false);
  }

  async function pickPhoto(file: File) {
    uploadController.current?.abort();
    uploadController.current = null;
    setIsUploading(false);
    setMediaId(null);
    setPhoto(file);
    if (!outlet) return;
    const controller = new AbortController();
    uploadController.current = controller;
    setIsUploading(true);
    setErrors((current) => {
      const next = { ...current };
      delete next.photo;
      return next;
    });
    try {
      const uploaded = await uploadStorageFile({
        purpose: "receipt",
        sourceKind: "waste_log",
        outletId: outlet.id,
        file: await normalizeImageFile(file),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setMediaId(uploaded.id);
    } catch (error) {
      if (controller.signal.aborted) return;
      setErrors((current) => ({
        ...current,
        photo: t(photoUploadErrorKey(error)),
      }));
    } finally {
      if (uploadController.current === controller) {
        uploadController.current = null;
        setIsUploading(false);
      }
    }
  }

  function clearPhoto() {
    uploadController.current?.abort();
    uploadController.current = null;
    setPhoto(null);
    setMediaId(null);
    setIsUploading(false);
    setErrors((current) => ({ ...current, photo: undefined }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (isUploading || createWaste.isPending || (photo && !mediaId)) return;
    const nextErrors: Record<string, string | undefined> = {};
    if (effectiveLocationId === "")
      nextErrors.location = t("waste.form.errorLocation");
    if (targetId === "") nextErrors.target = t("waste.form.errorTarget");
    const normalized = quantity.trim().replace(",", ".");
    if (!QTY_PATTERN.test(normalized) || parseDecimal4(normalized) <= 0n)
      nextErrors.quantity = t("waste.form.errorQuantity");
    if (reason === "") nextErrors.reason = t("waste.form.errorReason");
    setErrors(nextErrors);
    if (!outlet || Object.values(nextErrors).some(Boolean)) return;

    setFormError(undefined);
    createWaste.mutate(
      {
        outletId: outlet.id,
        locationId: effectiveLocationId,
        targetType,
        targetId,
        quantity: normalized,
        reason: reason as WasteReason,
        mediaId,
        note: note.trim() === "" ? null : note.trim(),
        idempotencyKey: idempotencyKey.current,
      },
      {
        onSuccess: () => {
          toast({
            title: t("waste.form.successTitle"),
            description: t("waste.form.successBody"),
            tone: "success",
          });
          close();
        },
        onError: (error) =>
          setFormError(errorText(error, t("waste.form.errorSubmit"))),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isUploading || createWaste.isPending) return;
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("waste.form.title")}</DialogTitle>
          <DialogDescription>{t("waste.form.description")}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField label={t("waste.form.targetType")} required>
            <SegmentedControl
              value={targetType}
              onValueChange={(value) => {
                setTargetType(value);
                setTargetId("");
              }}
              label={t("waste.form.targetType")}
              options={[
                {
                  value: "inventory_item",
                  label: t("waste.target.inventory_item"),
                },
                { value: "menu_item", label: t("waste.target.menu_item") },
              ]}
            />
          </FormField>

          <FormField
            label={
              targetType === "inventory_item"
                ? t("waste.form.item")
                : t("waste.form.menu")
            }
            id="waste-target"
            error={errors.target}
            required
          >
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger id="waste-target">
                <SelectValue
                  placeholder={
                    targetType === "inventory_item"
                      ? t("waste.form.itemPlaceholder")
                      : t("waste.form.menuPlaceholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {targetType === "inventory_item"
                  ? activeItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))
                  : menuItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
          </FormField>
          {(targetType === "inventory_item" ? activeItems : menuItems)
            .length === 0 && (
            <p className="text-sm text-muted-foreground">
              {targetType === "inventory_item"
                ? t("waste.form.noItems")
                : t("waste.form.noMenu")}
            </p>
          )}

          <FormField
            label={
              unit
                ? `${t("waste.form.quantity")} (${unit})`
                : t("waste.form.quantity")
            }
            id="waste-quantity"
            hint={t("waste.form.quantityHint")}
            error={errors.quantity}
            required
          >
            <Input
              id="waste-quantity"
              inputMode="decimal"
              autoComplete="off"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("waste.form.location")}
              id="waste-location"
              hint={t("waste.form.locationHint")}
              error={errors.location}
              required
            >
              <Select value={effectiveLocationId} onValueChange={setLocationId}>
                <SelectTrigger id="waste-location">
                  <SelectValue
                    placeholder={t("waste.form.locationPlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {locationRows.map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("waste.form.reason")}
              id="waste-reason"
              error={errors.reason}
              required
            >
              <Select
                value={reason}
                onValueChange={(value) => setReason(value as WasteReason)}
              >
                <SelectTrigger id="waste-reason">
                  <SelectValue
                    placeholder={t("waste.form.reasonPlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {WASTE_REASONS.map((row) => (
                    <SelectItem key={row} value={row}>
                      {t(wasteReasonKey(row))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField
            label={t("waste.form.note")}
            id="waste-note"
            hint={t("waste.form.noteHint")}
          >
            <Textarea
              id="waste-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={300}
              rows={2}
            />
          </FormField>

          <PhotoField
            mediaId={mediaId}
            isUploading={isUploading}
            disabled={!outlet || createWaste.isPending}
            error={errors.photo}
            onSelect={pickPhoto}
            onClear={clearPhoto}
            onRetry={photo ? () => void pickPhoto(photo) : undefined}
          />

          {formError && (
            <p role="alert" className="text-sm font-medium text-danger">
              {formError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={isUploading || createWaste.isPending}
            >
              {t("waste.form.cancel")}
            </Button>
            <Button
              type="submit"
              loading={createWaste.isPending || isUploading}
              disabled={!outlet || isUploading || Boolean(photo && !mediaId)}
            >
              {t("waste.form.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
