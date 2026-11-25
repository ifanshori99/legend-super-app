// Change the payslip PIN (bead legend-ilzrj, slice S4; mockup
// design/mockups/payslip-pin/ubah-pin). Current PIN + new PIN + repeat. A wrong
// current PIN counts as an attempt (same counter as opening a payslip): it
// shows the attempts left next to the field, and a lock shows the locked copy.
// Only the PIN status is read here; no payslip amount is ever on this screen.
import { useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, CircleCheck, Info } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { newIdempotencyKey } from "@/lib/idempotency";
import { usePayslipPinStatus, useSetPayslipPin } from "../pin-hooks.ts";
import {
  classifyPinError,
  isCompletePin,
  pinStatusView,
  validateNewPin,
  type PinErrorState,
} from "../pin-state.ts";
import { PinCodeInput } from "./pin-code-input.tsx";
import { PinLayout } from "./pin-layout.tsx";
import { PinLocked } from "./pin-locked.tsx";

type PinChangeProps = {
  /** Called from the success screen ("Lanjut ke slip gaji"). */
  onDone?: () => void;
};

type FieldErrors = {
  current?: string;
  next?: string;
  confirm?: string;
};

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

/** Notice box: icon, bold title, one sentence. */
function Notice({
  icon: Icon,
  title,
  children,
  role,
}: {
  icon: typeof Info;
  title: string;
  children: string;
  role?: "status" | "alert";
}) {
  return (
    <div
      role={role}
      className="flex items-start gap-3 rounded-container bg-muted p-4"
    >
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="grid gap-0.5">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-sm leading-5 text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function PinChangeSkeleton() {
  const t = useT();
  return (
    <PinLayout
      busy
      backLink={<BackLink />}
      title={t("payslipPin.ubahPin.title")}
      description={t("payslipPin.ubahPin.description")}
    >
      <p className="sr-only" role="status">
        {t("payslipPin.memuat.status")}
      </p>
      <div className="grid gap-5" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <div key={row} className="grid gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-12 w-full max-w-72" />
          </div>
        ))}
        <Skeleton className="h-control-lg w-full" />
      </div>
    </PinLayout>
  );
}

function PinChange({ onDone }: PinChangeProps) {
  const t = useT();
  const status = usePayslipPinStatus();
  const setPin = useSetPayslipPin();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<string | null | undefined>(
    undefined,
  );
  const [notSet, setNotSet] = useState(false);
  const [saved, setSaved] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  // Autofocus only where a hardware keyboard is likely; a touch screen would
  // pop its keypad over the form before the person asked for it.
  const autoFocus =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: fine)").matches;

  const submitting = setPin.isPending;

  /** Moves focus to the first field that shows an error. */
  function focusFirstError(found: FieldErrors) {
    const target = found.current
      ? currentRef
      : found.next
        ? nextRef
        : found.confirm
          ? confirmRef
          : null;
    // Wait a frame: the field may still be disabled for the request in flight.
    requestAnimationFrame(() => target?.current?.focus());
  }

  function clearFeedback() {
    setErrors({});
    setFormError(null);
  }

  function handleFailure(error: PinErrorState) {
    switch (error.kind) {
      case "invalid":
        // The typed PIN is wrong: clear it so the next try starts clean.
        setCurrent("");
        {
          const found = {
            current:
              error.remainingAttempts === null
                ? t("payslipPin.change.currentWrong")
                : t("payslipPin.change.currentWrongLeft", {
                    count: error.remainingAttempts,
                  }),
          };
          setErrors(found);
          focusFirstError(found);
        }
        return;
      case "locked":
        setCurrent("");
        setLockedUntil(error.lockedUntil);
        return;
      case "not_set":
        setNotSet(true);
        return;
      case "rate_limited":
        setFormError(t("payslipPin.change.rateLimitedError"));
        return;
      case "unavailable":
        setFormError(t("payslipPin.change.unavailableError"));
        return;
      case "not_found":
        setFormError(t("payslipPin.change.notFoundError"));
        return;
      case "network":
        setFormError(t("payslipPin.change.networkError"));
        return;
      default:
        setFormError(t("payslipPin.change.unknownError"));
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    clearFeedback();

    const found: FieldErrors = {};
    if (!isCompletePin(current)) {
      found.current = t("payslipPin.change.currentRequired");
    }
    const check = validateNewPin(next, confirm);
    if (!check.ok) {
      const message = t(`payslipPin.validation.${check.reason}`);
      if (check.reason === "mismatch") found.confirm = message;
      else found.next = message;
    } else if (next === current) {
      found.next = t("payslipPin.change.sameAsCurrent");
    }
    if (found.current || found.next || found.confirm) {
      setErrors(found);
      focusFirstError(found);
      return;
    }

    setPin.mutate(
      { pin: next, currentPin: current, idempotencyKey: newIdempotencyKey() },
      {
        onSuccess: () => {
          // The mutation held both PINs; drop them now that the result shows.
          setPin.reset();
          setCurrent("");
          setNext("");
          setConfirm("");
          setSaved(true);
        },
        onError: (error) => handleFailure(classifyPinError(error)),
      },
    );
  }

  if (saved) {
    return (
      <PinLayout
        backLink={<BackLink />}
        title={t("payslipPin.change.successTitle")}
        description={t("payslipPin.change.successDescription")}
        side={t("payslipPin.pinTersimpan.side")}
      >
        <Notice
          icon={CircleCheck}
          role="status"
          title={t("payslipPin.pinTersimpan.noticeTitle")}
        >
          {t("payslipPin.pinTersimpan.notice")}
        </Notice>
        {onDone ? (
          <Button type="button" size="lg" className="w-full" onClick={onDone}>
            {t("payslipPin.pinTersimpan.continue")}
          </Button>
        ) : (
          <Button asChild size="lg" className="w-full">
            <Link to="/karyawan/slip-gaji">
              {t("payslipPin.pinTersimpan.continue")}
            </Link>
          </Button>
        )}
      </PinLayout>
    );
  }

  if (status.isPending) return <PinChangeSkeleton />;

  if (status.isError) {
    return (
      <PinLayout
        backLink={<BackLink />}
        title={t("payslipPin.ubahPin.title")}
        description={t("payslipPin.ubahPin.description")}
      >
        <ErrorState
          title={t("payslipPin.change.statusErrorTitle")}
          description={t("payslipPin.change.statusErrorHint")}
          onRetry={() => void status.refetch()}
        />
      </PinLayout>
    );
  }

  const view = pinStatusView(status.data, new Date());
  const lockKnown = lockedUntil !== undefined;

  if (notSet || (!lockKnown && view === "create")) {
    return (
      <PinLayout
        backLink={<BackLink />}
        title={t("payslipPin.change.notSetTitle")}
        description={t("payslipPin.change.notSetHint")}
      >
        <Button asChild variant="outline" size="lg" className="w-full">
          <Link to="/karyawan/slip-gaji">
            {t("payslipPin.common.backToList")}
          </Link>
        </Button>
      </PinLayout>
    );
  }

  if (lockKnown || view === "locked") {
    return (
      <PinLayout
        backLink={<BackLink />}
        title={t("payslipPin.terkunci.title")}
        description={t("payslipPin.terkunci.description")}
        side={t("payslipPin.terkunci.side")}
      >
        <PinLocked
          lockedUntil={lockKnown ? lockedUntil : status.data.lockedUntil}
          onUnlocked={() => {
            setLockedUntil(undefined);
            void status.refetch();
          }}
        />
      </PinLayout>
    );
  }

  return (
    <PinLayout
      busy={submitting}
      backLink={<BackLink />}
      title={t("payslipPin.ubahPin.title")}
      description={t("payslipPin.ubahPin.description")}
      side={t("payslipPin.ubahPin.side")}
    >
      <form
        className="grid gap-5"
        noValidate
        onSubmit={handleSubmit}
        aria-busy={submitting || undefined}
      >
        <FormField
          label={t("payslipPin.ubahPin.currentLabel")}
          error={errors.current}
          required
        >
          <PinCodeInput
            ref={currentRef}
            name="current-pin"
            autoFocus={autoFocus}
            value={current}
            onChange={(value) => {
              setCurrent(value);
              if (errors.current) setErrors({ ...errors, current: undefined });
            }}
            disabled={submitting}
            autoComplete="off"
          />
        </FormField>
        <FormField
          label={t("payslipPin.ubahPin.newLabel")}
          error={errors.next}
          required
        >
          <PinCodeInput
            ref={nextRef}
            name="new-pin"
            value={next}
            onChange={(value) => {
              setNext(value);
              if (errors.next) setErrors({ ...errors, next: undefined });
            }}
            disabled={submitting}
            autoComplete="off"
          />
        </FormField>
        <FormField
          label={t("payslipPin.ubahPin.confirmLabel")}
          error={errors.confirm}
          required
        >
          <PinCodeInput
            ref={confirmRef}
            name="confirm-new-pin"
            value={confirm}
            onChange={(value) => {
              setConfirm(value);
              if (errors.confirm) setErrors({ ...errors, confirm: undefined });
            }}
            disabled={submitting}
            autoComplete="off"
          />
        </FormField>

        {formError && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {formError}
          </p>
        )}

        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          {submitting
            ? t("payslipPin.ubahPin.submitting")
            : t("payslipPin.ubahPin.submit")}
        </Button>
        <Button asChild variant="link" className="mx-auto min-h-11 sm:min-h-0">
          <Link to="/karyawan/slip-gaji/lupa-pin">
            {t("payslipPin.ubahPin.forgotCurrent")}
          </Link>
        </Button>
      </form>
    </PinLayout>
  );
}

export { PinChange };
export type { PinChangeProps };
