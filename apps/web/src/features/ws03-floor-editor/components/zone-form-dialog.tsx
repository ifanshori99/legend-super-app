// Zone settings: name, pay mode, service charge, minimum spend, opening hours
// and order (PRD §3 F9 "Zona"). One form creates and edits, validated with the
// contract's own input schema so a bad value never reaches the API. The form
// body mounts fresh on every open, so it always starts from the saved zone.
import * as React from "react";
import {
  createFloorZoneInputSchema,
  updateFloorZoneInputSchema,
} from "@starter/shared/qr-order";
import type { FloorZone, PaymentMode } from "@starter/shared/qr-order";
import type { ApiError } from "@/lib/api/errors";
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
import { FormField, fieldErrors } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useCreateZone, useUpdateZone } from "../hooks";
import {
  basisPointsOfPercent,
  fromZoneHours,
  hasOpenDay,
  percentOfBasisPoints,
  toZoneHours,
  type DayHours,
} from "../lib";
import { MoneyField } from "./money-field";
import { ZoneHoursField } from "./zone-hours-field";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent means "create a new zone". */
  zone?: FloorZone;
};

function ZoneFormBody({
  zone,
  onClose,
}: {
  zone?: FloorZone;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const createZone = useCreateZone();
  const updateZone = useUpdateZone();
  const pending = createZone.isPending || updateZone.isPending;

  const [name, setName] = React.useState(zone?.name ?? "");
  const [paymentMode, setPaymentMode] = React.useState<PaymentMode>(
    zone?.paymentMode ?? "pay_first",
  );
  const [serviceCharge, setServiceCharge] = React.useState(
    String(percentOfBasisPoints(zone?.serviceChargeBp ?? 0)).replace(".", ","),
  );
  const [minSpend, setMinSpend] = React.useState(zone?.minimumSpendIdr ?? 0);
  const [days, setDays] = React.useState<DayHours[]>(() =>
    fromZoneHours(zone?.hours ?? []),
  );
  const [active, setActive] = React.useState(
    (zone?.status ?? "active") === "active",
  );
  const [isWfc, setIsWfc] = React.useState(zone?.isWfc ?? false);
  const [sortOrder, setSortOrder] = React.useState(
    String(zone?.sortOrder ?? 0),
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [hoursError, setHoursError] = React.useState<string | undefined>();
  const [formError, setFormError] = React.useState<ApiError | null>(null);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const percent = Number(serviceCharge.replace(",", "."));
    if (!Number.isFinite(percent)) {
      setErrors({ serviceChargeBp: t("floorEditor.formPercentInvalid") });
      return;
    }
    setHoursError(
      hasOpenDay(days) ? undefined : t("floorEditor.formHoursRequired"),
    );
    const payload = {
      name: name.trim(),
      paymentMode,
      serviceChargeBp: basisPointsOfPercent(percent),
      minimumSpendIdr: minSpend,
      hours: toZoneHours(days),
      status: active ? ("active" as const) : ("inactive" as const),
      sortOrder: Number(sortOrder) || 0,
      isWfc,
    };
    const done = {
      onSuccess: () => {
        toast({
          title: zone
            ? t("floorEditor.formSaved")
            : t("floorEditor.formCreated"),
          tone: "success" as const,
        });
        onClose();
      },
      onError: (error: Error) => setFormError(error as ApiError),
    };
    if (zone) {
      const parsed = updateFloorZoneInputSchema.safeParse(payload);
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error));
        return;
      }
      setErrors({});
      updateZone.mutate({ zoneId: zone.id, body: parsed.data }, done);
      return;
    }
    const parsed = createFloorZoneInputSchema.safeParse(payload);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    createZone.mutate(parsed.data, done);
  };

  return (
    <DialogContent>
      <form
        className="flex min-h-0 flex-col gap-4"
        onSubmit={submit}
        noValidate
      >
        <DialogHeader>
          <DialogTitle>
            {zone
              ? t("floorEditor.editZoneTitle")
              : t("floorEditor.newZoneTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("floorEditor.formZoneIntro")}
          </DialogDescription>
        </DialogHeader>

        {/* The hours editor is tall; only the fields scroll, so "Simpan zona"
            never drops below the fold on a phone or a short window. */}
        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto pr-1">
          <FormField
            label={t("floorEditor.formName")}
            hint={t("floorEditor.formNameHint")}
            error={errors.name}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <div className="grid gap-1.5">
            <span className="text-sm font-semibold">
              {t("floorEditor.formPaymentMode")}
            </span>
            <SegmentedControl
              label={t("floorEditor.formPaymentMode")}
              value={paymentMode}
              onValueChange={setPaymentMode}
              options={[
                { value: "pay_first", label: t("floorEditor.payFirst") },
                { value: "open_bill", label: t("floorEditor.openBill") },
              ]}
            />
            <p className="text-sm leading-5 text-muted-foreground">
              {t("floorEditor.formPaymentModeHint")}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("floorEditor.formServiceCharge")}
              hint={t("floorEditor.formServiceChargeHint")}
              error={errors.serviceChargeBp}
              required
            >
              <Input
                type="text"
                inputMode="decimal"
                value={serviceCharge}
                onChange={(event) => setServiceCharge(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("floorEditor.formMinSpend")}
              hint={t("floorEditor.formMinSpendHint")}
              error={errors.minimumSpendIdr}
              required
            >
              <MoneyField value={minSpend} onChange={setMinSpend} />
            </FormField>
          </div>

          <ZoneHoursField
            value={days}
            onChange={setDays}
            error={hoursError ?? errors.hours}
            idPrefix="zone-hours"
          />

          <div className="flex items-start gap-3">
            <Switch id="zone-wfc" checked={isWfc} onCheckedChange={setIsWfc} />
            <div className="grid gap-0.5">
              <label htmlFor="zone-wfc" className="text-sm font-medium">
                {t("floorEditor.formWfc")}
              </label>
              <p className="text-xs text-muted-foreground">
                {t("floorEditor.formWfcHint")}
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex items-end gap-3">
              <Switch
                id="zone-active"
                checked={active}
                onCheckedChange={setActive}
              />
              <label htmlFor="zone-active" className="text-sm font-medium">
                {t("floorEditor.formStatus")}
              </label>
            </div>
            <FormField
              label={t("floorEditor.formSortOrder")}
              hint={t("floorEditor.formSortOrderHint")}
              error={errors.sortOrder}
              required
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={999}
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value)}
              />
            </FormField>
          </div>
        </div>

        {formError && (
          <p
            role="alert"
            className="rounded-control border-(length:--border-w) bg-danger-subtle p-3 text-sm leading-5 font-medium text-danger"
          >
            {formError.message}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={pending}>
            {zone ? t("floorEditor.formSave") : t("floorEditor.formCreate")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function ZoneFormDialog({ open, onOpenChange, zone }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <ZoneFormBody zone={zone} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

export { ZoneFormDialog };
