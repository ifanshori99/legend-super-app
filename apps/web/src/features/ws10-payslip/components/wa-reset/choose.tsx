// "Lupa PIN?" choice screen (bead ur82k; mockup lupa-pin): reset by WhatsApp
// or read how to ask HR / a supervisor. Pure: the container starts the
// challenge and passes `pending` while the request runs.
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PinLayout } from "../pin-layout.tsx";
import { PRIVATE_PIN_SIDE, WaBackLink, WaNotice } from "./parts.tsx";

type WaResetChooseProps = {
  onChooseWhatsApp: () => void;
  onChooseHrHelp: () => void;
  pending?: boolean;
  /** The start request failed (network or server): show an inline error. */
  error?: boolean;
};

function WaResetChoose({
  onChooseWhatsApp,
  onChooseHrHelp,
  pending = false,
  error = false,
}: WaResetChooseProps) {
  return (
    <PinLayout
      backLink={<WaBackLink />}
      title="Lupa PIN?"
      description="Pilih cara untuk membuat PIN baru."
      side={PRIVATE_PIN_SIDE}
      busy={pending}
    >
      {error && (
        <WaNotice tone="danger" title="Permintaan belum berhasil">
          Periksa koneksi, lalu coba lagi lewat WhatsApp atau minta bantuan HR
          atau supervisor.
        </WaNotice>
      )}
      <div className="grid gap-2">
        <Button
          type="button"
          size="lg"
          className="w-full"
          loading={pending}
          onClick={onChooseWhatsApp}
        >
          {!pending && <MessageCircle aria-hidden="true" />}
          Lewat WhatsApp
        </Button>
        <p className="text-sm leading-5 text-muted-foreground">
          Kirim pesan dari nomor yang terdaftar.
        </p>
      </div>

      <section className="grid gap-2 border-t border-border pt-4">
        <h3 className="font-brand type-title">
          Minta bantuan HR atau supervisor
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          Tidak bisa pakai nomor terdaftar? Minta reset PIN ke HR atau
          supervisor di outlet.
        </p>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          disabled={pending}
          onClick={onChooseHrHelp}
        >
          Lihat cara minta bantuan
        </Button>
      </section>
    </PinLayout>
  );
}

export { WaResetChoose };
export type { WaResetChooseProps };
