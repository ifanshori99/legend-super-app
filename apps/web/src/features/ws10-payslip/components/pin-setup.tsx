// First-time PIN creation (bead legend-ilzrj, slice S1; mockups buat-pin and
// pin-tersimpan). The employee types a 6-digit PIN twice; HR never sees or sets
// it. Checks run on submit through validateNewPin and show next to the field
// they belong to. The PIN lives in component state only and leaves through the
// PUT body; after a save the cached status turns active and the confirmation
// card offers the way on (`onDone`). No amounts are shown here.
import { useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useSetPayslipPin } from "../pin-hooks.ts";
import { isCompletePin, validateNewPin } from "../pin-state.ts";
import { PinCodeInput } from "./pin-code-input.tsx";
import { PinLayout } from "./pin-layout.tsx";

type PinSetupProps = {
  /** Called when the employee leaves the "PIN tersimpan" confirmation. */
  onDone: () => void;
};

type FieldErrors = { pin?: string; confirm?: string };

function BackLink() {
  const t = useT();
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
      <Link to="/karyawan/slip-gaji">
        <ChevronLeft aria-hidden="true" />
        {t("payslipPin.layout.back")}
      </Link>
    </Button>
  );
}

function PinSetup({ onDone }: PinSetupProps) {
  const t = useT();
  const setPin = useSetPayslipPin();
  const [pin, setPinValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const pinRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  if (setPin.isSuccess) {
    return (
      <PinLayout
        backLink={<BackLink />}
        title={t("payslipPin.pinTersimpan.title")}
        description={t("payslipPin.pinTersimpan.description")}
        side={t("payslipPin.pinTersimpan.side")}
      >
        <div
          role="status"
          className="flex items-start gap-3 rounded-field border-l-4 border-primary bg-success-subtle p-4"
        >
          <ShieldCheck
            className="mt-0.5 size-5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div className="grid gap-0.5">
            <p className="text-base font-bold">
              {t("payslipPin.pinTersimpan.noticeTitle")}
            </p>
            <p className="text-sm leading-5">
              {t("payslipPin.pinTersimpan.notice")}
            </p>
          </div>
        </div>
        <Button type="button" size="lg" className="w-full" onClick={onDone}>
          {t("payslipPin.pinTersimpan.continue")}
        </Button>
      </PinLayout>
    );
  }

  const submitting = setPin.isPending;

  function handlePinChange(value: string) {
    setPinValue(value);
    if (errors.pin) setErrors((current) => ({ ...current, pin: undefined }));
    if (setPin.isError) setPin.reset();
  }

  function handleConfirmChange(value: string) {
    setConfirm(value);
    if (errors.confirm)
      setErrors((current) => ({ ...current, confirm: undefined }));
    if (setPin.isError) setPin.reset();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const check = validateNewPin(pin, confirm);
    if (!check.ok) {
      // "incomplete" is ambiguous: blame the first field that is short.
      if (check.reason === "mismatch") {
        setErrors({ confirm: t("payslipPin.validation.mismatch") });
        confirmRef.current?.focus();
      } else if (check.reason === "weak") {
        setErrors({ pin: t("payslipPin.validation.weak") });
        pinRef.current?.focus();
      } else if (!isCompletePin(pin)) {
        setErrors({ pin: t("payslipPin.validation.incomplete") });
        pinRef.current?.focus();
      } else {
        setErrors({ confirm: t("payslipPin.validation.incomplete") });
        confirmRef.current?.focus();
      }
      return;
    }
    setErrors({});
    setPin.mutate({ pin, idempotencyKey: newIdempotencyKey() });
  }

  return (
    <PinLayout
      backLink={<BackLink />}
      title={t("payslipPin.buatPin.title")}
      description={t("payslipPin.buatPin.description")}
      side={t("payslipPin.buatPin.side")}
      busy={submitting}
    >
      <form
        className="grid gap-4"
        noValidate
        onSubmit={handleSubmit}
        aria-busy={submitting || undefined}
      >
        <FormField
          label={t("payslipPin.buatPin.newLabel")}
          hint={t("payslipPin.buatPin.newHint")}
          error={errors.pin}
          required
        >
          <PinCodeInput
            ref={pinRef}
            value={pin}
            onChange={handlePinChange}
            onComplete={() => confirmRef.current?.focus()}
            disabled={submitting}
            autoFocus
          />
        </FormField>
        <FormField
          label={t("payslipPin.buatPin.confirmLabel")}
          error={errors.confirm}
          required
        >
          <PinCodeInput
            ref={confirmRef}
            value={confirm}
            onChange={handleConfirmChange}
            disabled={submitting}
          />
        </FormField>

        {setPin.isError && (
          <div role="alert" className="grid gap-0.5">
            <p className="text-sm leading-5 font-semibold text-danger">
              {t("payslipPin.setup.errorTitle")}
            </p>
            <p className="text-sm leading-5">
              {t("payslipPin.setup.errorHint")}
            </p>
          </div>
        )}

        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          {submitting
            ? t("payslipPin.buatPin.submitting")
            : setPin.isError
              ? t("payslipPin.common.retry")
              : t("payslipPin.buatPin.submit")}
        </Button>
      </form>
    </PinLayout>
  );
}

export { PinSetup };
export type { PinSetupProps };
