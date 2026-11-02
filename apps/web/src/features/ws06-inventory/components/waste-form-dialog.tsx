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
import { API_MOCK } from "@/lib/api/mock-flag";
import { ApiError } from "@/lib/api/errors";
import { useInventoryItems, useStockLocations, useUnits } from "../hooks";
import { useCreateWasteLog, useMenuItems } from "../opname-hooks";
import { LIST_LIMIT } from "../lib";
import { INVENTORY_OUTLET_ID } from "../outlet";
import { WASTE_REASONS, wasteReasonKey } from "../opname-lib";
import {
  PhotoField,
  WASTE_PHOTO_MAX_BYTES,
  WASTE_PHOTO_TYPES,
} from "./photo-field";

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
  const items = useInventoryItems({ limit: LIST_LIMIT });
  const menu = useMenuItems();
  const units = useUnits({ limit: LIST_LIMIT });
  const locations = useStockLocations();
  const createWaste = useCreateWasteLog();

  const [targetType, setTargetType] =
    React.useState<WasteTargetType>("inventory_item");
  const [targetId, setTargetId] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [locationId, setLocationId] = React.useState("");
  const [reason, setReason] = React.useState<WasteReason | "">("");
  const [note, setNote] = React.useState("");
  const [photo, setPhoto] = React.useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string>();
  const idempotencyKey = React.useRef(crypto.randomUUID());

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
    if (!open) return;
    idempotencyKey.current = crypto.randomUUID();
  }, [open]);

  React.useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  function resetForm() {
    setTargetType("inventory_item");
    setTargetId("");
    setQuantity("");
    setReason("");
    setNote("");
    setPhoto(null);
    setErrors({});
    setFormError(undefined);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
  }

  function close() {
    resetForm();
    onOpenChange(false);
  }

  function pickPhoto(file: File) {
    if (!WASTE_PHOTO_TYPES.includes(file.type)) {
      setErrors((current) => ({
        ...current,
        photo: t("waste.form.photoInvalid"),
      }));
      return;
    }
    if (file.size > WASTE_PHOTO_MAX_BYTES) {
      setErrors((current) => ({
        ...current,
        photo: t("waste.form.photoTooLarge"),
      }));
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPhoto(file);
    setPreviewUrl(URL.createObjectURL(file));
    setErrors((current) => {
      const next = { ...current };
      delete next.photo;
      return next;
    });
  }

  function clearPhoto() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPhoto(null);
    setPreviewUrl(null);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string | undefined> = {};
    if (effectiveLocationId === "")
      nextErrors.location = t("waste.form.errorLocation");
    if (targetId === "") nextErrors.target = t("waste.form.errorTarget");
    const normalized = quantity.trim().replace(",", ".");
    if (!QTY_PATTERN.test(normalized) || parseDecimal4(normalized) <= 0n)
      nextErrors.quantity = t("waste.form.errorQuantity");
    if (reason === "") nextErrors.reason = t("waste.form.errorReason");
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;

    setFormError(undefined);
    createWaste.mutate(
      {
        outletId: INVENTORY_OUTLET_ID,
        locationId: effectiveLocationId,
        targetType,
        targetId,
        quantity: normalized,
        reason: reason as WasteReason,
        // The media transport is not built yet (bead legend-7nv1): mock mode
        // mints the id the contract expects and keeps the preview local.
        mediaId: photo && API_MOCK ? crypto.randomUUID() : null,
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
            previewUrl={previewUrl}
            error={errors.photo}
            onSelect={pickPhoto}
            onClear={clearPhoto}
          />

          {formError && (
            <p role="alert" className="text-sm font-medium text-danger">
              {formError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("waste.form.cancel")}
            </Button>
            <Button type="submit" loading={createWaste.isPending}>
              {t("waste.form.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
