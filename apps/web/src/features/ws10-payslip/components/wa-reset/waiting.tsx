// "Kirim lewat WhatsApp" (mockups menunggu-whatsapp and kode-disalin). Shows the
// recovery message, the Buka WhatsApp button (wa.me link with the text filled
// in), a QR of the same link on wide screens, the copy paths for another
// device, and a countdown. Pure component: the container polls the server and
// decides when to leave; the local countdown only informs, it never verifies.
// Copying or opening WhatsApp is never shown as success of the verification.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronLeft,
  Clock,
  Copy,
  LoaderCircle,
  MessageCircle,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { QrCode } from "@/components/ui/qr-code";
import { isWaMeLink } from "../../wa-reset-api.ts";
import { PinLayout } from "../pin-layout.tsx";

// "6281200004250" -> "+62 812-0000-4250" so the number can be read back
// when typed on another phone. Copy still uses the raw digits.
function formatWaNumber(digits: string): string {
  const m = /^62(\d{3})(\d+)$/.exec(digits);
  if (!m) return `+${digits}`;
  const groups = m[2].match(/\d{1,4}/g) ?? [];
  return `+62 ${[m[1], ...groups].join("-")}`;
}

type WaResetWaitingProps = {
  /** Code from the server, e.g. "K7Q4-M2XD". */
  code: string;
  /** https://wa.me/<number>?text=<message> */
  waLink: string;
  /** Last digits of the employee's own number, or an already masked number. */
  senderHint: string;
  /** ISO time the code stops being valid. */
  expiresAt: string;
  /**
   * True once the container has asked the server one last time after
   * `expiresAt` and the code is still not verified. Until then a passed clock
   * only says the code is being checked, never that it expired.
   */
  expired?: boolean;
  onCopied?: () => void;
  /** "Sent but not verified?": the employee suspects the wrong number. */
  onNotVerified?: () => void;
  /** Ask the server for a new code. */
  onRegenerate: () => void;
  /** True while the new code is being asked for: the button waits. */
  regenerating?: boolean;
  onCancel: () => void;
  onHrHelp: () => void;
};

type Copied = "code" | "number" | null;

/** The text the employee sends; the server only accepts exactly this shape. */
const RESET_KEYWORD = "RESET PIN";

function messageFor(code: string): string {
  return `${RESET_KEYWORD} ${code}`;
}

/** The receiving number out of the wa.me link ("" when it cannot be read). */
function receivingNumber(waLink: string): string {
  return /wa\.me\/(\d+)/.exec(waLink)?.[1] ?? "";
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function senderText(hint: string, lead: string): ReactNode {
  const shown = /^\d{1,4}$/.test(hint) ? `•••• ${hint}` : hint;
  return (
    <>
      {lead}{" "}
      <span translate="no" className="whitespace-nowrap">
        {shown}
      </span>
      .
    </>
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function WaResetWaiting({
  code,
  waLink,
  senderHint,
  expiresAt,
  expired = false,
  onCopied,
  onNotVerified,
  onRegenerate,
  regenerating = false,
  onCancel,
  onHrHelp,
}: WaResetWaitingProps) {
  const t = useT();
  const message = messageFor(code);
  const number = receivingNumber(waLink);
  // A link that is not wa.me/<digits> is never opened or turned into a QR.
  const linkOk = isWaMeLink(waLink);

  // null until mounted: the server render has no clock to agree with.
  const [now, setNow] = useState<number | null>(null);
  const [copied, setCopied] = useState<Copied>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- state follows the polled challenge status
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const remainingMs = now === null ? null : Date.parse(expiresAt) - now;
  const checking = !expired && remainingMs !== null && remainingMs <= 0;

  async function copy(kind: Exclude<Copied, null>, text: string) {
    const ok = await writeClipboard(text);
    if (timer.current) clearTimeout(timer.current);
    setCopyFailed(!ok);
    if (!ok) {
      setCopied(null);
      return;
    }
    setCopied(kind);
    if (kind === "code") onCopied?.();
    // The button label goes back after a moment; the status text stays polite.
    timer.current = setTimeout(() => setCopied(null), 2500);
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
      title={t("payslipWaReset.waiting.title")}
      description={senderText(
        senderHint,
        t("payslipWaReset.waiting.senderLead"),
      )}
    >
      <div className="grid gap-1 rounded-field border border-border bg-muted p-4">
        <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
          {t("payslipWaReset.waiting.messageLabel")}
        </p>
        <p
          className="text-xl font-bold tracking-wide"
          data-testid="wa-reset-message"
          translate="no"
        >
          {RESET_KEYWORD}{" "}
          <code translate="no" className="font-[inherit] whitespace-nowrap">
            {code}
          </code>
        </p>
        <p className="flex items-center gap-1.5 text-base leading-6 tabular-nums md:text-sm md:leading-5 text-muted-foreground">
          <Clock className="size-4 shrink-0" aria-hidden="true" />
          {remainingMs === null
            ? t("payslipWaReset.waiting.soon")
            : expired
              ? t("payslipWaReset.waiting.expiredStatus")
              : checking
                ? t("payslipWaReset.waiting.checking")
                : t("payslipWaReset.waiting.remaining", {
                    time: formatRemaining(remainingMs),
                  })}
        </p>
      </div>

      {expired || !linkOk ? (
        <div role="alert" className="grid gap-3">
          <p className="text-base leading-6 md:text-sm md:leading-5">
            {expired
              ? t("payslipWaReset.waiting.expiredBody")
              : t("payslipWaReset.waiting.badLinkBody")}
          </p>
          <Button
            type="button"
            size="lg"
            className="h-auto min-h-control w-full whitespace-normal"
            onClick={onRegenerate}
            loading={regenerating}
          >
            {regenerating
              ? t("payslipWaReset.waiting.creatingCode")
              : t("payslipWaReset.waiting.newCode")}
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          <Button
            asChild
            size="lg"
            className="h-auto min-h-control w-full whitespace-normal"
          >
            <a href={waLink} target="_blank" rel="noopener noreferrer">
              <MessageCircle aria-hidden="true" />
              {t("payslipWaReset.waiting.openWhatsApp")}
            </a>
          </Button>
          <p className="text-base leading-6 text-muted-foreground md:text-sm md:leading-5">
            {t("payslipWaReset.waiting.prefilled")}
          </p>
          {/* A code for another device to scan; a phone already has the button.
              Below the button, never beside it, so no column of buttons shares
              a row with it at any width. */}
          <div className="hidden justify-items-center gap-2 md:grid">
            <QrCode
              value={waLink}
              label={t("payslipWaReset.waiting.qrLabel")}
              size={152}
              className="rounded-field border border-border p-2"
            />
            <p className="max-w-xs text-center text-sm leading-5 text-muted-foreground">
              {t("payslipWaReset.waiting.qrHint")}
            </p>
          </div>
          <div className="grid gap-0.5" role="status" aria-live="polite">
            <p className="flex items-center gap-2 text-base font-bold">
              <LoaderCircle
                aria-hidden="true"
                className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
              />
              {t("payslipWaReset.waiting.waiting")}
            </p>
            <p className="text-base leading-6 md:text-sm md:leading-5 text-muted-foreground">
              {t("payslipWaReset.waiting.waitingHint")}
            </p>
          </div>
          {onNotVerified && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="min-h-11 w-fit justify-start py-1 sm:min-h-6"
              onClick={onNotVerified}
            >
              {t("payslipWaReset.waiting.notVerified")}
            </Button>
          )}
        </div>
      )}

      {!expired && (
        <div className="grid gap-3 border-t border-border pt-4">
          <div className="grid gap-0.5">
            <p className="text-base font-bold">
              {t("payslipWaReset.waiting.otherDeviceTitle")}
            </p>
            <p className="text-base leading-6 md:text-sm md:leading-5 text-muted-foreground">
              {t("payslipWaReset.waiting.otherDeviceBody")}
              {number ? (
                <>
                  :{" "}
                  <strong
                    translate="no"
                    className="whitespace-nowrap text-foreground"
                  >
                    {formatWaNumber(number)}
                  </strong>
                </>
              ) : (
                "."
              )}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-control whitespace-normal"
              onClick={() => void copy("code", message)}
            >
              {copied === "code" ? (
                <Check aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
              {t("payslipWaReset.waiting.copyMessage")}
            </Button>
            {number && (
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-control whitespace-normal"
                onClick={() => void copy("number", `+${number}`)}
              >
                {copied === "number" ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
                {t("payslipWaReset.waiting.copyNumber")}
              </Button>
            )}
          </div>
          <p
            role="status"
            aria-live="polite"
            className="text-base leading-6 empty:-mt-3 md:text-sm md:leading-5 text-muted-foreground"
          >
            {copied === "code" && t("payslipWaReset.waiting.copiedMessage")}
            {copied === "number" && t("payslipWaReset.waiting.copiedNumber")}
            {copyFailed && t("payslipWaReset.waiting.copyFailed")}
          </p>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-control whitespace-normal"
          onClick={onHrHelp}
        >
          {t("payslipWaReset.common.hrHelpTitle")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("payslipPin.common.cancel")}
        </Button>
      </div>
    </PinLayout>
  );
}

export { WaResetWaiting };
export type { WaResetWaitingProps };
