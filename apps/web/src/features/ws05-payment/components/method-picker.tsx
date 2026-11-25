// Method picker: the online methods the provider reports as active (PRD
// §3.13: never hard-coded), plus the bank list for VA and transfer. Radio
// cards are native inputs whose invisible control fills the card, so the whole
// card is a 48px+ touch target and keyboard focus rings the card itself.
import { useId, useState } from "react";
import { Building2, Landmark, QrCode, ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { paymentErrorKey } from "../errors";
import {
  PAYMENT_METHOD_HINT,
  PAYMENT_METHOD_LABEL,
  type PickerMethod,
  type PickerMethodCode,
} from "../labels";
import { canSubmit } from "../status";

const METHOD_ICON = {
  qris: QrCode,
  va: Landmark,
  bank_transfer: Building2,
} as const;

function MethodOption({
  option,
  checked,
  disabled,
  onSelect,
}: {
  option: PickerMethod;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const Icon = METHOD_ICON[option.method];
  const hint = disabled
    ? t("payment.methodUnavailable")
    : t(PAYMENT_METHOD_HINT[option.method]);

  return (
    <label
      className={cn(
        "relative flex min-h-control cursor-pointer items-start gap-3 rounded-container border-(length:--border-w) border-input bg-background p-3 transition-colors duration-(--duration-fast)",
        checked && "border-primary bg-primary-tint ring-1 ring-primary",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name="payment-method"
        value={option.method}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
      <Icon
        className="mt-0.5 size-5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-base leading-6 font-semibold">
          {t(PAYMENT_METHOD_LABEL[option.method])}
        </span>
        <span className="text-sm leading-5 text-muted-foreground">{hint}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 border-input",
          checked && "border-primary",
        )}
      >
        {checked && <span className="size-2.5 rounded-full bg-primary" />}
      </span>
    </label>
  );
}

export function MethodPicker({
  methods,
  method,
  channelCode,
  onMethod,
  onChannel,
  onSubmit,
  submitting,
  error,
}: {
  methods: PickerMethod[];
  method: PickerMethodCode | null;
  channelCode: string | null;
  onMethod: (method: PickerMethodCode) => void;
  onChannel: (channelCode: string | null) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: unknown;
}) {
  const t = useT();
  const selectId = useId();
  const [touched, setTouched] = useState(false);
  const selected = methods.find((option) => option.method === method) ?? null;
  const needsChannel = selected !== null && selected.method !== "qris";
  const ready = canSubmit(selected?.method ?? null, channelCode);
  const showError = error !== null && error !== undefined;

  return (
    <Card>
      <div className="grid gap-1">
        <h2 className="type-title">{t("payment.chooseTitle")}</h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payment.chooseHint")}
        </p>
      </div>

      <fieldset className="grid gap-2">
        <legend className="sr-only">{t("payment.methodLegend")}</legend>
        {methods.map((option) => (
          <MethodOption
            key={option.method}
            option={option}
            checked={option.method === method}
            disabled={
              !option.enabled ||
              (option.method !== "qris" && option.channels.length === 0)
            }
            onSelect={() => onMethod(option.method)}
          />
        ))}
      </fieldset>

      {needsChannel && (
        <FormField
          id={selectId}
          label={t("payment.bankLabel")}
          required
          error={touched && !ready ? t("payment.methodInvalid") : undefined}
        >
          <Select
            value={channelCode ?? undefined}
            onValueChange={(value) => {
              setTouched(true);
              onChannel(value);
            }}
          >
            <SelectTrigger
              id={selectId}
              aria-label={t("payment.bankLabel")}
              className="w-full"
            >
              <SelectValue placeholder={t("payment.bankPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {selected.channels.map((channel) => (
                <SelectItem key={channel.code} value={channel.code}>
                  {channel.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}

      {showError && (
        <p role="alert" className="text-sm leading-5 text-danger">
          {t(paymentErrorKey(error))}
        </p>
      )}

      <Button
        type="button"
        className="w-full"
        onClick={() => {
          if (!ready) {
            setTouched(true);
            return;
          }
          onSubmit();
        }}
        loading={submitting}
        disabled={selected === null}
      >
        {t("payment.continue")}
      </Button>

      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("payment.secureNote")}
      </p>
    </Card>
  );
}
