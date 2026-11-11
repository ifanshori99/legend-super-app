// New-PIN form after the WhatsApp proof is verified (mockup buat-pin-baru). Same
// two-box form as pin-setup.tsx, but the PIN leaves through `onSubmit` instead
// of a hook: the container owns the reset call, so this stays a pure component.
// The PIN lives in component state only. `error` comes from the container after
// a failed save: "proof-invalid" (403, the proof is gone: start over), "format"
// (the server refused the PIN shape) or "generic" (network or server).
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { isCompletePin, validateNewPin } from "../../pin-state.ts";
import { PinCodeInput } from "../pin-code-input.tsx";
import { PinLayout } from "../pin-layout.tsx";

type WaResetNewPinError = "proof-invalid" | "format" | "generic" | null;

type WaResetNewPinProps = {
  onSubmit: (pin: string) => void;
  submitting: boolean;
  error?: WaResetNewPinError;
  /** Back to the start of the reset (the proof is no longer valid). */
  onRestart: () => void;
};

type FieldErrors = { pin?: string; confirm?: string };

function WaResetNewPin({
  onSubmit,
  submitting,
  error = null,
  onRestart,
}: WaResetNewPinProps) {
  const t = useT();
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const pinRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const restartRef = useRef<HTMLButtonElement>(null);

  // Focus the first box on a mouse or trackpad only; on touch it would pop the
  // keyboard over the screen before the employee has read it.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) pinRef.current?.focus();
  }, []);

  const proofGone = error === "proof-invalid";

  // The boxes are disabled once the proof is gone: move focus to the one action
  // left, or it would fall to the page.
  useEffect(() => {
    if (proofGone) restartRef.current?.focus();
  }, [proofGone]);
  const formatError =
    error === "format" ? t("payslipPin.validation.weak") : undefined;

  function handlePinChange(value: string) {
    setPin(value);
    if (errors.pin) setErrors((current) => ({ ...current, pin: undefined }));
  }

  function handleConfirmChange(value: string) {
    setConfirm(value);
    if (errors.confirm)
      setErrors((current) => ({ ...current, confirm: undefined }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || proofGone) return;
    const check = validateNewPin(pin, confirm);
    if (!check.ok) {
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
    onSubmit(pin);
  }

  return (
    <PinLayout
      backLink={
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/karyawan/slip-gaji">
            <ChevronLeft aria-hidden="true" />
            {t("payslipPin.layout.back")}
          </Link>
        </Button>
      }
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
          error={errors.pin ?? formatError}
          required
        >
          <PinCodeInput
            ref={pinRef}
            name="new-pin"
            autoComplete="off"
            value={pin}
            onChange={handlePinChange}
            onComplete={() => confirmRef.current?.focus()}
            disabled={submitting || proofGone}
          />
        </FormField>
        <FormField
          label={t("payslipPin.buatPin.confirmLabel")}
          error={errors.confirm}
          required
        >
          <PinCodeInput
            ref={confirmRef}
            name="confirm-pin"
            autoComplete="off"
            value={confirm}
            onChange={handleConfirmChange}
            disabled={submitting || proofGone}
          />
        </FormField>

        {proofGone && (
          <div role="alert" className="grid gap-0.5">
            <p className="text-sm leading-5 font-semibold text-danger">
              Verifikasi WhatsApp sudah tidak berlaku
            </p>
            <p className="text-sm leading-5">
              Waktu untuk membuat PIN sudah habis. Mulai lagi dari awal untuk
              mengirim kode baru.
            </p>
          </div>
        )}
        {error === "generic" && (
          <div role="alert" className="grid gap-0.5">
            <p className="text-sm leading-5 font-semibold text-danger">
              PIN belum dapat disimpan
            </p>
            <p className="text-sm leading-5">
              Periksa koneksi Anda, lalu coba lagi.
            </p>
          </div>
        )}

        {proofGone ? (
          <Button
            ref={restartRef}
            type="button"
            size="lg"
            className="w-full"
            onClick={onRestart}
          >
            Mulai lagi
          </Button>
        ) : (
          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={submitting}
          >
            {submitting
              ? t("payslipPin.buatPin.submitting")
              : error === "generic"
                ? t("payslipPin.common.retry")
                : t("payslipPin.buatPin.submit")}
          </Button>
        )}
      </form>
    </PinLayout>
  );
}

export { WaResetNewPin };
export type { WaResetNewPinError, WaResetNewPinProps };
