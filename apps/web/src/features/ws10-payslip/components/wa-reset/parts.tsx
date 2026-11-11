// Small pieces shared by the WhatsApp-reset screens (bead ur82k; mockups
// design/mockups/payslip-pin-inbound): the left-ruled notice, the back link
// to the payslip list and the "PIN tetap pribadi" info text. Copy is
// Indonesian and lives in the components, as the shared catalog is not part
// of this slice.
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

type Tone = "neutral" | "danger" | "success";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border bg-muted",
  danger: "border-danger bg-danger-subtle",
  success: "border-success bg-success-subtle",
};

/** Left-ruled notice; `alert` for danger, `status` otherwise. */
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
      className={`grid gap-0.5 rounded-field border-l-4 p-4 ${TONE_CLASS[tone]}`}
    >
      <p className="text-sm leading-5 font-semibold">{title}</p>
      {children && (
        <p className="text-sm leading-5 text-muted-foreground">{children}</p>
      )}
    </div>
  );
}

function WaBackLink() {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
      <Link to="/karyawan/slip-gaji">
        <ChevronLeft aria-hidden="true" />
        Slip gaji
      </Link>
    </Button>
  );
}

/** Info panel text shared by the choose, HR help and "no WhatsApp" screens. */
const PRIVATE_PIN_SIDE = (
  <>
    <strong className="font-semibold text-foreground">PIN tetap pribadi</strong>{" "}
    - HR bisa mereset PIN, tetapi tidak bisa melihat atau menentukan PIN Anda.
  </>
);

export { PRIVATE_PIN_SIDE, WaBackLink, WaNotice };
