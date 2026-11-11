// "Minta bantuan HR atau supervisor" (bead ur82k; mockup bantuan-hr): a
// two-step guide for asking someone at the outlet. It sends nothing, names
// nobody and shows no contact details.
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { PinLayout } from "../pin-layout.tsx";
import { WRAP_BUTTON_CLASS, WaBackLink } from "./parts.tsx";

type WaResetHrHelpProps = {
  onBack: () => void;
};

const STEPS = [
  {
    title: "payslipWaReset.hrHelp.step1Title",
    body: "payslipWaReset.hrHelp.step1Body",
  },
  {
    title: "payslipWaReset.hrHelp.step2Title",
    body: "payslipWaReset.hrHelp.step2Body",
  },
] as const;

function WaResetHrHelp({ onBack }: WaResetHrHelpProps) {
  const t = useT();
  return (
    <PinLayout
      backLink={<WaBackLink />}
      title={t("payslipWaReset.common.hrHelpTitle")}
      description={t("payslipWaReset.hrHelp.description")}
      side={t("payslipWaReset.hrHelp.side")}
    >
      <ol className="grid gap-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground"
            >
              {index + 1}
            </span>
            <div className="grid gap-0.5">
              <p className="text-base font-bold">{t(step.title)}</p>
              <p className="text-base leading-6 text-muted-foreground md:text-sm md:leading-5">
                {t(step.body)}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <Button
        type="button"
        size="lg"
        className={WRAP_BUTTON_CLASS}
        onClick={onBack}
      >
        {t("payslipWaReset.common.backToSlip")}
      </Button>
    </PinLayout>
  );
}

export { WaResetHrHelp };
export type { WaResetHrHelpProps };
