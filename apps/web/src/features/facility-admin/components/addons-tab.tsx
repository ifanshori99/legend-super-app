// "Add-on" tab: towels, amenities kit, locker and hair dryer can be enabled per
// facility and sold with the ticket (PRD v1.7 §3 F25 "Add-on Opsional"). The
// contract models stock consumption as `inventoryItemId`; it has no separate
// laundry-cost column, so the add-on price carries that cost (noted in the UI).
import * as React from "react";
import type { FacilityAddon, FacilityConfig } from "@starter/shared/facility";
import {
  createFacilityAddonSchema,
  updateFacilityAddonSchema,
} from "@starter/shared/facility";
import type { InventoryItem } from "@starter/shared/inventory";
import type { Translate } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PendingDialog,
  PendingDialogContent,
} from "@/components/ui/pending-dialog";
import { EmptyState } from "@/components/ui/feedback-state";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import {
  useCreateAddon,
  useInventoryItemOptions,
  useUpdateAddon,
} from "../hooks.ts";
import {
  parseCreateDraft,
  parseInteger,
  parseUpdateDraft,
  shortId,
  zodFieldErrors,
} from "../lib.ts";
import { ConfigSection } from "./config-section";
import { FormError } from "./form-error";

type AddonDialogState =
  { mode: "create" } | { mode: "edit"; addon: FacilityAddon } | null;

function inventoryLabel(
  items: readonly InventoryItem[],
  inventoryItemId: string,
  t: Translate,
): string {
  const item = items.find((row) => row.id === inventoryItemId);
  return (
    item?.name ??
    t("facilityAdmin.addons.inventoryFallback", {
      id: shortId(inventoryItemId),
    })
  );
}

export function AddonsTab({
  facilityId,
  config,
}: {
  facilityId: string;
  config: FacilityConfig;
}) {
  const t = useT();
  const toast = useToast();
  const inventoryQuery = useInventoryItemOptions();
  const updateAddon = useUpdateAddon(facilityId);
  const [dialog, setDialog] = React.useState<AddonDialogState>(null);

  const inventoryItems = inventoryQuery.data ?? [];
  const addons = [...config.addons]
    .filter((addon) => addon.facilityId === facilityId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  function toggle(addon: FacilityAddon, isEnabled: boolean) {
    updateAddon.mutate(
      {
        addonId: addon.id,
        body: { isEnabled },
        expectedUpdatedAt: addon.updatedAt,
      },
      {
        onSuccess: () =>
          toast({
            title: t("facilityAdmin.addons.updated"),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: t("facilityAdmin.addons.updateFailed"),
            description: error instanceof ApiError ? error.message : undefined,
            tone: "danger",
          }),
      },
    );
  }

  return (
    <div className="grid gap-5">
      <ConfigSection
        slot="facility-addons"
        title={t("facilityAdmin.addons.title")}
        description={t("facilityAdmin.addons.description")}
        action={
          <Button
            type="button"
            size="sm"
            onClick={() => setDialog({ mode: "create" })}
          >
            {t("facilityAdmin.addons.add")}
          </Button>
        }
      >
        {addons.length === 0 ? (
          <EmptyState
            title={t("facilityAdmin.addons.empty")}
            description={t("facilityAdmin.addons.emptyHint")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("facilityAdmin.addons.columnsName")}</TableHead>
                <TableHead numeric>
                  {t("facilityAdmin.addons.columnsPrice")}
                </TableHead>
                <TableHead>{t("facilityAdmin.addons.columnsStock")}</TableHead>
                <TableHead>{t("facilityAdmin.common.status")}</TableHead>
                <TableHead className="text-right">
                  {t("facilityAdmin.common.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {addons.map((addon) => (
                <TableRow
                  key={addon.id}
                  data-slot="facility-addon"
                  data-addon-id={addon.id}
                >
                  <TableCell className="font-medium">{addon.name}</TableCell>
                  <TableCell numeric>
                    <Money amount={addon.priceIdr} />
                  </TableCell>
                  <TableCell>
                    {addon.inventoryItemId === null
                      ? t("facilityAdmin.addons.stockNone")
                      : t("facilityAdmin.addons.stockLinkedId", {
                          item: inventoryLabel(
                            inventoryItems,
                            addon.inventoryItemId,
                            t,
                          ),
                        })}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={addon.isEnabled}
                      disabled={updateAddon.isPending}
                      aria-label={t(
                        addon.isEnabled
                          ? "facilityAdmin.addons.disable"
                          : "facilityAdmin.addons.enable",
                        { name: addon.name },
                      )}
                      onCheckedChange={(checked) => toggle(addon, checked)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t("facilityAdmin.addons.edit", {
                          name: addon.name,
                        })}
                        onClick={() => setDialog({ mode: "edit", addon })}
                      >
                        {t("facilityAdmin.common.edit")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-sm leading-5 text-muted-foreground">
          {t("facilityAdmin.addons.laundryHint")}
        </p>
      </ConfigSection>

      {dialog && (
        <AddonDialog
          key={dialog.mode === "edit" ? dialog.addon.id : "new-addon"}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          facilityId={facilityId}
          addon={dialog.mode === "edit" ? dialog.addon : null}
          inventoryItems={inventoryItems}
        />
      )}
    </div>
  );
}

function AddonDialog({
  open,
  onOpenChange,
  facilityId,
  addon,
  inventoryItems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facilityId: string;
  addon: FacilityAddon | null;
  inventoryItems: readonly InventoryItem[];
}) {
  const t = useT();
  const toast = useToast();
  const createAddon = useCreateAddon(facilityId);
  const updateAddon = useUpdateAddon(facilityId);
  const [name, setName] = React.useState(addon?.name ?? "");
  const [price, setPrice] = React.useState(addon ? String(addon.priceIdr) : "");
  const [inventoryItemId, setInventoryItemId] = React.useState(
    addon?.inventoryItemId ?? "none",
  );
  const [enabled, setEnabled] = React.useState(addon?.isEnabled ?? true);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string>();
  const pending = createAddon.isPending || updateAddon.isPending;

  const choices: { id: string; name: string }[] = inventoryItems.map(
    (item) => ({ id: item.id, name: item.name }),
  );
  if (
    inventoryItemId !== "none" &&
    !choices.some((item) => item.id === inventoryItemId)
  )
    choices.push({
      id: inventoryItemId,
      name: t("facilityAdmin.addons.inventoryFallback", {
        id: shortId(inventoryItemId),
      }),
    });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const trimmed = name.trim();
    if (trimmed.length === 0)
      next.name = t("facilityAdmin.addons.errorsNameRequired");
    else if (trimmed.length > 150)
      next.name = t("facilityAdmin.errors.tooLong", {
        field: t("facilityAdmin.addons.fieldsName"),
        max: 150,
      });
    const priceIdr = parseInteger(price);
    if (priceIdr === null)
      next.priceIdr = t("facilityAdmin.addons.errorsPriceInvalid");

    setErrors(next);
    if (Object.keys(next).length > 0) {
      setFormError(t("form.errorSummary", { count: Object.keys(next).length }));
      return;
    }
    setFormError(undefined);
    if (priceIdr === null) return;

    const inventory = inventoryItemId === "none" ? null : inventoryItemId;

    if (addon) {
      const parsed = parseUpdateDraft(updateFacilityAddonSchema, {
        name: trimmed,
        priceIdr,
        inventoryItemId: inventory,
        isEnabled: enabled,
      });
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error));
        setFormError(
          t("form.errorSummary", { count: parsed.error.issues.length }),
        );
        return;
      }
      updateAddon.mutate(
        {
          addonId: addon.id,
          body: parsed.data,
          expectedUpdatedAt: addon.updatedAt,
        },
        {
          onSuccess: () => {
            toast({
              title: t("facilityAdmin.addons.updated"),
              tone: "success",
            });
            onOpenChange(false);
          },
          onError: (error) =>
            setFormError(
              error instanceof ApiError
                ? error.message
                : t("facilityAdmin.addons.updateFailed"),
            ),
        },
      );
      return;
    }

    const parsed = parseCreateDraft(createFacilityAddonSchema, {
      facilityId,
      name: trimmed,
      priceIdr,
      inventoryItemId: inventory,
      isEnabled: enabled,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }
    createAddon.mutate(parsed.data, {
      onSuccess: () => {
        toast({ title: t("facilityAdmin.addons.created"), tone: "success" });
        onOpenChange(false);
      },
      onError: (error) =>
        setFormError(
          error instanceof ApiError
            ? error.message
            : t("facilityAdmin.addons.createFailed"),
        ),
    });
  }

  return (
    <PendingDialog pending={pending} open={open} onOpenChange={onOpenChange}>
      <PendingDialogContent>
        <DialogHeader>
          <DialogTitle>
            {addon
              ? t("facilityAdmin.addons.editTitle")
              : t("facilityAdmin.addons.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("facilityAdmin.addons.description")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <FormField
            label={t("facilityAdmin.addons.fieldsName")}
            error={errors.name}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label={t("facilityAdmin.addons.fieldsPrice")}
            hint={t("facilityAdmin.common.priceExclTaxHint")}
            error={errors.priceIdr}
            required
          >
            <Input
              inputMode="numeric"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </FormField>
          <FormField
            label={t("facilityAdmin.addons.fieldsInventoryItem")}
            hint={t("facilityAdmin.addons.fieldsInventoryItemHint")}
          >
            <Select value={inventoryItemId} onValueChange={setInventoryItemId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {t("facilityAdmin.addons.inventoryNone")}
                </SelectItem>
                {choices.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <div className="flex items-start justify-between gap-3">
            <Label htmlFor="facility-addon-enabled">
              {t("facilityAdmin.addons.fieldsEnabled")}
            </Label>
            <Switch
              id="facility-addon-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
          <FormError message={formError} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" loading={pending}>
              {t("facilityAdmin.addons.save")}
            </Button>
          </DialogFooter>
        </form>
      </PendingDialogContent>
    </PendingDialog>
  );
}
