// "Kirim lewat WhatsApp" (mockups menunggu-whatsapp and kode-disalin). Shows the
// recovery message, the Buka WhatsApp button (wa.me link with the text filled
// in), a QR of the same link on wide screens, the copy paths for another
// device, and a countdown. Pure component: the container polls the server and
// decides when to leave; the local countdown only informs, it never verifies.
// Copying or opening WhatsApp is never shown as success of the verification.
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, ChevronLeft, Clock, Copy, MessageCircle } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { QrCode } from "@/components/ui/qr-code";
import { PinLayout } from "../pin-layout.tsx";

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
  onCancel: () => void;
  onHrHelp: () => void;
};

type Copied = "code" | "number" | null;

/** The text the employee sends; the server only accepts exactly this shape. */
function messageFor(code: string): string {
  return `RESET PIN ${code}`;
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

function senderText(hint: string): string {
  return /^\d{1,4}$/.test(hint)
    ? `Gunakan nomor terdaftar: •••• ${hint}.`
    : `Gunakan nomor terdaftar: ${hint}.`;
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
  onCancel,
  onHrHelp,
}: WaResetWaitingProps) {
  const t = useT();
  const message = messageFor(code);
  const number = receivingNumber(waLink);

  // null until mounted: the server render has no clock to agree with.
  const [now, setNow] = useState<number | null>(null);
  const [copied, setCopied] = useState<Copied>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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
      title="Kirim lewat WhatsApp"
      description={senderText(senderHint)}
    >
      <div className="grid gap-1 rounded-field border border-border bg-muted p-4">
        <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
          Pesan yang akan dikirim
        </p>
        <p
          className="text-xl font-bold tracking-wide break-all"
          data-testid="wa-reset-message"
        >
          {message}
        </p>
        <p className="flex items-center gap-1.5 text-sm leading-5 text-muted-foreground">
          <Clock className="size-4 shrink-0" aria-hidden="true" />
          {remainingMs === null
            ? "Berlaku sebentar lagi"
            : expired
              ? "Kode sudah tidak berlaku"
              : checking
                ? "Memeriksa pesan Anda…"
                : `Berlaku ${formatRemaining(remainingMs)} lagi`}
        </p>
      </div>

      {expired ? (
        <div role="alert" className="grid gap-3">
          <p className="text-sm leading-5">
            Pesan dengan kode ini tidak bisa dipakai lagi. Buat kode baru, lalu
            kirim lewat WhatsApp.
          </p>
          <Button type="button" size="lg" className="w-full" onClick={onRegenerate}>
            Buat kode baru
          </Button>
        </div>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="grid gap-3">
            <Button asChild size="lg" className="w-full">
              <a href={waLink} target="_blank" rel="noopener noreferrer">
                <MessageCircle aria-hidden="true" />
                Buka WhatsApp
              </a>
            </Button>
            <p className="text-sm leading-5 text-muted-foreground">
              Pesan sudah terisi. Tekan Kirim tanpa mengubahnya, lalu kembali
              ke halaman ini.
            </p>
            <div className="grid gap-0.5" role="status" aria-live="polite">
              <p className="text-base font-bold">Menunggu pesan Anda…</p>
              <p className="text-sm leading-5 text-muted-foreground">
                Verifikasi muncul di sini, tanpa balasan WhatsApp.
              </p>
            </div>
            {onNotVerified && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="w-fit justify-start"
                onClick={onNotVerified}
              >
                Sudah kirim tapi belum terverifikasi?
              </Button>
            )}
          </div>
          {/* A code for another device to scan; a phone already has the button. */}
          <div className="hidden justify-items-center gap-2 md:grid">
            <QrCode
              value={waLink}
              label="Kode QR untuk membuka WhatsApp dengan pesan yang sudah terisi"
              size={152}
              className="rounded-field border border-border p-2"
            />
            <p className="max-w-[10rem] text-center text-xs leading-4 text-muted-foreground">
              Pindai dengan HP yang punya WhatsApp.
            </p>
          </div>
        </div>
      )}

      {!expired && (
        <div className="grid gap-3 border-t border-border pt-4">
          <div className="grid gap-0.5">
            <p className="text-base font-bold">WhatsApp di perangkat lain?</p>
            <p className="text-sm leading-5 text-muted-foreground">
              Kirim pesan di atas ke nomor WhatsApp layanan
              {number ? (
                <>
                  : <strong className="text-foreground">+{number}</strong>
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
              onClick={() => void copy("code", message)}
            >
              {copied === "code" ? (
                <Check aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
              {copied === "code" ? "Kode disalin" : "Salin kode"}
            </Button>
            {number && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void copy("number", `+${number}`)}
              >
                {copied === "number" ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
                {copied === "number" ? "Nomor disalin" : "Salin nomor tujuan"}
              </Button>
            )}
          </div>
          <p
            role="status"
            aria-live="polite"
            className="min-h-5 text-sm leading-5 text-muted-foreground"
          >
            {copied === "code" && "Kode disalin. Tempel dan kirim lewat WhatsApp."}
            {copied === "number" && "Nomor tujuan disalin"}
            {copyFailed && "Tidak bisa menyalin. Salin teks di atas secara manual."}
          </p>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" variant="outline" onClick={onHrHelp}>
          Minta bantuan HR atau supervisor
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
