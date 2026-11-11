// Small pieces shared by the WhatsApp-reset screens (bead ur82k; mockups
// design/mockups/payslip-pin-inbound): the left-ruled notice, the back link
// to the payslip list and the "PIN tetap pribadi" info text. Copy comes from
// the catalog (payslipWaReset.*).
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";

type Tone = "neutral" | "danger" | "success";

// The left stripe is reserved for danger and success; a neutral notice is a
// plain bordered panel.
const TONE_CLASS: Record<Tone, string> = {
  neutral: "border border-border bg-muted",
  danger: "border-l-4 border-danger bg-danger-subtle",
  success: "border-l-4 border-success bg-success-subtle",
};

/** Long button labels wrap instead of overflowing; keeps the large height as
 * a minimum. */
const WRAP_BUTTON_CLASS =
  "h-auto min-h-control-lg w-full py-2 whitespace-normal";

/** Left-ruled notice (danger/success) or plain panel; `alert` for danger,
 * `status` otherwise. */
function WaNotice({
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
      className={`grid gap-0.5 rounded-field p-4 ${TONE_CLASS[tone]}`}
    >
      <p className="text-base leading-6 md:text-sm md:leading-5 font-semibold">
        {title}
      </p>
      {children && (
        <p className="text-base leading-6 text-muted-foreground md:text-sm md:leading-5">
          {children}
        </p>
      )}
    </div>
  );
}

function WaBackLink() {
  const t = useT();
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
      <Link to="/karyawan/slip-gaji">
        <ChevronLeft aria-hidden="true" />
        {t("payslipWaReset.parts.backLink")}
      </Link>
    </Button>
  );
}

/** Info panel text shared by the choose, HR help and "no WhatsApp" screens. */
function WaPrivatePinSide() {
  const t = useT();
  return (
    <>
      <strong className="font-semibold text-foreground">
        {t("payslipWaReset.parts.privateTitle")}
      </strong>{" "}
      {t("payslipWaReset.parts.privateBody")}
    </>
  );
}

export { WRAP_BUTTON_CLASS, WaBackLink, WaNotice, WaPrivatePinSide };
