// A new calculation-options version (PRD §3.14 "Opsi Perhitungan"): prices
// inclusive or exclusive, rounding modes, cash rounding and package
// allocation. Settings are versioned like rules: the dialog always creates a
// draft; publishing it is a separate step in the version history.
import * as React from "react";
import type { PackageAllocationMethod, TaxSettings } from "@starter/shared/tax";
import type { RoundingMode } from "@starter/shared/core";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { taxMutationError } from "../errors";
import { useCreateTaxSettings } from "../hooks";
import { PACKAGE_ALLOCATION_KEYS, ROUNDING_KEYS } from "../labels";
import { suggestEffectiveFrom } from "../lib";

const ROUNDING_MODES: readonly RoundingMode[] = [
  "half_up",
  "half_even",
  "down",
  "floor",
  "ceil",
];

const ALLOCATION_METHODS: readonly PackageAllocationMethod[] = [
  "fixed_bp",
  "standalone_price_ratio",
];

/** Copy defaults from the version in force, or the latest version. */
function defaultsFrom(settings: TaxSettings | undefined) {
  return {
    pricesIncludeTax: settings?.pricesIncludeTax ?? false,
    serviceRoundingMode: settings?.serviceRoundingMode ?? "half_up",
    taxRoundingMode: settings?.taxRoundingMode ?? "half_up",
    inclusiveBaseRoundingMode: settings?.inclusiveBaseRoundingMode ?? "half_up",
    billRounding: settings?.billRounding ?? null,
    packageAllocation: settings?.packageAllocation ?? "fixed_bp",
  };
}

export function TaxSettingsDialog({
  base,
  versions,
  today,
  onClose,
}: {
  /** Effective (or latest) settings the new version starts from. */
  base: TaxSettings | undefined;
  versions: readonly Pick<TaxSettings, "status" | "effectiveFrom">[];
  today: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const createSettings = useCreateTaxSettings();
  const defaults = defaultsFrom(base);

  const [pricesIncludeTax, setPricesIncludeTax] = React.useState(
    defaults.pricesIncludeTax,
  );
  const [serviceRoundingMode, setServiceRoundingMode] =
    React.useState<RoundingMode>(defaults.serviceRoundingMode);
  const [taxRoundingMode, setTaxRoundingMode] = React.useState<RoundingMode>(
    defaults.taxRoundingMode,
  );
  const [inclusiveBaseRoundingMode, setInclusiveBaseRoundingMode] =
    React.useState<RoundingMode>(defaults.inclusiveBaseRoundingMode);
  const [billRoundingEnabled, setBillRoundingEnabled] = React.useState(
    defaults.billRounding !== null,
  );
  const [increment, setIncrement] = React.useState(
    String(defaults.billRounding?.incrementIdr ?? 100),
  );
  const [billRoundingMode, setBillRoundingMode] = React.useState<RoundingMode>(
    defaults.billRounding?.mode ?? "half_up",
  );
  const [packageAllocation, setPackageAllocation] =
    React.useState<PackageAllocationMethod>(defaults.packageAllocation);
  const [effectiveFrom, setEffectiveFrom] = React.useState(
    suggestEffectiveFrom(versions, today),
  );
  const [errors, setErrors] = React.useState<{
    increment?: string;
    effectiveFrom?: string;
    form?: string;
  }>({});

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: typeof errors = {};
    const incrementIdr = Number(increment);
    if (
      billRoundingEnabled &&
      (!Number.isInteger(incrementIdr) ||
        incrementIdr <= 0 ||
        incrementIdr > 100_000)
    )
      next.increment = t("tax.errors.increment");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom))
      next.effectiveFrom = t("tax.errors.required");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    createSettings.mutate(
      {
        outletId: null,
        calculationOrder: "discount_service_tax",
        pricesIncludeTax,
        serviceRoundingMode,
        taxRoundingMode,
        inclusiveBaseRoundingMode,
        billRounding: billRoundingEnabled
          ? { incrementIdr, mode: billRoundingMode }
          : null,
        packageAllocation,
        effectiveFrom,
      },
      {
        onSuccess: () => {
          toast({ title: t("tax.settings.createdToast"), tone: "success" });
          onClose();
        },
        onError: (error) => setErrors({ form: taxMutationError(error, t) }),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("tax.settings.newVersion")}</DialogTitle>
          <DialogDescription>{t("tax.settings.description")}</DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={submit} noValidate>
          <div className="flex items-start justify-between gap-4 py-2">
            <div className="grid gap-0.5">
              <Label htmlFor="settings-prices-include">
                {t("tax.form.priceIncludesTax")}
              </Label>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("tax.settings.pricesIncludeTaxHint")}
              </p>
            </div>
            <Switch
              id="settings-prices-include"
              checked={pricesIncludeTax}
              onCheckedChange={setPricesIncludeTax}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("tax.settings.serviceRounding")}
              required
              hint={t("tax.settings.roundingHint")}
            >
              <Select
                value={serviceRoundingMode}
                onValueChange={(value) =>
                  setServiceRoundingMode(value as RoundingMode)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROUNDING_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(ROUNDING_KEYS[mode])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("tax.settings.taxRounding")}
              required
              hint={t("tax.settings.roundingHint")}
            >
              <Select
                value={taxRoundingMode}
                onValueChange={(value) =>
                  setTaxRoundingMode(value as RoundingMode)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROUNDING_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(ROUNDING_KEYS[mode])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("tax.settings.inclusiveBaseRounding")}
              required
              hint={t("tax.settings.inclusiveBaseHint")}
            >
              <Select
                value={inclusiveBaseRoundingMode}
                onValueChange={(value) =>
                  setInclusiveBaseRoundingMode(value as RoundingMode)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROUNDING_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(ROUNDING_KEYS[mode])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t("tax.settings.packageAllocation")} required>
              <Select
                value={packageAllocation}
                onValueChange={(value) =>
                  setPackageAllocation(value as PackageAllocationMethod)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALLOCATION_METHODS.map((method) => (
                    <SelectItem key={method} value={method}>
                      {t(PACKAGE_ALLOCATION_KEYS[method])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="flex items-start justify-between gap-4 py-2">
            <div className="grid gap-0.5">
              <Label htmlFor="settings-bill-rounding">
                {t("tax.settings.billRounding")}
              </Label>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("tax.settings.billRoundingHint")}
              </p>
            </div>
            <Switch
              id="settings-bill-rounding"
              checked={billRoundingEnabled}
              onCheckedChange={setBillRoundingEnabled}
            />
          </div>

          {billRoundingEnabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t("tax.settings.billRoundingIncrement")}
                required
                error={errors.increment}
                hint={t("tax.settings.billRoundingIncrementHint")}
              >
                <Input
                  inputMode="numeric"
                  value={increment}
                  onChange={(event) => setIncrement(event.target.value)}
                />
              </FormField>
              <FormField label={t("tax.settings.billRoundingMode")} required>
                <Select
                  value={billRoundingMode}
                  onValueChange={(value) =>
                    setBillRoundingMode(value as RoundingMode)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROUNDING_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(ROUNDING_KEYS[mode])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
          )}

          <FormField
            label={t("tax.form.effectiveFrom")}
            required
            error={errors.effectiveFrom}
          >
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </FormField>

          {errors.form && (
            <p
              className="text-sm leading-5 font-medium text-danger"
              role="alert"
            >
              {errors.form}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={createSettings.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={createSettings.isPending}>
              {t("tax.form.saveDraft")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
