// Dead-end screens of the WhatsApp reset (bead ur82k; mockups kode-kedaluwarsa,
// nomor-tidak-cocok, terlalu-banyak-percobaan, nomor-belum-terdaftar, plus
// "nomor belum 3 hari", the generic 409 and 503). Each one gives a way on:
// a new code, the HR guide or back to the list. Pure: the container decides
// which `kind` applies and what the buttons do.
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PinLayout } from "../pin-layout.tsx";
import {
  PRIVATE_PIN_SIDE,
  WRAP_BUTTON_CLASS,
  WaBackLink,
  WaNotice,
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

const HR_LABEL = "Lihat cara minta bantuan";
// Founder's wording, used only where no WhatsApp is registered; every other
// screen says "HR atau supervisor".
const HR_CONTACT_NO_WA = "Hubungi HR atau atasan di outlet";
const HR_CONTACT = "Hubungi HR atau supervisor di outlet";
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
  return (
    <div
      role={left === null ? "status" : "timer"}
      aria-live="off"
      className="flex items-center gap-3 rounded-field border-l-4 border-danger bg-danger-subtle p-4"
    >
      <Clock className="size-5 shrink-0 text-danger" aria-hidden="true" />
      <p className="text-base leading-6 font-semibold md:text-sm md:leading-5">
        {left === null
          ? "Coba lagi nanti"
          : left > 0
            ? `Coba lagi dalam ${formatWait(left)}`
            : "Pembatasan sudah selesai"}
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
        {retrying ? "Membuat kode…" : label}
      </Button>
    );

  const hrButton = (primary: boolean) => (
    <Button
      type="button"
      size="lg"
      variant={primary ? "default" : "outline"}
      className={WRAP_BUTTON_CLASS}
      onClick={onHrHelp}
    >
      {kind === "expired" || kind === "service-unavailable"
        ? "Minta bantuan HR atau supervisor"
        : HR_LABEL}
    </Button>
  );
  const backButton = (
    <Button
      type="button"
      size="lg"
      variant="outline"
      className={WRAP_BUTTON_CLASS}
      onClick={onBack}
    >
      Kembali ke slip gaji
    </Button>
  );

  if (kind === "expired") {
    return (
      <PinLayout
        backLink={<WaBackLink />}
        title="Kode sudah kedaluwarsa"
        description="Pesan dengan kode ini tidak bisa dipakai lagi. Buat kode baru, lalu kirim lewat WhatsApp."
      >
        {code && (
          <WaNotice tone="neutral" title="Kode tidak berlaku">
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
        {retryButton("Buat kode baru")}
        {hrButton(false)}
      </PinLayout>
    );
  }

  if (kind === "mismatch") {
    return (
      <PinLayout
        backLink={<WaBackLink />}
        title="Belum ada pesan yang cocok"
        description="Kami belum menerima pesan dengan kode ini dari nomor terdaftar."
      >
        <WaNotice tone="neutral" title="Pastikan nomor yang dipakai">
          {senderHint
            ? `Pastikan WhatsApp memakai nomor terdaftar ${registeredNumber(senderHint)}.`
            : "Pastikan WhatsApp memakai nomor terdaftar."}
        </WaNotice>
        {onWaitMore && (
          <Button
            type="button"
            size="lg"
            className={WRAP_BUTTON_CLASS}
            disabled={retrying}
            onClick={onWaitMore}
          >
            Tunggu lagi
          </Button>
        )}
        {retryButton("Coba dari nomor terdaftar", !onWaitMore)}
        <section className="grid gap-2 border-t border-border pt-4">
          <h3 className="font-brand type-title">Nomor sudah berubah?</h3>
          <p className={BODY_CLASS}>
            Minta bantuan HR atau supervisor di outlet untuk memperbarui nomor
            atau mereset PIN.
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
        title="Terlalu banyak percobaan"
        description="Pemulihan lewat WhatsApp dibatasi sementara. Tunggu sebelum mencoba lagi."
        side={
          retryAfterSeconds !== undefined
            ? "Waktu tunggu berasal dari server."
            : undefined
        }
      >
        <RateLimitedWait left={secondsLeft} />
        <p className={BODY_CLASS}>
          Sambil menunggu, Anda bisa minta reset PIN ke HR atau supervisor di
          outlet.
        </p>
        {canRetryNow && retryButton("Coba lagi")}
        {hrButton(!canRetryNow)}
        {backButton}
      </PinLayout>
    );
  }

  if (kind === "no-wa") {
    return (
      <PinLayout
        backLink={<WaBackLink />}
        title="Nomor WhatsApp belum terdaftar"
        description="Pemulihan lewat WhatsApp belum bisa dipakai. Minta HR atau supervisor di outlet memperbarui nomor atau mereset PIN Anda."
        side={PRIVATE_PIN_SIDE}
      >
        <WaNotice tone="neutral" title="Minta bantuan di outlet">
          {HR_CONTACT_NO_WA} untuk memperbarui nomor atau mereset PIN Anda.
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
        title="Nomor WhatsApp belum 3 hari"
        description="Nomor WhatsApp harus tertaut minimal 3 hari sebelum bisa dipakai untuk memulihkan PIN."
        side={PRIVATE_PIN_SIDE}
      >
        <WaNotice
          tone="neutral"
          title="Pemulihan lewat WhatsApp belum bisa dipakai"
        >
          {HR_CONTACT} untuk mereset PIN Anda, atau coba lagi setelah nomor
          tertaut 3 hari.
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
        title="Pemulihan lewat WhatsApp belum bisa dipakai"
        description="Nomor WhatsApp Anda belum terdaftar, atau baru tertaut kurang dari 3 hari."
        side={PRIVATE_PIN_SIDE}
      >
        <WaNotice tone="neutral" title="Minta bantuan di outlet">
          {HR_CONTACT} untuk memperbarui nomor atau mereset PIN Anda.
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
      title="Pemulihan lewat WhatsApp belum tersedia"
      description="Layanan WhatsApp sedang tidak dapat dihubungi saat ini."
    >
      <WaNotice tone="neutral" title="Coba lagi sebentar lagi">
        {HR_CONTACT} untuk mereset PIN Anda, atau coba lagi nanti.
      </WaNotice>
      {retryButton("Coba lagi")}
      {hrButton(!onRetry)}
      {backButton}
    </PinLayout>
  );
}

export { WaResetBlocked };
export type { WaResetBlockedKind, WaResetBlockedProps };
