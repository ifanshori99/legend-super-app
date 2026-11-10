// "Lupa PIN?" (bead legend-ilzrj, slice S3; mockups lupa-pin, kode-dibatasi,
// pin-tersimpan). The employee asks for a WhatsApp code, types it with a new
// PIN and the repeat, and the new PIN is active. HR is the other way out and
// never sees or sets a PIN. States: choose (request), unavailable (503, a calm
// notice and not a toast), rate limited (429, own card), code entry, done.
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, CircleCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { newIdempotencyKey } from "@/lib/idempotency";
import {
  useRequestPayslipPinOtp,
  useVerifyPayslipPinOtp,
} from "../pin-hooks.ts";
import type { PinErrorState } from "../pin-state.ts";
import {
  classifyPinError,
  isCompletePin,
  validateNewPin,
} from "../pin-state.ts";
import { PinCodeInput } from "./pin-code-input.tsx";
import { PinLayout } from "./pin-layout.tsx";

type Step = "choose" | "code" | "done";
type Field = "code" | "pin" | "confirm";

/** The API allows 3 code requests per hour; the resend button stops there. */
const MAX_CODE_SENDS = 3;
type Tone = "neutral" | "danger" | "success";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border bg-muted",
  danger: "border-danger bg-danger-subtle",
  success: "border-success bg-success-subtle",
};

/** Left-ruled notice of the mockups; `alert` for errors, `status` otherwise. */
function Notice({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`grid gap-0.5 rounded-field border-l-4 p-4 ${TONE_CLASS[tone]}`}
    >
      <p className="text-sm leading-5 font-semibold">{title}</p>
      {children && (
        <p className="text-sm leading-5 text-muted-foreground">{children}</p>
      )}
    </div>
  );
}

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

function BackToListButton() {
  const t = useT();
  return (
    <Button asChild variant="outline" size="lg" className="w-full">
      <Link to="/karyawan/slip-gaji">{t("payslipPin.common.backToList")}</Link>
    </Button>
  );
}

export function PinForgot() {
  const t = useT();
  const requestOtp = useRequestPayslipPinOtp();
  const verifyOtp = useVerifyPayslipPinOtp();

  const [step, setStep] = useState<Step>("choose");
  const [requestFailure, setRequestFailure] = useState<PinErrorState | null>(
    null,
  );
  const [verifyFailure, setVerifyFailure] = useState<PinErrorState | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>();
  const [pinError, setPinError] = useState<string | undefined>();
  const [confirmError, setConfirmError] = useState<string | undefined>();

  const [sends, setSends] = useState(0);
  const [focusRequest, setFocusRequest] = useState<{
    field: Field;
    n: number;
  } | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const requesting = requestOtp.isPending;
  const verifying = verifyOtp.isPending;

  // After a failed submit the first input with an error takes focus. Deferred
  // one tick so the fields are enabled again when the call has settled.
  useEffect(() => {
    if (focusRequest === null) return;
    const refs = { code: codeRef, pin: pinRef, confirm: confirmRef };
    const timer = setTimeout(
      () => refs[focusRequest.field].current?.focus(),
      0,
    );
    return () => clearTimeout(timer);
  }, [focusRequest]);

  function focusField(field: Field) {
    setFocusRequest((previous) => ({ field, n: (previous?.n ?? 0) + 1 }));
  }

  async function sendCode() {
    setRequestFailure(null);
    try {
      await requestOtp.mutateAsync({ idempotencyKey: newIdempotencyKey() });
      setSends((count) => count + 1);
      setCode("");
      setVerifyFailure(null);
      setCodeError(undefined);
      setStep("code");
    } catch (error) {
      setRequestFailure(classifyPinError(error));
    }
  }

  // 423 on verify: the code is used up, not the PIN. Back to the request step.
  function requestNewCode() {
    clearFieldErrors();
    setRequestFailure(null);
    setStep("choose");
  }

  function clearFieldErrors() {
    setCodeError(undefined);
    setPinError(undefined);
    setConfirmError(undefined);
    setVerifyFailure(null);
  }

  async function handleVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (verifying) return;
    clearFieldErrors();

    if (!isCompletePin(code)) {
      setCodeError(t("payslipPinForgot.codeIncomplete"));
      focusField("code");
      return;
    }
    const check = validateNewPin(pin, confirm);
    if (!check.ok) {
      const message = t(`payslipPin.validation.${check.reason}`);
      if (check.reason === "mismatch") {
        setConfirmError(message);
        focusField("confirm");
      } else {
        setPinError(message);
        focusField("pin");
      }
      return;
    }

    try {
      await verifyOtp.mutateAsync({
        code,
        pin,
        idempotencyKey: newIdempotencyKey(),
      });
      setCode("");
      setPin("");
      setConfirm("");
      setStep("done");
      // Nothing keeps the code or the PIN once the success screen shows.
      verifyOtp.reset();
      requestOtp.reset();
    } catch (error) {
      const failure = classifyPinError(error);
      setCode("");
      if (failure.kind === "invalid") {
        setCodeError(t("payslipPinForgot.codeInvalid"));
        focusField("code");
        return;
      }
      setPin("");
      setConfirm("");
      setVerifyFailure(failure);
      focusField("code");
    }
  }

  // ---- done: the new PIN is active (copy of the pin-tersimpan screen) -------
  if (step === "done") {
    return (
      <PinLayout
        backLink={<BackLink />}
        title={t("payslipPin.pinTersimpan.title")}
        description={t("payslipPin.pinTersimpan.description")}
        side={t("payslipPinForgot.doneSide")}
      >
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-container bg-success-subtle text-success">
            <CircleCheck className="size-5" aria-hidden="true" />
          </span>
          <Notice
            tone="success"
            title={t("payslipPin.pinTersimpan.noticeTitle")}
          >
            {t("payslipPin.pinTersimpan.notice")}
          </Notice>
        </div>
        <Button asChild size="lg" className="w-full">
          <Link to="/karyawan/slip-gaji">
            {t("payslipPin.pinTersimpan.continue")}
          </Link>
        </Button>
      </PinLayout>
    );
  }

  // ---- 429: too many code requests (mockup kode-dibatasi) -------------------
  // Only from the request step: inside the code step the notice is inline.
  if (step === "choose" && requestFailure?.kind === "rate_limited") {
    return (
      <PinLayout
        backLink={<BackLink />}
        title={t("payslipPin.kodeDibatasi.title")}
        description={t("payslipPin.kodeDibatasi.description")}
        side={t("payslipPin.kodeDibatasi.side")}
      >
        <Notice tone="danger" title={t("payslipPin.kodeDibatasi.noticeTitle")}>
          {t("payslipPin.kodeDibatasi.notice")}
        </Notice>
        <BackToListButton />
      </PinLayout>
    );
  }

  // ---- code entry -----------------------------------------------------------
  if (step === "code") {
    const locked = verifyFailure?.kind === "locked";
    const unavailable =
      verifyFailure?.kind === "unavailable" ||
      requestFailure?.kind === "unavailable";
    const rateLimited =
      verifyFailure?.kind === "rate_limited" ||
      requestFailure?.kind === "rate_limited";
    const requestFailed =
      requestFailure !== null &&
      requestFailure.kind !== "unavailable" &&
      requestFailure.kind !== "rate_limited";
    const generic =
      verifyFailure !== null &&
      (verifyFailure.kind === "network" ||
        verifyFailure.kind === "unknown" ||
        verifyFailure.kind === "not_found");

    return (
      <PinLayout
        backLink={<BackLink />}
        title={t("payslipPin.kodeWa.title")}
        description={t("payslipPin.kodeWa.description")}
        side={t("payslipPin.kodeWa.side")}
        busy={verifying}
      >
        <Notice tone="neutral" title={t("payslipPin.kodeWa.sent")} />
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => void handleVerify(event)}
        >
          <FormField
            label={t("payslipPin.kodeWa.codeLabel")}
            hint={t("payslipPinForgot.codeHint")}
            error={codeError}
            required
          >
            <PinCodeInput
              ref={codeRef}
              name="otp-code"
              mask={false}
              value={code}
              onChange={(next) => {
                setCode(next);
                setCodeError(undefined);
              }}
              disabled={verifying || locked}
              autoComplete="one-time-code"
            />
          </FormField>
          <FormField
            label={t("payslipPin.buatPin.newLabel")}
            hint={t("payslipPinForgot.newPinHint")}
            error={pinError}
            required
          >
            <PinCodeInput
              ref={pinRef}
              name="new-pin"
              value={pin}
              onChange={(next) => {
                setPin(next);
                setPinError(undefined);
              }}
              disabled={verifying || locked}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label={t("payslipPin.buatPin.confirmLabel")}
            error={confirmError}
            required
          >
            <PinCodeInput
              ref={confirmRef}
              name="confirm-pin"
              value={confirm}
              onChange={(next) => {
                setConfirm(next);
                setConfirmError(undefined);
              }}
              disabled={verifying || locked}
              autoComplete="off"
            />
          </FormField>

          {locked && (
            <Notice tone="danger" title={t("payslipPinForgot.lockedTitle")}>
              {t("payslipPinForgot.lockedBody")}
            </Notice>
          )}
          {unavailable && (
            <Notice
              tone="neutral"
              title={t("payslipPin.lupaPin.whatsappTitle")}
            >
              {t("payslipPinForgot.unavailableNotice")}
            </Notice>
          )}
          {rateLimited && (
            <Notice
              tone="danger"
              title={t("payslipPin.kodeDibatasi.noticeTitle")}
            >
              {t("payslipPin.kodeDibatasi.notice")}
            </Notice>
          )}
          {generic && (
            <Notice
              tone="danger"
              title={t("payslipPinForgot.verifyErrorTitle")}
            >
              {t("payslipPinForgot.verifyError")}
            </Notice>
          )}
          {verifyFailure?.kind === "not_set" && (
            <Notice tone="neutral" title={t("payslipPinForgot.notSetTitle")}>
              {t("payslipPinForgot.notSetBody")}
            </Notice>
          )}
          {requestFailed && (
            <Notice
              tone="danger"
              title={t("payslipPinForgot.requestErrorTitle")}
            >
              {t("payslipPinForgot.requestError")}
            </Notice>
          )}

          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={verifying}
            disabled={locked}
          >
            {verifying
              ? t("payslipPin.kodeWa.verifying")
              : t("payslipPin.kodeWa.verifySubmit")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            loading={requesting}
            disabled={verifying || (!locked && sends >= MAX_CODE_SENDS)}
            onClick={() => (locked ? requestNewCode() : void sendCode())}
          >
            {requesting
              ? t("payslipPin.kodeWa.requesting")
              : locked
                ? t("payslipPinForgot.newCode")
                : t("payslipPinForgot.resend")}
          </Button>
        </form>
      </PinLayout>
    );
  }

  // ---- choose: request a code, or ask HR (mockup lupa-pin) ------------------
  const unavailable = requestFailure?.kind === "unavailable";
  const failed =
    requestFailure !== null && requestFailure.kind !== "unavailable";

  return (
    <PinLayout
      backLink={<BackLink />}
      title={t("payslipPin.lupaPin.title")}
      description={t("payslipPin.lupaPin.description")}
      side={t("payslipPin.lupaPin.side")}
      busy={requesting}
    >
      {unavailable && (
        <Notice tone="neutral" title={t("payslipPin.lupaPin.whatsappTitle")}>
          {t("payslipPinForgot.unavailableNotice")}
        </Notice>
      )}
      {failed && (
        <Notice tone="danger" title={t("payslipPinForgot.requestErrorTitle")}>
          {t("payslipPinForgot.requestError")}
        </Notice>
      )}
      <Button
        type="button"
        size="lg"
        className="w-full"
        loading={requesting}
        onClick={() => void sendCode()}
      >
        {requesting
          ? t("payslipPin.kodeWa.requesting")
          : t("payslipPin.kodeWa.requestSubmit")}
      </Button>

      <section className="grid gap-2 border-t border-border pt-4">
        <h3 className="font-brand type-title">
          {t("payslipPin.lupaPin.hrTitle")}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("payslipPin.lupaPin.hrBody")}
        </p>
      </section>
      <BackToListButton />
    </PinLayout>
  );
}
