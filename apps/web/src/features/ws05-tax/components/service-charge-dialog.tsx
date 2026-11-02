// Create, edit or version a service-charge rule (PRD §3.14 "Service Charge":
// a percentage per zone or order type, with the F&B/facility classes it
// covers). Zones come from the floor contract; when that read fails the editor
// still allows "all zones" instead of blocking the tax configuration.
import * as React from "react";
import type {
  ItemTaxClass,
  ServiceChargeRule,
  TaxChannel,
} from "@starter/shared/tax";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  useCreateServiceChargeRule,
  useUpdateServiceChargeRule,
} from "../hooks";
import {
  CHANNEL_KEYS,
  ITEM_CLASSES,
  ITEM_CLASS_KEYS,
  TAX_CHANNELS,
} from "../labels";
import {
  parseRatePercent,
  suggestEffectiveFrom,
  type RuleVersion,
} from "../lib";

export type ServiceChargeEditorMode = "create" | "edit" | "new-version";

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

type Errors = {
  code?: string;
  name?: string;
  rate?: string;
  effectiveFrom?: string;
  itemClasses?: string;
  form?: string;
};

function toggleValue<T>(values: readonly T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter((item) => item !== value);
}

function rateInput(rule: ServiceChargeRule | undefined): string {
  if (!rule) return "";
  return String(rule.rateBp / 100).replace(".", ",");
}

export function ServiceChargeDialog({
  mode,
  rule,
  versions,
  today,
  zones,
  zonesUnavailable,
  onClose,
}: {
  mode: ServiceChargeEditorMode;
  rule?: ServiceChargeRule;
  versions: readonly RuleVersion[];
  today: string;
  zones: readonly { id: string; name: string }[];
  zonesUnavailable: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const createRule = useCreateServiceChargeRule();
  const updateRule = useUpdateServiceChargeRule();

  const chain = React.useMemo(
    () =>
      rule
        ? versions.filter(
            (row) => row.code === rule.code && row.outletId === rule.outletId,
          )
        : [],
    [rule, versions],
  );

  const [code, setCode] = React.useState(rule?.code ?? "");
  const [name, setName] = React.useState(rule?.name ?? "");
  const [rate, setRate] = React.useState(rateInput(rule));
  const [zoneKey, setZoneKey] = React.useState(rule?.zoneId ?? "all");
  const [orderTypes, setOrderTypes] = React.useState<TaxChannel[]>(
    rule ? [...rule.orderTypes] : [],
  );
  const [itemClasses, setItemClasses] = React.useState<ItemTaxClass[]>(
    rule ? [...rule.itemClasses] : ["food_beverage"],
  );
  const [isActive, setIsActive] = React.useState(rule?.isActive ?? true);
  const [effectiveFrom, setEffectiveFrom] = React.useState(
    rule === undefined
      ? today
      : mode === "edit"
        ? rule.effectiveFrom
        : suggestEffectiveFrom(chain, today),
  );
  const [errors, setErrors] = React.useState<Errors>({});

  const pending = createRule.isPending || updateRule.isPending;

  function validate(currentRate: number | null): Errors {
    const next: Errors = {};
    if (mode === "create" && !CODE_PATTERN.test(code.trim()))
      next.code = t("tax.errors.code");
    if (name.trim() === "") next.name = t("tax.errors.required");
    if (currentRate === null) next.rate = t("tax.errors.rate");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom))
      next.effectiveFrom = t("tax.errors.required");
    if (itemClasses.length === 0)
      next.itemClasses = t("tax.errors.itemClasses");
    return next;
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rateBp = parseRatePercent(rate);
    const found = validate(rateBp);
    setErrors(found);
    if (Object.keys(found).length > 0 || rateBp === null) return;

    const fields = {
      name: name.trim(),
      rateBp,
      zoneId: zoneKey === "all" ? null : zoneKey,
      orderTypes,
      itemClasses,
      isActive,
      effectiveFrom,
    };
    const onSuccess = () => {
      toast({
        title: t(
          mode === "edit"
            ? "tax.serviceCharge.updatedToast"
            : "tax.serviceCharge.createdToast",
        ),
        tone: "success",
      });
      onClose();
    };
    const onError = (error: unknown) =>
      setErrors({ form: taxMutationError(error, t) });

    if (mode === "edit" && rule) {
      updateRule.mutate(
        { params: { serviceChargeRuleId: rule.id }, body: fields },
        { onSuccess, onError },
      );
      return;
    }
    createRule.mutate(
      { outletId: null, code: code.trim(), ...fields },
      { onSuccess, onError },
    );
  }

  const title =
    mode === "edit"
      ? t("tax.serviceCharge.editDraft")
      : mode === "new-version"
        ? t("tax.serviceCharge.newVersionTitle", { code: rule?.code ?? "" })
        : t("tax.serviceCharge.add");

  const zoneMissing =
    rule?.zoneId != null && !zones.some((zone) => zone.id === rule.zoneId);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("tax.serviceCharge.description")}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("tax.form.code")}
              required
              error={errors.code}
              hint={mode === "create" ? t("tax.form.codeHint") : undefined}
            >
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                disabled={mode !== "create" || pending}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <FormField label={t("tax.form.name")} required error={errors.name}>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={pending}
                maxLength={150}
              />
            </FormField>
            <FormField
              label={t("tax.form.rate")}
              required
              error={errors.rate}
              hint={t("tax.serviceCharge.rateHint")}
            >
              <Input
                inputMode="decimal"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
                disabled={pending}
                placeholder="5"
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={t("tax.form.effectiveFrom")}
              required
              error={errors.effectiveFrom}
            >
              <Input
                type="date"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                disabled={pending}
              />
            </FormField>
          </div>

          <FormField
            label={t("tax.serviceCharge.zone")}
            hint={
              zonesUnavailable
                ? t("tax.serviceCharge.zoneUnavailable")
                : t("tax.serviceCharge.zoneHint")
            }
          >
            <Select
              value={zoneKey}
              onValueChange={setZoneKey}
              disabled={pending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("tax.serviceCharge.allZones")}
                </SelectItem>
                {zones.map((zone) => (
                  <SelectItem key={zone.id} value={zone.id}>
                    {zone.name}
                  </SelectItem>
                ))}
                {zoneMissing && rule?.zoneId && (
                  <SelectItem value={rule.zoneId}>
                    {t("tax.serviceCharge.zoneUnknown")}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </FormField>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold">
              {t("tax.serviceCharge.orderTypes")}
            </legend>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("tax.serviceCharge.orderTypesHint")}
            </p>
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
              {TAX_CHANNELS.map((channel) => (
                <label
                  key={channel}
                  className="flex min-h-control-sm items-center gap-2"
                >
                  <Checkbox
                    checked={orderTypes.includes(channel)}
                    onCheckedChange={(checked) =>
                      setOrderTypes((current) =>
                        toggleValue(current, channel, checked === true),
                      )
                    }
                    disabled={pending}
                  />
                  <span>{t(CHANNEL_KEYS[channel])}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold">
              {t("tax.form.appliesTo")}
            </legend>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {ITEM_CLASSES.map((itemClass) => (
                <label
                  key={itemClass}
                  className="flex min-h-control-sm items-center gap-2"
                >
                  <Checkbox
                    checked={itemClasses.includes(itemClass)}
                    onCheckedChange={(checked) =>
                      setItemClasses((current) =>
                        toggleValue(current, itemClass, checked === true),
                      )
                    }
                    disabled={pending}
                  />
                  <span>{t(ITEM_CLASS_KEYS[itemClass])}</span>
                </label>
              ))}
            </div>
            {errors.itemClasses && (
              <p
                className="text-sm leading-5 font-medium text-danger"
                role="alert"
              >
                {errors.itemClasses}
              </p>
            )}
          </fieldset>

          <div className="flex items-start justify-between gap-4 py-2">
            <div className="grid gap-0.5">
              <Label htmlFor="service-charge-active">
                {t("tax.form.isActive")}
              </Label>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("tax.form.isActiveHint")}
              </p>
            </div>
            <Switch
              id="service-charge-active"
              checked={isActive}
              onCheckedChange={setIsActive}
            />
          </div>

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
              disabled={pending}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={pending}>
              {mode === "edit" ? t("common.save") : t("tax.form.saveDraft")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
