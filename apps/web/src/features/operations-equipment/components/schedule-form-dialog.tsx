// Create a service schedule (PRD v1.7 §3 F41: interval + next service date,
// vendor from purchasing suppliers per owner decision legend-uy1e).
import * as React from "react";
import { createMaintenanceScheduleInputSchema } from "@starter/shared/operations";
import type { Equipment } from "@starter/shared/operations";
import type { Supplier } from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { useToast } from "@/components/ui/toast";
import {
  datetimeLocalToIso,
  isoToDatetimeLocal,
  SERVICE_DUE_WINDOW_DAYS,
} from "../lib.ts";
import { useAttemptKey, useCreateSchedule } from "../hooks.ts";

type VendorOption = Pick<Supplier, "id" | "name">;

const DAY_MS = 86_400_000;

export function ScheduleFormDialog({
  outletId,
  timeZone,
  equipmentOptions,
  vendors,
  defaultEquipmentId,
  trigger,
}: {
  outletId: string;
  timeZone: string;
  equipmentOptions: readonly Equipment[];
  vendors: readonly VendorOption[];
  defaultEquipmentId?: string;
  trigger: React.ReactElement;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateSchedule();
  const attempt = useAttemptKey();
  const [open, setOpen] = React.useState(false);
  const [equipmentId, setEquipmentId] = React.useState(
    defaultEquipmentId ?? equipmentOptions[0]?.id ?? "",
  );
  const [intervalDays, setIntervalDays] = React.useState("90");
  const [nextDue, setNextDue] = React.useState("");
  const [vendorId, setVendorId] = React.useState("none");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    // Reset the dialog each time it opens (same pattern as the other form
    // dialogs; React lint flags setState in an effect).
    /* eslint-disable react-hooks/set-state-in-effect */
    setEquipmentId(defaultEquipmentId ?? equipmentOptions[0]?.id ?? "");
    setIntervalDays("90");
    setNextDue(
      isoToDatetimeLocal(
        new Date(Date.now() + SERVICE_DUE_WINDOW_DAYS * DAY_MS).toISOString(),
        timeZone,
      ),
    );
    setVendorId("none");
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, defaultEquipmentId, equipmentOptions, timeZone]);

  const lockedEquipment = defaultEquipmentId
    ? (equipmentOptions.find((row) => row.id === defaultEquipmentId) ?? null)
    : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const nextDueAt = datetimeLocalToIso(nextDue, timeZone);
    const payload = {
      outletId,
      equipmentId,
      intervalDays: Number(intervalDays),
      nextDueAt,
      vendorId: vendorId === "none" ? null : vendorId,
    };
    const parsed = createMaintenanceScheduleInputSchema.safeParse({
      ...payload,
      idempotencyKey: attempt.keyFor(payload),
    });
    if (!parsed.success) {
      setError(t("opsEquipment.equipment.scheduleForm.invalid"));
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      attempt.settle();
      toast({
        title: t("opsEquipment.equipment.toasts.scheduleCreated"),
        tone: "success",
      });
      setOpen(false);
    } catch {
      setError(t("opsEquipment.errors.action"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("opsEquipment.equipment.scheduleForm.title")}
          </DialogTitle>
          <DialogDescription>
            {t("opsEquipment.equipment.scheduleForm.interval")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {lockedEquipment ? (
            <FormField
              label={t("opsEquipment.equipment.scheduleForm.equipment")}
            >
              <Input value={lockedEquipment.name} readOnly />
            </FormField>
          ) : (
            <FormField
              label={t("opsEquipment.equipment.scheduleForm.equipment")}
              required
            >
              <Select value={equipmentId} onValueChange={setEquipmentId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={t(
                      "opsEquipment.equipment.scheduleForm.chooseEquipment",
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {equipmentOptions.map((row) => (
                    <SelectItem
                      key={row.id}
                      value={row.id}
                      className="min-h-11"
                    >
                      {row.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          <FormField
            label={t("opsEquipment.equipment.scheduleForm.interval")}
            required
          >
            <Input
              type="number"
              min="1"
              step="1"
              value={intervalDays}
              onChange={(event) => setIntervalDays(event.target.value)}
            />
          </FormField>
          <FormField
            label={t("opsEquipment.equipment.scheduleForm.nextDue")}
            required
          >
            <Input
              type="datetime-local"
              value={nextDue}
              onChange={(event) => setNextDue(event.target.value)}
            />
          </FormField>
          <FormField label={t("opsEquipment.equipment.scheduleForm.vendor")}>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={t(
                    "opsEquipment.equipment.scheduleForm.chooseVendor",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="min-h-11">
                  {t("opsEquipment.equipment.scheduleForm.noVendor")}
                </SelectItem>
                {vendors.map((vendor) => (
                  <SelectItem
                    key={vendor.id}
                    value={vendor.id}
                    className="min-h-11"
                  >
                    {vendor.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              {t("opsEquipment.equipment.scheduleForm.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
