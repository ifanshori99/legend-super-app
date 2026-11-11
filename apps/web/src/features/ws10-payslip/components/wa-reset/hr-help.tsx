// "Minta bantuan HR atau supervisor" (bead ur82k; mockup bantuan-hr): a
// two-step guide for asking someone at the outlet. It sends nothing, names
// nobody and shows no contact details.
import { Button } from "@/components/ui/button";
import { PinLayout } from "../pin-layout.tsx";
import { WaBackLink } from "./parts.tsx";

type WaResetHrHelpProps = {
  onBack: () => void;
};

const STEPS = [
  {
    title: "Minta reset PIN",
    body: "Sampaikan bahwa Anda lupa PIN slip gaji.",
  },
  {
    title: "Buka slip gaji lagi",
    body: "Setelah HR meresetnya, buat PIN baru sendiri.",
  },
] as const;

function WaResetHrHelp({ onBack }: WaResetHrHelpProps) {
  return (
    <PinLayout
      backLink={<WaBackLink />}
      title="Minta bantuan HR atau supervisor"
      description="Hubungi HR atau supervisor di outlet dan minta reset PIN slip gaji."
      side="HR tidak bisa melihat atau menentukan PIN Anda."
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
              <p className="text-base font-bold">{step.title}</p>
              <p className="text-sm leading-5 text-muted-foreground">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <Button type="button" size="lg" className="w-full" onClick={onBack}>
        Kembali ke slip gaji
      </Button>
    </PinLayout>
  );
}

export { WaResetHrHelp };
export type { WaResetHrHelpProps };
