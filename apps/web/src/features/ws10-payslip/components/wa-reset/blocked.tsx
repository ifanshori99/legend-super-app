// Dead-end screens of the WhatsApp reset (bead ur82k; mockups kode-kedaluwarsa,
// nomor-tidak-cocok, terlalu-banyak-percobaan, nomor-belum-terdaftar, plus
// "nomor belum 3 hari", the generic 409 and 503). Each one gives a way on:
// a new code, the HR guide or back to the list. Pure: the container decides
// which `kind` applies and what the buttons do.
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { PinLayout } from "../pin-layout.tsx";
import {
  WRAP_BUTTON_CLASS,
  WaBackLink,
  WaNotice,
  WaPrivatePinSide,
} from "./parts.tsx";

type WaResetBlockedKind =
  | "expired"
  | "mismatch"
  | "rate-limited"
  | "no-wa"
  | "too-new"
  | "unavailable-generic"
  | "service-unavailable";

type WaResetBlockedProps = {
  kind: WaResetBlockedKind;
  /** Server wait for `rate-limited`; without it "Coba lagi nanti" is shown,
   * with no number. */
  retryAfterSeconds?: number;
  /** Registered-number hint for `mismatch` (last digits or a masked number). */
  senderHint?: string;
  /** The old code for `expired`: shown struck through when present. */
  code?: string;
  /** `mismatch`: go back to the waiting screen (polling kept running). */
  onWaitMore?: () => void;
  onRetry?: () => void;
  /** True while a new code is being asked for: the retry button spins. */
  retrying?: boolean;
  onHrHelp: () => void;
  onBack: () => void;
};

const BODY_CLASS =
  "text-base leading-6 text-muted-foreground md:text-sm md:leading-5";

function registeredNumber(hint: string): string {
  return /^\d{1,4}$/.test(hint) ? `•••• ${hint}` : hint;
}

function formatWait(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Seconds left until a deadline fixed on mount, ticking once a second. */
function useCountdown(seconds: number | undefined): number | null {
  const [deadline] = useState(() =>
    seconds === undefined ? null : Date.now() + seconds * 1000,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);

  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

function RateLimitedWait({ left }: { left: number | null }) {
  const t = useT();
  return (
    <div
      role={left === null ? "status" : "timer"}
      aria-live="off"
      className="flex items-center gap-3 rounded-field border-l-4 border-danger bg-danger-subtle p-4"
    >
      <Clock className="size-5 shrink-0 text-danger" aria-hidden="true" />
      <p className="text-base leading-6 font-semibold tabular-nums md:text-sm md:leading-5">
        {left === null
          ? t("payslipWaReset.blocked.retryLater")
          : left > 0
            ? t("payslipWaReset.blocked.retryIn", { time: formatWait(left) })
            : t("payslipWaReset.blocked.restrictionOver")}
      </p>
    </div>
  );
}

function WaResetBlocked({
  kind,
  retryAfterSeconds,
  senderHint,
  code,
  onWaitMore,
  onRetry,
  retrying = false,
  onHrHelp,
  onBack,
}: WaResetBlockedProps) {
  const t = useT();
  const secondsLeft = useCountdown(
    kind === "rate-limited" ? retryAfterSeconds : undefined,
  );
  // Without a server wait there is nothing to count down: retry is offered.
  const canRetryNow =
    kind === "rate-limited" &&
    (secondsLeft === null || secondsLeft === 0) &&
    onRetry !== undefined;

  const retryButton = (label: string, primary = true) =>
    onRetry && (
      <Button
        type="button"
        size="lg"
        variant={primary ? "default" : "outline"}
        className={WRAP_BUTTON_CLASS}
        loading={retrying}
        onClick={onRetry}
      >
        {retrying ? t("payslipWaReset.blocked.creatingCode") : label}
      </Button>
    );

  // HR help is a link while it is the side road ("Lihat cara minta bantuan");
  // it is a button where it is the main way on, or the urgent wording.
  const hrButton = (primary: boolean) => {
    const urgent = kind === "expired" || kind === "service-unavailable";
    const asLink = !primary && !urgent;
    return (
      <Button
        type="button"
        size={asLink ? "sm" : "lg"}
        variant={primary ? "default" : asLink ? "link" : "outline"}
        className={asLink ? "min-h-6 w-fit py-1" : WRAP_BUTTON_CLASS}
        onClick={onHrHelp}
      >
        {urgent
          ? t("payslipWaReset.blocked.hrHelpUrgent")
          : t("payslipWaReset.common.hrHelpLink")}
      </Button>
    );
  };
  const backButton = (
    <Button
      type="button"
      size="lg"
      variant="outline"
      className={WRAP_BUTTON_CLASS}
      onClick={onBack}
    >
      {t("payslipWaReset.common.backToSlip")}
    </Button>
  );

  if (kind === "expired") {
    return (
      <PinLayout
        backLink={<WaBackLink />}
        title={t("payslipWaReset.blocked.expiredTitle")}
        description={t("payslipWaReset.blocked.expiredDescription")}
      >
        {code && (
          <WaNotice
            tone="neutral"
            title={t("payslipWaReset.blocked.expiredNoticeTitle")}
          >
            <span className="whitespace-nowrap">
              <code
                translate="no"
                className="font-mono font-semibold text-foreground line-through"
              >
                {code}
              </code>
              {" · "}
              <span className="tabular-nums">00:00</span>
            </span>
          </WaNotice>
        )}
        {retryButton(t("payslipWaReset.blocked.newCode"))}
        {hrButton(false)}
      </PinLayout>
    );
  }

  if (kind === "mismatch") {
    return (
      <PinLayout
        backLink={<WaBackLink />}
        title={t("payslipWaReset.blocked.mismatchTitle")}
        description={t("payslipWaReset.blocked.mismatchDescription")}
      >
        <WaNotice
          tone="neutral"
          title={t("payslipWaReset.blocked.mismatchNoticeTitle")}
        >
          {senderHint
            ? t("payslipWaReset.blocked.mismatchWithNumber", {
                number: registeredNumber(senderHint),
              })
            : t("payslipWaReset.blocked.mismatchNoNumber")}
        </WaNotice>
        {onWaitMore && (
          <Button
            type="button"
            size="lg"
            className={WRAP_BUTTON_CLASS}
            disabled={retrying}
            onClick={onWaitMore}
          >
            {t("payslipWaReset.blocked.waitMore")}
          </Button>
        )}
        {retryButton(t("payslipWaReset.blocked.retryRegistered"), !onWaitMore)}
        <section className="grid gap-2 border-t border-border pt-4">
          <h3 className="font-brand type-title">
            {t("payslipWaReset.blocked.numberChangedTitle")}
          </h3>
          <p className={BODY_CLASS}>
            {t("payslipWaReset.blocked.numberChangedBody")}
          </p>
          {hrButton(false)}
        </section>
      </PinLayout>
    );
  }

  if (kind === "rate-limited") {
    return (
      <PinLayout
        backLink={<WaBackLink />}
        title={t("payslipWaReset.blocked.rateLimitedTitle")}
        description={t("payslipWaReset.blocked.rateLimitedDescription")}
      >
        <RateLimitedWait left={secondsLeft} />
        <p className={BODY_CLASS}>
          {t("payslipWaReset.blocked.rateLimitedBody")}
        </p>
        {canRetryNow && retryButton(t("payslipWaReset.common.retry"))}
        {hrButton(!canRetryNow)}
        {backButton}
      </PinLayout>
    );
  }

  if (kind === "no-wa") {
    return (
      <PinLayout
        backLink={<WaBackLink />}
        title={t("payslipWaReset.blocked.noWaTitle")}
        description={t("payslipWaReset.blocked.noWaDescription")}
        side={<WaPrivatePinSide />}
      >
        <WaNotice
          tone="neutral"
          title={t("payslipWaReset.blocked.outletHelpTitle")}
        >
          {t("payslipWaReset.blocked.noWaNotice")}
        </WaNotice>
        {hrButton(true)}
        {backButton}
      </PinLayout>
    );
  }

  if (kind === "too-new") {
    return (
      <PinLayout
        backLink={<WaBackLink />}
        title={t("payslipWaReset.blocked.tooNewTitle")}
        description={t("payslipWaReset.blocked.tooNewDescription")}
        side={<WaPrivatePinSide />}
      >
        <WaNotice
          tone="neutral"
          title={t("payslipWaReset.blocked.unavailableNoticeTitle")}
        >
          {t("payslipWaReset.blocked.tooNewNotice")}
        </WaNotice>
        {hrButton(true)}
        {backButton}
      </PinLayout>
    );
  }

  if (kind === "unavailable-generic") {
    return (
      <PinLayout
        backLink={<WaBackLink />}
        title={t("payslipWaReset.blocked.unavailableNoticeTitle")}
        description={t("payslipWaReset.blocked.genericDescription")}
        side={<WaPrivatePinSide />}
      >
        <WaNotice
          tone="neutral"
          title={t("payslipWaReset.blocked.outletHelpTitle")}
        >
          {t("payslipWaReset.blocked.genericNotice")}
        </WaNotice>
        {hrButton(true)}
        {backButton}
      </PinLayout>
    );
  }

  // service-unavailable (503): calm notice, never a toast.
  return (
    <PinLayout
      backLink={<WaBackLink />}
      title={t("payslipWaReset.blocked.serviceTitle")}
      description={t("payslipWaReset.blocked.serviceDescription")}
    >
      <WaNotice
        tone="neutral"
        title={t("payslipWaReset.blocked.serviceNoticeTitle")}
      >
        {t("payslipWaReset.blocked.serviceNotice")}
      </WaNotice>
      {retryButton(t("payslipWaReset.common.retry"))}
      {hrButton(!onRetry)}
      {backButton}
    </PinLayout>
  );
}

export { WaResetBlocked };
export type { WaResetBlockedKind, WaResetBlockedProps };
