// "Lupa PIN?" choice screen (bead ur82k; mockup lupa-pin): reset by WhatsApp
// or read how to ask HR / a supervisor. Pure: the container starts the
// challenge and passes `pending` while the request runs.
import { MessageCircle } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { PinLayout } from "../pin-layout.tsx";
import {
  WRAP_BUTTON_CLASS,
  WaBackLink,
  WaNotice,
  WaPrivatePinSide,
} from "./parts.tsx";

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
  const t = useT();
  return (
    <PinLayout
      backLink={<WaBackLink />}
      title={t("payslipWaReset.choose.title")}
      description={t("payslipWaReset.choose.description")}
      side={<WaPrivatePinSide />}
      busy={pending}
    >
      {error && (
        <WaNotice tone="danger" title={t("payslipWaReset.choose.errorTitle")}>
          {t("payslipWaReset.choose.errorBody")}
        </WaNotice>
      )}
      <div className="grid gap-2">
        <Button
          type="button"
          size="lg"
          className={WRAP_BUTTON_CLASS}
          loading={pending}
          onClick={onChooseWhatsApp}
        >
          {!pending && <MessageCircle aria-hidden="true" />}
          {t("payslipWaReset.choose.whatsApp")}
        </Button>
        <p className="text-base leading-6 text-muted-foreground md:text-sm md:leading-5">
          {t("payslipWaReset.choose.whatsAppHint")}
        </p>
      </div>

      <section className="grid gap-2 border-t border-border pt-4">
        <h3 className="font-brand type-title">
          {t("payslipWaReset.common.hrHelpTitle")}
        </h3>
        <p className="text-base leading-6 text-muted-foreground md:text-sm md:leading-5">
          {t("payslipWaReset.choose.hrBody")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className={WRAP_BUTTON_CLASS}
          disabled={pending}
          onClick={onChooseHrHelp}
        >
          {t("payslipWaReset.common.hrHelpLink")}
        </Button>
      </section>
    </PinLayout>
  );
}

export { WaResetChoose };
export type { WaResetChooseProps };
